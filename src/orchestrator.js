// 编排器：事件驱动的"无状态运行"核心。
//
// 流程（对应需求）：
//   机器人空闲 → 用户发言 → 防抖聚批(wakeDelayMs) → 新开会话（一次独立的 agent 处理）
//   → 领取未读批次租约 → agent 用工具发言/决定不发言 → 成功后确认该批次
//   → 会话弃置（不留 LLM 历史）→ 发现 JSON 里有未读 → drainDelayMs 后再新开会话 → …
//   → 直到没有未读 → 回到空闲。
//
// 同一会话（群/私聊）同时最多一个运行；运行期间新消息只写 JSON（未读），不叠加触发。
// 不同会话之间并行，受 maxConcurrentRuns 全局限流。
import crypto from 'node:crypto';
import {
  conversationConfigForChat,
  getConfig,
  identityPilotEnabled,
  storeConfigForChat,
  updateConfig
} from './config.js';
import { canRun } from './access.js';
import { assertTimeAllowed, isTimeActive, TimeControlError, watchTimeWindow, withTimeScope } from './time-gate.js';
import { vendorOfConfig } from './model-prices.js';
import { sleep, randInt, createEventBus, todayKey } from './util.js';
import { buildSystemPrompt, buildUserPrompt, resolveContextTier } from './prompt.js';
import { chatCompletion, chatCompletionWithRetry, addUsage, isRetryableError } from './llm.js';
import { buildToolDefs, toOpenAiTools, executeTool } from './tools.js';
import { modelImageVerdict } from './vision-scan.js';
import { currentProviders } from './providers.js';

function handoffParticipantIds(triggerEntries) {
  return [...new Set((triggerEntries || [])
    .filter((m) => !m?.self && m?.senderId !== null && m?.senderId !== undefined)
    .map((m) => String(m.senderId).trim())
    .filter(Boolean))];
}

function continuationParticipantIds(session, triggerEntries, store, chatKey) {
  const ids = [];
  for (const item of session?.messages || []) {
    const call = item?.toolCall;
    if (!call || !['send_message', 'send_sticker', 'send_poke'].includes(call.name)) continue;
    const atUserId = String(call.args?.atUserId ?? call.args?.targetUserId ?? '').trim();
    if (atUserId) ids.push(atUserId);
    const replyId = call.args?.replyToMessageId;
    if (replyId !== undefined && replyId !== null && String(replyId).trim()) {
      const replied = store.findByMid?.(chatKey, replyId);
      if (replied?.senderId && !replied.self) ids.push(String(replied.senderId));
    }
  }
  if (!ids.length) {
    const last = [...(triggerEntries || [])].reverse()
      .find((m) => !m?.self && String(m?.senderId || '').trim());
    if (last) ids.push(String(last.senderId));
  }
  return [...new Set(ids)].slice(0, 8);
}

function lastSentText(session) {
  return (session?.sent || [])
    .map((entry) => String(entry?.text || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('；')
    .slice(0, 600);
}

function hasInlineImage(messages) {
  return (messages || []).some((message) => Array.isArray(message?.content)
    && message.content.some((part) => part?.type === 'image_url'
      && String(part?.image_url?.url || '').startsWith('data:')));
}

function imagePartCount(messages) {
  return (messages || []).reduce((total, message) => total + (
    Array.isArray(message?.content)
      ? message.content.filter((part) => part?.type === 'image_url').length
      : 0
  ), 0);
}

function modelMessagesForAudit(messages) {
  return structuredClone(messages || []).map((message) => {
    if (!Array.isArray(message?.content)) return message;
    message.content = message.content.map((part) => {
      const url = String(part?.image_url?.url || '');
      if (part?.type !== 'image_url' || !url.startsWith('data:')) return part;
      const mime = /^data:([^;,]+)/.exec(url)?.[1] || 'application/octet-stream';
      return {
        ...part,
        image_url: {
          ...part.image_url,
          url: `[inline ${mime} omitted from audit snapshot; ${url.length} chars]`
        }
      };
    });
    return message;
  });
}

export function estimateNextPromptTokens({
  messages,
  tools,
  previousPromptTokens = 0,
  previousEstimateChars = 0,
  previousImageCount = 0
}) {
  const auditMessages = modelMessagesForAudit(messages);
  const estimateChars = JSON.stringify({ messages: auditMessages, tools }).length;
  const imageCount = imagePartCount(messages);
  const textTokens = previousPromptTokens > 0 && previousEstimateChars > 0
    ? Math.ceil(estimateChars * previousPromptTokens / previousEstimateChars * 1.08)
    : Math.ceil(estimateChars * 0.55);
  // 图片的 base64 字节不是文本 Token。只为本轮新加入的图片预留视觉编码预算；
  // 已存在图片的成本已经包含在上一轮真实 prompt_tokens 比例里。
  const newImages = Math.max(0, imageCount - Math.max(0, Number(previousImageCount) || 0));
  return {
    estimatedPromptTokens: textTokens + newImages * 4096,
    estimateChars,
    imageCount,
    auditMessages
  };
}

export function randomWakeDelay(config = getConfig(), random = Math.random) {
  const legacy = Math.max(0, Number(config?.wakeDelayMs) || 0);
  let min = Number.isFinite(Number(config?.wakeDelayMinMs))
    ? Math.max(0, Number(config.wakeDelayMinMs))
    : legacy;
  let max = Number.isFinite(Number(config?.wakeDelayMaxMs))
    ? Math.max(0, Number(config.wakeDelayMaxMs))
    : legacy;
  if (min > max) [min, max] = [max, min];
  const ratio = Math.min(1, Math.max(0, Number(random()) || 0));
  return Math.round(min + (max - min) * ratio);
}

export class Orchestrator {
  constructor({
    store,
    memory,
    stickers,
    sender,
    sessions,
    onebot,
    emit = null,
    random = Math.random,
    getIdentityPilot = null
  }) {
    this.store = store;
    this.memory = memory;
    this.stickers = stickers;
    this.sender = sender;
    this.sessions = sessions;
    this.onebot = onebot;
    this.random = random;
    this.getIdentityPilot = typeof getIdentityPilot === 'function' ? getIdentityPilot : (() => null);
    this.emit = typeof emit === 'function' ? emit : ((b) => b.emit.bind(b))(createEventBus());
    this.toolDefs = buildToolDefs();

    this.chatNameCache = new Map();    // groupId -> name
    this.wakeTimers = new Map();       // chatKey -> timer
    this.pendingWake = new Set();      // 防抖中等待聚批的 chatKey
    this.pendingSessions = new Map();  // chatKey -> waiting sessionId（防抖期可见的“等待中”会话）
    this.firstPendingAt = new Map();
    this.controllers = new Map();
    this.runTasks = new Set();
    this.retryTimer = null;
    this.consolidating = new Set();    // 正在整理记忆的 chatKey
    this.runningChats = new Set();     // 正在运行的 chatKey
    this.activeRuns = new Map();       // chatKey -> sessionId
    this.runSeq = new Map();           // chatKey -> 第几次处理（跨重启清零即可）
    this.paused = getConfig().runtime?.paused === true;
    this.pauseReason = null;
    this.proactiveTimer = null;
    this.proactiveSuppressions = new Set();
    this.aborted = false;
  }

  setProactiveSuppressed(reason, suppressed) {
    const key = String(reason || 'background-task');
    if (suppressed) this.proactiveSuppressions.add(key);
    else this.proactiveSuppressions.delete(key);
  }

  enforceTimeControl() {
    if (getConfig().timeControl?.enabled !== true) return;
    for (const chatKey of this.store.listChats()) {
      if (isTimeActive(chatKey)) continue;
      clearTimeout(this.wakeTimers.get(chatKey));
      this.wakeTimers.delete(chatKey);
      this.pendingWake.delete(chatKey);
      this.firstPendingAt.delete(chatKey);
      const waiting = this.pendingSessions.get(chatKey);
      if (waiting) this.#discardWaiting(waiting);
      this.pendingSessions.delete(chatKey);
      this.controllers.get(chatKey)?.abort(new TimeControlError(chatKey));
      // Only pending inputs are retired; held/leased deliveries retain their audit state.
      if (this.store.markAllRead(chatKey)) this.emit('chat-update', chatKey);
    }
  }

  /**
   * 恢复后处理：所有当前有未读消息的会话都安排一次唤醒，把积压消息补处理掉。
   * 如果模型未配置，wake 会自然跳过（消息保留未读，不丢失）。
   */
  drainBacklogAfterResume() {
    for (const chatKey of this.store.listChats()) {
      if (this.store.unreadCount(chatKey) > 0) this.scheduleWake(chatKey, 0);
    }
  }

  startRecoveryLoop() {
    clearInterval(this.retryTimer);
    this.store.recoverExpired();
    this.store.expireConversationThreads?.();
    this.retryTimer = setInterval(() => {
      this.store.recoverExpired();
      this.store.expireConversationThreads?.();
      if (this.paused || this.aborted) return;
      for (const key of this.store.listChats()) {
        if (canRun(key) && !this.runningChats.has(key) && !this.pendingWake.has(key)
          && this.store.getChatMeta(key).held === 0 && this.store.unreadCount(key) > 0) this.scheduleWake(key);
      }
    }, 5000);
    this.retryTimer.unref?.();
  }

  // ── 入站接口 ───────────────────────────────────────────────────────────

  /** 收到新消息（已通过白名单校验并写入 store）。 */
  onIncoming(chatKey) {
    if (this.paused || this.aborted || !canRun(chatKey)) return;
    if (this.store.getChatMeta(chatKey).held > 0) return;
    if (this.runningChats.has(chatKey)) return;   // 运行结束后 drain 会接管
    this.scheduleWake(chatKey);
  }

  /** 防抖聚批：等待 wakeDelayMs，期间每来一条消息重置计时。 */
  /**
   * 对"当前这批未读"做档位预判：这批消息值不值得机器人响应？
   *
   * scheduleWake（建等待会话前）与 wake（真正运行前）共用这一个函数，
   * 避免两处各写一份判定、日后逻辑漂移。
   *
   * 注意：这里**不消费**未读（用 peekUnread 只看不取），
   * 所以防抖窗口期间每次来新消息都可以重新预判 ——
   * 先来一句闲聊（不命中、不显示），接着有人 @ 机器人（命中、立刻显示）。
   *
   * @returns {{shouldRespond:boolean, tier:number, count:number, reason:string}}
   */
  #predictTier(chatKey) {
    const cfg = getConfig();
    const conversation = conversationConfigForChat(chatKey);
    const entries = this.store.peekUnread(chatKey, 100) || [];
    if (chatKey.startsWith('private:')) {
      return {
        shouldRespond: entries.length > 0,
        tier: 4,
        count: getConfig().store.atCount,
        reason: '私聊',
        conversationMode: conversation.mode
      };
    }
    const result = resolveContextTier({
      triggerEntries: entries,
      selfNickname: cfg.persona?.selfNickname || this.onebot.selfNickname || '',
      botName: cfg.persona?.botName || '',
      selfId: cfg.onebot?.selfId || this.onebot.selfId || '',
      cfg: storeConfigForChat(chatKey)   // 按会话取档位：统一开关关闭时各群可以有独立滑条
    });
    // 没有未读就不算"需要响应"（防抖窗口刚建立时的空转）
    if (entries.length === 0) {
      return { ...result, shouldRespond: false, reason: '无未读', conversationMode: conversation.mode };
    }
    if (entries.some((entry) => Number(entry.attempts) > 0)) {
      return {
        tier: 8,
        count: Math.min(
          500,
          Math.max(1, Number(conversation.lifecycleContextCount) || result.count || 100)
        ),
        reason: '失败批次重试',
        shouldRespond: true,
        conversationMode: conversation.mode
      };
    }
    if (result.shouldRespond) return { ...result, conversationMode: conversation.mode };
    if (conversation.mode === 'lifecycle') {
      return this.#lifecycleTier(chatKey, entries, result, conversation);
    }
    if (conversation.mode === 'threaded') {
      return this.#continuationTier(chatKey, entries, result, conversation);
    }
    return { ...result, conversationMode: 'legacy' };
  }

  #isReplyToSelf(entries) {
    const cfg = getConfig();
    const selfId = String(cfg.onebot?.selfId || this.onebot.selfId || '');
    const names = new Set([
      cfg.persona?.selfNickname,
      this.onebot.selfNickname,
      cfg.persona?.botName
    ].map((v) => String(v || '').trim()).filter(Boolean));
    return entries.some((m) => {
      if (selfId && String(m.reply?.senderId || '') === selfId) return true;
      return names.has(String(m.reply?.sender || '').trim());
    });
  }

  #continuationTier(chatKey, entries, fallback, conversation) {
    const count = Math.min(500, Math.max(1, Number(conversation?.continuationContextCount) || 100));
    if (this.#isReplyToSelf(entries)) {
      return {
        tier: 5, count, reason: '续接：引用机器人',
        shouldRespond: true, conversationMode: 'threaded'
      };
    }

    const thread = this.store.getConversationThread?.(chatKey);
    if (!thread || thread.mode !== 'threaded' || thread.engagedUntil <= Date.now()) {
      return { ...fallback, conversationMode: 'threaded' };
    }
    const participants = new Set((thread.participantIds || []).map(String));
    const sameParticipant = entries.some((m) => participants.has(String(m.senderId || '')));
    if (!sameParticipant) return { ...fallback, conversationMode: 'threaded' };
    return {
      tier: 5,
      count,
      reason: '续接：参与者在活跃窗口内继续发言',
      shouldRespond: true,
      threadId: thread.threadId,
      conversationMode: 'threaded'
    };
  }

  #lifecycleTier(chatKey, entries, fallback, conversation) {
    const count = Math.min(500, Math.max(1, Number(conversation?.lifecycleContextCount) || 100));
    const thread = this.store.getConversationThread?.(chatKey);
    if (thread?.mode === 'lifecycle') {
      if (thread.state === 'rollover_armed') {
        return {
          tier: 7, count, reason: '生命周期：硬上限后的任意消息续接',
          shouldRespond: true, threadId: thread.threadId,
          conversationMode: 'lifecycle', lifecycleState: thread.state
        };
      }
      if (thread.state === 'active' || thread.state === 'listening') {
        return {
          tier: 6, count, reason: `生命周期：${thread.state === 'active' ? '活跃' : '监听'}状态`,
          shouldRespond: true, threadId: thread.threadId,
          conversationMode: 'lifecycle', lifecycleState: thread.state
        };
      }
    }
    if (this.#isReplyToSelf(entries)) {
      return {
        tier: 5, count, reason: '生命周期：引用机器人',
        shouldRespond: true, conversationMode: 'lifecycle'
      };
    }
    return { ...fallback, conversationMode: 'lifecycle' };
  }

  #applyWaitingConversation(session, predicted, chatKey) {
    if (!session) return;
    const mode = ['legacy', 'threaded', 'lifecycle'].includes(predicted?.conversationMode)
      ? predicted.conversationMode
      : conversationConfigForChat(chatKey).mode;
    const currentThread = mode !== 'legacy'
      ? this.store.getConversationThread?.(chatKey)
      : null;
    const thread = currentThread?.mode === mode ? currentThread : null;
    session.conversationMode = mode;
    session.threadId = predicted?.threadId || thread?.threadId || null;
    session.threadState = predicted?.lifecycleState || thread?.state || null;
    session.lifecycleContinuation = mode === 'lifecycle' && Boolean(session.threadId);
  }

  scheduleWake(chatKey, delay = null) {
    if (this.paused || this.aborted || !canRun(chatKey)) return;
    const now = Date.now();
    if (!this.firstPendingAt.has(chatKey)) this.firstPendingAt.set(chatKey, now);
    const hardLimit = Math.min(20000, Math.max(100, Number(getConfig().maxBatchWaitMs) || 20000));
    const desired = delay ?? randomWakeDelay(getConfig(), this.random);
    const ms = Math.max(0, Math.min(desired, this.firstPendingAt.get(chatKey) + hardLimit - now));
    if (this.pendingWake.has(chatKey)) clearTimeout(this.wakeTimers.get(chatKey));
    this.pendingWake.add(chatKey);

    // 等待窗口 > 0：在会话页立刻创建“等待中”会话，并随新消息重置倒计时
    //
    // ⚠️ 先预判再创建：档位非 4 时，若这批消息确定不会响应，
    //    就**不创建**"等待中"会话 —— 否则用户会在会话页看到一堆
    //    等半天最后变成"中止"的条目，既干扰又让人以为出了错。
    //    窗口结束前若来了新消息且命中，届时再创建（见下面 pendingSessions 分支）。
    if (ms > 0 && !this.runningChats.has(chatKey)) {
      const predicted = this.#predictTier(chatKey);
      if (predicted.shouldRespond === false) {
        // 不响应：把已存在的等待会话撤掉（例如刚被艾特、随后判定又不成立的情况）
        const stale = this.pendingSessions.get(chatKey);
        if (stale) {
          this.#discardWaiting(stale);   // 干净消失，不留"中止"
          this.pendingSessions.delete(chatKey);
        }
        this.emit('chat-update', chatKey);
        // 定时器仍然保留：窗口内可能来新消息，届时重新预判
      } else {
      const unread = this.store.peekUnread(chatKey, 3);
      const first = unread[0];
      const summary = first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '等待新消息聚批';
      const waitUntil = Date.now() + ms;
      const existing = this.pendingSessions.get(chatKey);
      if (existing) {
        const s = this.sessions.current.get(existing);
        if (s && s.status === 'waiting') {
          s.waitUntil = waitUntil;
          s.triggerSummary = summary;
          s.trigger = unread;
          s.triggerText = unread.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
          this.#applyWaitingConversation(s, predicted, chatKey);
          this.sessions.update(s.id);
          this.emit('session-update', s.id);
        } else {
          this.pendingSessions.delete(chatKey);
        }
      }
      if (!this.pendingSessions.has(chatKey)) {
        const session = this.sessions.create({
          chatKey,
          trigger: unread,
          triggerSummary: summary,
          status: 'waiting',
          waitUntil
        });
        this.#applyWaitingConversation(session, predicted, chatKey);
        this.sessions.update(session.id);
        this.pendingSessions.set(chatKey, session.id);
        this.emit('session-start', { sessionId: session.id, chatKey, status: 'waiting', triggerSummary: summary });
      }
      this.emit('chat-update', chatKey);
      }
    }

    const timer = setTimeout(() => {
      this.pendingWake.delete(chatKey);
      this.wakeTimers.delete(chatKey);
      this.firstPendingAt.delete(chatKey);
      const waitingId = this.pendingSessions.get(chatKey);
      this.pendingSessions.delete(chatKey);
      if (this.paused || this.aborted || this.runningChats.has(chatKey)) {
        if (waitingId) this.#finishWaiting(waitingId, 'aborted');
        return;
      }
      const task = this.wake(chatKey, { waitingSessionId: waitingId ?? null })
        .catch((error) => console.error(`[orchestrator] wake ${chatKey} 出错:`, error))
        .finally(() => this.runTasks.delete(task));
      this.runTasks.add(task);
    }, ms);
    this.wakeTimers.set(chatKey, timer);
  }

  /**
   * 丢弃一个"等待中"会话：让它从会话页**干净消失**，而不是变成"中止"。
   *
   * 用于档位判定"这次不响应"的场景 —— 用户看到的应该是"什么都没发生"，
   * 而不是一条等了半天最后标着"中止"的条目（那会让人以为机器人坏了）。
   * 只有真正运行过（消耗了 token）的会话才走 #finishWaiting 留痕。
   */
  #discardWaiting(sessionId) {
    if (!sessionId) return;
    const s = this.sessions.current.get(sessionId);
    this.sessions.discard(sessionId);
    this.emit('session-end', {
      sessionId,
      chatKey: s?.chatKey || '',
      status: 'discarded',
      discarded: true
    });
  }

  #finishWaiting(sessionId, status, error = '') {
    if (!sessionId) return;
    const s = this.sessions.current.get(sessionId);
    if (!s || s.status !== 'waiting') return;
    if (error) s.error = error;
    this.sessions.finish(sessionId, status);
    this.emit('session-end', { sessionId, chatKey: s.chatKey, status, error: s.error || null });
  }

  /** 兼容旧调用方的布尔接口。 */
  forceWake(chatKey) {
    return this.requestManualWake(chatKey).ok;
  }

  /** 手动触发一次处理，并返回供控制台展示的明确结果。 */
  requestManualWake(chatKey) {
    if (this.aborted) return { ok: false, reason: 'Agent 正在停止' };
    if (this.paused) return { ok: false, reason: 'Agent 已暂停' };
    if (!canRun(chatKey)) {
      return { ok: false, reason: '当前运行模式、白名单或时间控制不允许唤醒' };
    }
    if (this.store.getChatMeta(chatKey).held > 0) {
      return { ok: false, reason: '该会话存在发送结果待确认，请先处理后再唤醒' };
    }
    if (this.runningChats.has(chatKey)) {
      return { ok: false, reason: '该会话正在处理中' };
    }
    if (this.runningChats.size >= Math.max(1, Number(getConfig().maxConcurrentRuns) || 2)) {
      return { ok: false, reason: '当前并发已满，请稍后重试' };
    }
    if (!String(getConfig().api.model || '').trim()) {
      return { ok: false, reason: '模型未设置' };
    }

    // 如果自动防抖已经建了 waiting Session，手动唤醒应复用它并立刻开始，
    // 否则旧定时器稍后还会再跑一次，造成重复 Session。
    clearTimeout(this.wakeTimers.get(chatKey));
    this.wakeTimers.delete(chatKey);
    this.pendingWake.delete(chatKey);
    this.firstPendingAt.delete(chatKey);
    const waitingSessionId = this.pendingSessions.get(chatKey) || null;
    this.pendingSessions.delete(chatKey);
    const mode = this.store.unreadCount(chatKey) > 0 ? 'unread' : 'context';
    this.wake(chatKey, { manual: true, waitingSessionId }).catch((error) =>
      console.error(`[orchestrator] manual wake ${chatKey} 出错:`, error));
    return { ok: true, mode };
  }

  // ── 核心循环 ───────────────────────────────────────────────────────────

  wake(chatKey, options = {}) {
    const task = withTimeScope(chatKey, () => this.#wake(chatKey, options));
    this.runTasks.add(task);
    task.then(() => this.runTasks.delete(task), () => this.runTasks.delete(task));
    return task;
  }

  async #wake(chatKey, { proactive = false, manual = false, waitingSessionId = null } = {}) {
    if (!canRun(chatKey)) { if (waitingSessionId) this.#discardWaiting(waitingSessionId); return; }
    if (this.store.getChatMeta(chatKey).held > 0) {
      if (waitingSessionId) this.#discardWaiting(waitingSessionId);
      return;
    }
    if (this.aborted) { if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted'); return; }
    if (this.paused) { if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted'); return; }
    if (this.runningChats.has(chatKey)) return;

    // 模型未设置：不产生报错会话，消息保留为未读；设置模型后（下一条消息或手动唤醒）自动补处理
    if (!String(getConfig().api.model || '').trim()) {
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted', '模型未设置');
      return;
    }

    // 全局并发限制：满了就稍后重试
    if (this.runningChats.size >= Math.max(1, Number(getConfig().maxConcurrentRuns) || 2)) {
      if (waitingSessionId) this.#discardWaiting(waitingSessionId);
      this.scheduleWake(chatKey, 3000);
      return;
    }

    // 未命中时只确认本次判定的快照；运行批次在模型处理成功后确认。
    const cfgNow = getConfig();
    const conversation = conversationConfigForChat(chatKey);
    let pendingEntries = [];
    let tierResult = null;
    if (!proactive) {
      // peekUnread 只看不取，limit 给足以免漏判（判定用的是这批的文本）
      pendingEntries = this.store.peekUnread(chatKey, 100) || [];
      const predicted = this.#predictTier(chatKey);
      const manualContextCount = Math.min(500, Math.max(
        1,
        Number(conversation.mode === 'lifecycle'
          ? conversation.lifecycleContextCount
          : conversation.mode === 'threaded'
            ? conversation.continuationContextCount
            : storeConfigForChat(chatKey).allCount) || 100
      ));
      if (pendingEntries.length === 0) {
        if (!manual) {
          if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
          return; // 自动唤醒没有未读时不空跑
        }
        // 控制台主动唤醒即使没有未读，也应基于最近存档运行一次。
        proactive = true;
        tierResult = {
          ...predicted,
          tier: 4,
          count: manualContextCount,
          shouldRespond: true,
          reason: '控制台主动唤醒'
        };
      }

      // 复用 scheduleWake 那一份判定逻辑，避免两处各写一套、日后漂移
      const tierResult0 = predicted;
      tierResult ||= manual
        ? {
            ...tierResult0,
            tier: 4,
            count: manualContextCount,
            shouldRespond: true,
            reason: '控制台主动唤醒'
          }
        : tierResult0;

      if (!manual && tierResult0.shouldRespond === false) {
        // 不响应：沉入历史（已读），不产生会话、不消耗 token。
        // 防抖窗口内后续到达的消息同样是"未读"状态，会在下一次唤醒时
        // 被一起判定 —— 若期间有人艾特机器人，它们会作为已读上下文带上。
        const marked = this.store.markRead(chatKey, pendingEntries.map((m) => m.id));
        // 关键：让等待会话**干净消失**，而不是标成"中止"留在列表里
        if (waitingSessionId) this.#discardWaiting(waitingSessionId);
        this.emit('chat-update', chatKey);
        if (marked) {
          console.log(`[orchestrator] ${chatKey} ${marked} 条未命中触发条件（档位 ${tierResult0.tier}），已标记已读、不响应`);
        }
        if (this.store.unreadCount(chatKey) > 0) this.scheduleWake(chatKey);
        return;
      }
    }

    const runTimeoutMs = Math.min(240000, Math.max(1000, Number(cfgNow.api.runTimeoutMs) || 180000));
    const lease = proactive ? null : this.store.claimUnread(chatKey, {
      limit: cfgNow.store.batchLimit, maxChars: cfgNow.store.batchMaxChars, leaseMs: runTimeoutMs + 60000
    });
    const triggerEntries = lease?.messages || [];
    if (!proactive && triggerEntries.length === 0) {
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
      return; // 没有未读就不空跑
    }

    // ── 档位：响应时带多少条已读历史 ──
    // 在唤醒时算一次并固定下来（尤其是随机档的骰子结果），
    // 否则后续每次渲染提示词都会重新掷，会话记录与提示词会对不上。
    tierResult ||= resolveContextTier({
      triggerEntries,
      selfNickname: cfgNow.persona?.selfNickname || this.onebot.selfNickname || '',
      botName: cfgNow.persona?.botName || '',
      selfId: cfgNow.onebot?.selfId || this.onebot.selfId || '',
      cfg: storeConfigForChat(chatKey)   // 与 #predictTier 同一来源，保证预判/实跑一致
    });

    this.runningChats.add(chatKey);
    const seq = (this.runSeq.get(chatKey) || 0) + 1;
    this.runSeq.set(chatKey, seq);
    const [kind, chatId] = String(chatKey).split(':');

    // 触发摘要
    const first = triggerEntries[0];
    const triggerSummary = manual
      ? '控制台主动唤醒'
      : proactive
      ? '主动机会（冷场开话题）'
      : (first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '');

    // 把“等待中”会话原地转成运行中；没有等待会话（主动/手动唤醒）才新建
    let session = waitingSessionId ? this.sessions.get(waitingSessionId) : null;
    if (session && session.status === 'waiting') {
      this.sessions.current.get(waitingSessionId).status = 'running';
      this.sessions.current.get(waitingSessionId).waitUntil = null;
      this.sessions.current.get(waitingSessionId).trigger = triggerEntries;
      this.sessions.current.get(waitingSessionId).triggerSummary = triggerSummary;
      this.sessions.current.get(waitingSessionId).triggerText = triggerEntries.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
      this.sessions.update(waitingSessionId);
      this.emit('session-update', waitingSessionId);
      session = this.sessions.current.get(waitingSessionId);
    } else {
      session = this.sessions.create({ chatKey, trigger: triggerEntries, triggerSummary });
      this.emit('session-start', { sessionId: session.id, chatKey, triggerSummary });
    }
    this.activeRuns.set(chatKey, session.id);
    session.leaseId = lease?.id || session.id;
    const controller = new AbortController();
    this.controllers.set(chatKey, controller);
    const runTimer = setTimeout(() => controller.abort(new Error('Run deadline exceeded')), runTimeoutMs);
    const releaseTimeGuard = watchTimeWindow((error) => controller.abort(error), chatKey);
    this.emit('chat-update', chatKey);

    try {
      const runResult = await this.#runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq,
        manual, contextLimit: tierResult.count, tierInfo: tierResult, conversation, signal: controller.signal });
      controller.signal.throwIfAborted();
      // #region debug-point A:agent-run-result
      (() => { const body = JSON.stringify({ sessionId: process.env.DEBUG_SESSION_ID || 'lifecycle-instant-close', runId: process.env.DEBUG_RUN_ID || 'pre-fix', hypothesisId: 'A', location: 'src/orchestrator.js:#wake', msg: '[DEBUG] Agent run completed before lifecycle commit', data: { chatKey, sessionId: session.id, conversationMode: conversation.mode, sentCount: session.sent.length, threadDisposition: session.threadDisposition || null, finishReason: session.finishReason || '', clearHandoff: session.handoffDraft?.clearHandoff === true, triggerCount: triggerEntries.length }, ts: Date.now() }); const req = process.getBuiltinModule('node:http').request(process.env.DEBUG_SERVER_URL || 'http://192.168.31.10:7777/event', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => res.resume()); req.on('error', () => {}); req.end(body); })();
      // #endregion
      if (conversation.mode === 'lifecycle') {
        const handoff = this.#commitSessionHandoff(session, { chatKey, triggerEntries });
        this.#commitConversationThread(session, {
          chatKey, triggerEntries, handoff, conversation, runResult,
          leaseId: lease?.id || '', runId: session.leaseId
        });
      } else {
        if (lease) this.store.ackLease(lease.id);
        else this.store.completeRun(session.leaseId);
        const handoff = this.#commitSessionHandoff(session, { chatKey, triggerEntries });
        this.#commitConversationThread(session, {
          chatKey, triggerEntries, handoff, conversation, runResult
        });
      }
      const status = session.sent.length > 0 ? 'done' : 'noreply';
      this.sessions.finish(session.id, status);
      this.emit('session-end', { sessionId: session.id, chatKey, status,
        sent: session.sent.length, finishReason: session.finishReason, usage: session.usage });
    } catch (error) {
      session.error = String(error?.message ?? error);
      const timeClosed = error?.code === 'TIME_CONTROL_INACTIVE' || !isTimeActive(chatKey);
      // #region debug-point C-D:agent-run-failed
      if (chatKey === 'group:1044877051' && !process.env.NODE_TEST_CONTEXT) (() => { try { const body = JSON.stringify({ sessionId: 'group-context-overflow', runId: process.env.QQ_CONTEXT_DEBUG_RUN || 'post-fix', hypothesisId: 'C,D', location: 'src/orchestrator.js:#wake.catch', msg: '[DEBUG] Agent run failed', data: { sessionId: session.id, threadId: session.threadId || null, error: session.error.slice(0, 500), rounds: session.rounds, calls: session.usage.calls, cumulativeRunTokens: session.usage.totalTokens, promptTokens: session.usage.promptTokens, completionTokens: session.usage.completionTokens, sentCount: session.sent.length, hasEffects: lease ? this.store.hasEffects(lease.id) : false, hasUncertainEffects: lease ? this.store.hasUncertainEffects(lease.id) : false, triggerCount: triggerEntries.length }, ts: Date.now() }); const req = process.getBuiltinModule('node:http').request(process.env.QQ_CONTEXT_DEBUG_URL || 'http://192.168.31.10:7781/event', { method: 'POST', signal: AbortSignal.timeout(500), headers: { 'content-type': 'application/json' } }, (res) => res.resume()); req.on('error', () => {}); req.on('socket', (socket) => socket.unref()); req.end(body); } catch {} })();
      // #endregion
      if (lease) {
        if (timeClosed && !this.store.hasEffects(lease.id)) this.store.ackLease(lease.id);
        else this.store.failLease(lease.id, session.error, {
          retryable: !timeClosed && (isRetryableError(error) || controller.signal.aborted)
        });
      }
      const status = timeClosed ? 'aborted' : 'error';
      this.sessions.finish(session.id, status);
      this.emit('session-end', { sessionId: session.id, chatKey, status, error: session.error });
    } finally {
      releaseTimeGuard();
      clearTimeout(runTimer);
      this.controllers.delete(chatKey);
      this.activeRuns.delete(chatKey);
      this.runningChats.delete(chatKey);
      this.emit('chat-update', chatKey);
    }

    // drain：运行期间来的新消息 → 再次新开会话处理（这是"确保看到所有发言"的关键）
    if (!this.aborted && !this.paused) {
      const unread = this.store.unreadCount(chatKey);
      if (unread > 0) {
        const drainDelay = Math.max(200, Number(getConfig().drainDelayMs) || 1200);
        this.scheduleWake(chatKey, drainDelay);
      }
    }

    // 记忆自动整理（后台静默，绝不阻塞/影响聊天主流程）
    this.#maybeConsolidateMemory(chatKey);
  }

  #commitSessionHandoff(session, { chatKey, triggerEntries }) {
    const cfg = getConfig();
    if (cfg.memory?.handoffEnabled === false || typeof this.memory?.setHandoff !== 'function') return null;

    let draft = session.handoffDraft;
    if (!draft && session.sent.length > 0) {
      const previous = typeof this.memory.getHandoff === 'function'
        ? this.memory.getHandoff(chatKey)
        : null;
      const incoming = (triggerEntries || [])
        .slice(-4)
        .map((m) => `${m.senderName || m.senderId || '群友'}：${String(m.text || '').replace(/\s+/g, ' ').trim()}`)
        .filter((line) => !line.endsWith('：'))
        .join('；')
        .slice(0, 500);
      const reply = lastSentText(session);
      const turnSummary = [
        incoming ? `本轮收到：${incoming}` : '',
        reply ? `本轮回复：${reply}` : ''
      ].filter(Boolean).join('；');
      draft = {
        topic: previous?.topic || String(triggerEntries?.[0]?.text || reply).slice(0, 200),
        summary: [previous?.summary, turnSummary].filter(Boolean).join('；').slice(-1200)
      };
      session.handoffFallback = true;
    }
    if (!draft) return null;

    try {
      const handoff = this.memory.setHandoff(chatKey, draft, {
        sourceSessionId: session.id,
        participantIds: handoffParticipantIds(triggerEntries),
        lastReply: lastSentText(session)
      });
      session.handoffUpdated = draft.clearHandoff !== true && Boolean(handoff);
      session.handoffCleared = draft.clearHandoff === true;
      session.handoffUpdatedAt = handoff?.updatedAt || Date.now();
      this.emit('memory-update', {
        chatKey,
        phase: session.handoffCleared ? 'handoff-clear' : 'handoff-update'
      });
      return handoff;
    } catch (error) {
      session.handoffError = String(error?.message ?? error);
      console.warn(`[memory] ${chatKey} 保存会话交接失败:`, session.handoffError);
      return null;
    }
  }

  #commitConversationThread(session, {
    chatKey,
    triggerEntries,
    handoff,
    conversation,
    runResult = null,
    leaseId = '',
    runId = ''
  }) {
    const mode = conversation?.mode || 'legacy';
    const currentMode = conversationConfigForChat(chatKey).mode;
    // #region debug-point D:commit-mode-check
    (() => { const body = JSON.stringify({ sessionId: process.env.DEBUG_SESSION_ID || 'lifecycle-instant-close', runId: process.env.DEBUG_RUN_ID || 'pre-fix', hypothesisId: 'D', location: 'src/orchestrator.js:#commitConversationThread', msg: '[DEBUG] Conversation mode checked at commit', data: { chatKey, sessionId: session.id, capturedMode: mode, currentMode }, ts: Date.now() }); const req = process.getBuiltinModule('node:http').request(process.env.DEBUG_SERVER_URL || 'http://192.168.31.10:7777/event', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => res.resume()); req.on('error', () => {}); req.end(body); })();
    // #endregion
    if (currentMode !== mode) {
      if (mode === 'lifecycle') {
        this.store.commitLifecycleRun({
          chatKey, leaseId, runId, persistThread: false, closeReason: 'mode-changed'
        });
      } else {
        this.store.closeConversationThread?.(chatKey, 'mode-changed');
      }
      session.threadState = 'closed';
      return;
    }
    if (mode === 'legacy') return;
    const lastMessageId = Math.max(0, ...(triggerEntries || []).map((m) => Number(m.id) || 0));
    const lastHumanAt = Math.max(0, ...(triggerEntries || []).map((m) => Number(m.ts) || 0));
    const participantIds = mode === 'threaded'
      ? continuationParticipantIds(session, triggerEntries, this.store, chatKey)
      : handoffParticipantIds(triggerEntries);
    if (mode === 'lifecycle') {
      const hasOpenWork = Boolean(
        handoff?.nextStep
        || handoff?.openQuestions?.length
        || handoff?.hypotheses?.length
      );
      const disposition = session.threadDisposition
        || (session.sent.length > 0 || hasOpenWork ? 'active' : 'listening');
      const closeReason = session.threadDisposition === 'close'
        ? 'model-close'
        : '';
      const persistThread = triggerEntries.length > 0
        || session.sent.length > 0
        || Boolean(session.threadDisposition);
      // #region debug-point B:lifecycle-commit-decision
      (() => { const body = JSON.stringify({ sessionId: process.env.DEBUG_SESSION_ID || 'lifecycle-instant-close', runId: process.env.DEBUG_RUN_ID || 'pre-fix', hypothesisId: 'B', location: 'src/orchestrator.js:#commitConversationThread', msg: '[DEBUG] Lifecycle commit decision derived', data: { chatKey, sessionId: session.id, sentCount: session.sent.length, hasOpenWork, explicitDisposition: session.threadDisposition || null, disposition, clearHandoff: session.handoffDraft?.clearHandoff === true, closeReason, persistThread }, ts: Date.now() }); const req = process.getBuiltinModule('node:http').request(process.env.DEBUG_SERVER_URL || 'http://192.168.31.10:7777/event', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => res.resume()); req.on('error', () => {}); req.end(body); })();
      // #endregion
      const checkpointState = handoff || session.handoffDraft || {
        summary: session.sent.length
          ? `本轮已发送 ${session.sent.length} 条消息`
          : '本轮已读取消息并保持沉默',
        lastReply: lastSentText(session)
      };
      const result = this.store.commitLifecycleRun({
        chatKey,
        leaseId,
        runId,
        persistThread,
        closeReason,
        threadOptions: {
          disposition,
          participantIds,
          topic: handoff?.topic || session.handoffDraft?.topic || '',
          lastMessageId,
          lastHumanAt,
          lastAgentAt: session.sent.length ? Date.now() : 0,
          promptHash: session.promptPrefixHash || '',
          promptTokens: session.callUsage?.at(-1)?.promptTokens || 0,
          silentIdleMs: conversation?.silentIdleMs,
          activeIdleMs: conversation?.activeIdleMs,
          hardLifetimeMs: conversation?.hardLifetimeMs,
          rolloverArmedMs: conversation?.rolloverArmedMs,
          acceptedAt: session.startedAt
        },
        checkpointState,
        sourceMessageIds: (triggerEntries || []).map((m) => m.id),
        messages: runResult?.providerTranscriptDelta || [],
        maxTranscriptChars: conversation?.maxTranscriptChars,
        forceRollover: runResult?.forceThreadRollover || '',
        rolloverArmedMs: conversation?.rolloverArmedMs
      });
      session.threadId = result.thread?.threadId || session.threadId || null;
      session.threadState = result.thread?.state || (closeReason ? 'closed' : null);
      session.threadTranscriptChars = result.transcriptChars;
      // #region debug-point A-C-E:lifecycle-context-committed
      if (chatKey === 'group:1044877051' && !process.env.NODE_TEST_CONTEXT) (() => { try { const body = JSON.stringify({ sessionId: 'group-context-overflow', runId: process.env.QQ_CONTEXT_DEBUG_RUN || 'post-fix', hypothesisId: 'A,C,E', location: 'src/orchestrator.js:#commitConversationThread', msg: '[DEBUG] Lifecycle context committed', data: { sessionId: session.id, threadId: result.thread?.threadId || null, threadState: result.thread?.state || null, disposition: result.thread?.disposition || null, deltaMessageCount: runResult?.providerTranscriptDelta?.length || 0, deltaChars: JSON.stringify(runResult?.providerTranscriptDelta || []).length, transcriptChars: result.transcriptChars, maxTranscriptChars: Number(conversation?.maxTranscriptChars) || 0, promptTokensLastCall: session.callUsage?.at(-1)?.promptTokens || 0, cumulativeRunTokens: session.usage.totalTokens, forceRollover: runResult?.forceThreadRollover || '' }, ts: Date.now() }); const req = process.getBuiltinModule('node:http').request(process.env.QQ_CONTEXT_DEBUG_URL || 'http://192.168.31.10:7781/event', { method: 'POST', signal: AbortSignal.timeout(500), headers: { 'content-type': 'application/json' } }, (res) => res.resume()); req.on('error', () => {}); req.on('socket', (socket) => socket.unref()); req.end(body); } catch {} })();
      // #endregion
      // #region debug-point E:lifecycle-commit-result
      (() => { const body = JSON.stringify({ sessionId: process.env.DEBUG_SESSION_ID || 'lifecycle-instant-close', runId: process.env.DEBUG_RUN_ID || 'pre-fix', hypothesisId: 'E', location: 'src/orchestrator.js:#commitConversationThread', msg: '[DEBUG] Lifecycle transaction committed', data: { chatKey, sessionId: session.id, acknowledged: result.acknowledged, threadId: result.thread?.threadId || null, threadState: result.thread?.state || null, disposition: result.thread?.disposition || null, idleDeadline: result.thread?.idleDeadline || 0, hardDeadline: result.thread?.hardDeadline || 0, resumeArmedUntil: result.thread?.resumeArmedUntil || 0, transcriptChars: result.transcriptChars }, ts: Date.now() }); const req = process.getBuiltinModule('node:http').request(process.env.DEBUG_SERVER_URL || 'http://192.168.31.10:7777/event', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => res.resume()); req.on('error', () => {}); req.end(body); })();
      // #endregion
      return;
    }

    if (session.handoffDraft?.clearHandoff === true) {
      this.store.closeConversationThread?.(chatKey, 'handoff-cleared');
      return;
    }
    try {
      if (mode === 'threaded') {
        if (!session.sent.length || typeof this.store.upsertConversationThread !== 'function') return;
        const thread = this.store.upsertConversationThread(chatKey, {
          participantIds,
          topic: handoff?.topic || session.handoffDraft?.topic || '',
          lastMessageId,
          lastHumanAt,
          lastAgentAt: Date.now(),
          continuationWindowMs: conversation?.continuationWindowMs,
          ttlMs: conversation?.threadTtlMs
        });
        session.threadId = thread.threadId;
        session.threadState = thread.state;
        this.store.appendThreadCheckpoint(
          chatKey,
          thread.threadId,
          session.id,
          handoff || session.handoffDraft || {
            summary: `本轮已发送 ${session.sent.length} 条消息`,
            lastReply: lastSentText(session)
          },
          (triggerEntries || []).map((m) => m.id)
        );
      }
    } catch (error) {
      session.threadError = String(error?.message ?? error);
      console.warn(`[thread] ${chatKey} 保存线程状态失败:`, session.threadError);
    }
  }

  async #runAgent(session, {
    kind,
    chatId,
    chatKey,
    triggerEntries,
    proactive,
    manual = false,
    seq,
    contextLimit = null,
    tierInfo = null,
    conversation = null,
    signal
  }) {
    const cfg = getConfig();
    const conversationCfg = conversation || conversationConfigForChat(chatKey);
    const chatName = kind === 'group' ? await this.#chatName(chatId) : '';
    const selfNickname = kind === 'group' ? (cfg.persona.selfNickname || this.onebot.selfNickname || cfg.persona.botName) : cfg.persona.botName;
    let thread = conversationCfg.mode !== 'legacy'
      ? this.store.getConversationThread?.(chatKey)
      : null;
    if (thread && thread.mode !== conversationCfg.mode) thread = null;

    // 上下文统计
    const tenMinAgo = Date.now() - 600000;
    const recentCount = this.store.recent(chatKey, { limit: 200 }).filter((m) => m.ts >= tenMinAgo).length;
    const myMessages = this.store.recent(chatKey, { limit: 100 }).filter((m) => m.self);
    const selfLastMessageAt = myMessages.length ? myMessages[myMessages.length - 1].ts : 0;
    const lastMessageAt = (() => {
      const all = this.store.recent(chatKey, { limit: 10 });
      return all.length ? all[all.length - 1].ts : Date.now();
    })();

    // 表情库快照（提示词用）
    let stickerEntries = [];
    if (cfg.sticker?.enabled !== false) {
      try { stickerEntries = (await this.stickers.sync(false)).entries ?? []; } catch { stickerEntries = []; }
    }

    // 工具集按配置过滤：工具列表属于缓存前缀，必须先固定后再决定是否复用生命周期 transcript。
    const visionEnabled = cfg.api.vision !== false
      && modelImageVerdict(cfg.api.provider, cfg.api.model) !== 'no-vision';
    const searchEnabled = cfg.webSearch?.enabled !== false;
    const identityPilot = this.getIdentityPilot();
    const identityAvailable = identityPilotEnabled(cfg) && identityPilot?.active === true;
    const toolDefs = this.toolDefs.filter((d) => {
      if (!visionEnabled && (d.name === 'get_message_images' || d.name === 'get_sticker_image')) return false;
      if (!searchEnabled && (d.name === 'web_search' || d.name === 'web_fetch')) return false;
      if (d.feature === 'identityPilot' && !identityAvailable) return false;
      return true;
    });
    const openAiTools = toOpenAiTools(toolDefs);
    const systemPrompt = buildSystemPrompt({ identityPilotAvailable: identityAvailable });
    const promptPrefixHash = crypto.createHash('sha256')
      .update(String(cfg.api.provider || ''))
      .update('\0')
      .update(String(cfg.api.baseUrl || ''))
      .update('\0')
      .update(String(cfg.api.model || ''))
      .update('\0')
      .update(systemPrompt)
      .update('\0')
      .update(JSON.stringify(openAiTools))
      .digest('hex');

    let priorProviderMessages = [];
    if (conversationCfg.mode === 'lifecycle' && thread?.mode === 'lifecycle'
      && ['active', 'listening'].includes(thread.state)) {
      if (thread.promptHash && thread.promptHash !== promptPrefixHash) {
        this.store.closeConversationThread?.(chatKey, 'prompt-prefix-changed');
        thread = null;
      } else if (thread.promptTokens >= Math.min(
        500000,
        Math.max(5000, Number(conversationCfg.lifecycleRolloverInputTokens) || 32000)
      )) {
        const previousThreadId = thread.threadId;
        const previousPromptTokens = thread.promptTokens;
        // #region debug-point C-E:token-rollover
        if (chatKey === 'group:1044877051' && !process.env.NODE_TEST_CONTEXT) (() => { try { const body = JSON.stringify({ sessionId: 'group-context-overflow', runId: process.env.QQ_CONTEXT_DEBUG_RUN || 'post-fix', hypothesisId: 'C,E', location: 'src/orchestrator.js:#runAgent', msg: '[DEBUG] Lifecycle generation rolled before model request', data: { sessionId: session.id, previousThreadId, previousPromptTokens, threshold: Number(conversationCfg.lifecycleRolloverInputTokens) || 32000, storedTranscriptChars: thread.transcriptChars || 0 }, ts: Date.now() }); const req = process.getBuiltinModule('node:http').request(process.env.QQ_CONTEXT_DEBUG_URL || 'http://192.168.31.10:7781/event', { method: 'POST', signal: AbortSignal.timeout(500), headers: { 'content-type': 'application/json' } }, (res) => res.resume()); req.on('error', () => {}); req.on('socket', (socket) => socket.unref()); req.end(body); } catch {} })();
        // #endregion
        this.store.armLifecycleRollover?.(
          chatKey,
          'input-token-budget',
          conversationCfg.rolloverArmedMs
        );
        thread = this.store.getConversationThread?.(chatKey);
        session.contextRollover = {
          reason: 'input-token-budget',
          previousThreadId,
          promptTokens: previousPromptTokens,
          threshold: Number(conversationCfg.lifecycleRolloverInputTokens) || 32000
        };
      } else {
        priorProviderMessages = this.store.getThreadTurns?.(thread.threadId) || [];
      }
    }
    const threadCheckpoint = conversationCfg.mode === 'lifecycle' && thread
      ? this.store.latestThreadCheckpoint?.(chatKey)
      : null;
    const lifecycleContinuation = priorProviderMessages.length > 0;
    // #region debug-point A-B-E:lifecycle-context-loaded
    if (chatKey === 'group:1044877051' && !process.env.NODE_TEST_CONTEXT) (() => { try { const priorChars = JSON.stringify(priorProviderMessages).length; const body = JSON.stringify({ sessionId: 'group-context-overflow', runId: process.env.QQ_CONTEXT_DEBUG_RUN || 'post-fix', hypothesisId: 'A,B,E', location: 'src/orchestrator.js:#runAgent', msg: '[DEBUG] Lifecycle context loaded', data: { sessionId: session.id, threadId: thread?.threadId || null, threadState: thread?.state || null, threadOpenedAt: thread?.openedAt || 0, threadAgeMs: thread?.openedAt ? Date.now() - thread.openedAt : 0, storedTranscriptChars: thread?.transcriptChars || 0, priorMessageCount: priorProviderMessages.length, priorChars, lifecycleContinuation, contextLimit, maxTranscriptChars: Number(conversationCfg.maxTranscriptChars) || 0, hardLifetimeMs: Number(conversationCfg.hardLifetimeMs) || 0 }, ts: Date.now() }); const req = process.getBuiltinModule('node:http').request(process.env.QQ_CONTEXT_DEBUG_URL || 'http://192.168.31.10:7781/event', { method: 'POST', signal: AbortSignal.timeout(500), headers: { 'content-type': 'application/json' } }, (res) => res.resume()); req.on('error', () => {}); req.on('socket', (socket) => socket.unref()); req.end(body); } catch {} })();
    // #endregion

    // 首轮带完整上下文；生命周期后续轮只附加增量，旧消息保持字节级稳定以命中 DeepSeek 前缀缓存。
    const userPrompt = buildUserPrompt({
      chatKey, kind, chatId, chatName,
      triggerEntries,
      store: this.store,
      memory: this.memory,
      stickerEntries,
      selfNickname,
      selfLastMessageAt,
      lastMessageAt,
      recentCount,
      runSeq: seq,
      moreUnreadDuringRun: this.store.unreadCount(chatKey) > 0,
      proactive,
      manual,
      contextLimit,
      tierInfo,
      thread,
      threadCheckpoint,
      conversationMode: conversationCfg.mode,
      lifecycleContinuation,
      session
    });

    session.systemPrompt = systemPrompt;
    session.userPrompt = userPrompt;
    session.promptChars = systemPrompt.length + userPrompt.length
      + JSON.stringify(priorProviderMessages).length;
    session.model = cfg.api.model;
    session.conversationMode = conversationCfg.mode;
    session.lifecycleContinuation = lifecycleContinuation;
    session.threadId = thread?.threadId || null;
    // 记录本次调用走的是哪个渠道（A6API / openrouter / 本地中转…）。
    // 同名模型在不同渠道是不同商品，用量与价格要分开统计。
    session.vendor = vendorOfConfig(cfg);
    session.chatName = chatName;
    // 记录本次读了多长的上下文（排查提示词长度时很有用）
    if (tierInfo) {
      session.contextTier = tierInfo.tier;
      session.contextLimit = tierInfo.count;
      session.contextReason = tierInfo.reason || '';
    }
    this.sessions.update(session.id);
    this.emit('session-update', session.id);

    const currentUserMessage = {
      role: 'user',
      content: proactive && !manual
        ? `${userPrompt}\n\n【本次唤醒】（主动机会）群里已经安静了一会儿。你可以主动抛一个自然的话题（像随口说的，不要像播报），也可以判断没必要说话就安静结束。`
        : userPrompt
    };
    const messages = [
      { role: 'system', content: systemPrompt },
      ...structuredClone(priorProviderMessages),
      currentUserMessage
    ];
    const transcriptStart = 1 + priorProviderMessages.length;
    session.injectedMessages = modelMessagesForAudit(priorProviderMessages);
    session.injectedMessageChars = JSON.stringify(priorProviderMessages).length;
    session.inputTools = structuredClone(openAiTools);
    session.inputRequestOptions = {
      toolChoice: 'auto',
      temperature: cfg.api.temperature ?? 0.8
    };

    session.promptLayout = lifecycleContinuation
      ? 'deepseek-lifecycle-append-v1'
      : 'stable-prefix-v2';
    session.promptPrefixHash = promptPrefixHash;

    const ctx = {
      chatKey, kind, chatId,
      selfId: this.onebot.selfId,
      selfNickname,
      botName: cfg.persona.botName,
      onebot: this.onebot,
      store: this.store,
      memory: this.memory,
      identityPilot,
      stickers: this.stickers,
      sender: this.sender,
      session,
      signal,
      emit: (type, payload) => this.emit(type, payload)
    };

    const maxRounds = Math.max(1, Number(cfg.api.maxRounds) || 12);
    let finish = false;
    let completed = false;
    let webSearchCount = 0;
    session.activity = '';
    session.webSearchCount = 0;
    const markActivity = (activity) => {
      session.activity = String(activity ?? '');
      this.sessions.update(session.id);
      this.emit('session-update', session.id);
    };
    for (let round = 0; round < maxRounds && !finish; round++) {
      signal.throwIfAborted();
      if (this.aborted || !canRun(chatKey)) throw new Error('Run cancelled');
      const maxRunTokens = Math.min(
        1000000,
        Math.max(20000, Number(cfg.api.maxRunTokens) || 160000)
      );
      const requestPayloadChars = JSON.stringify({
        messages,
        tools: openAiTools
      }).length;
      const previousCall = session.callUsage?.at(-1);
      const estimate = estimateNextPromptTokens({
        messages,
        tools: openAiTools,
        previousPromptTokens: Number(previousCall?.promptTokens) || 0,
        previousEstimateChars: Number(session.inputEstimateChars) || 0,
        previousImageCount: Number(session.inputImageCount) || 0
      });
      const {
        estimatedPromptTokens,
        estimateChars: requestEstimateChars,
        imageCount: requestImageCount,
        auditMessages: requestAuditMessages
      } = estimate;
      const outputReserveTokens = 2048;
      // #region debug-point A-C-D:request-budget-check
      if (chatKey === 'group:1044877051' && !process.env.NODE_TEST_CONTEXT) (() => { try { const stats = {}; for (const message of messages) { const role = String(message?.role || 'unknown'); const row = stats[role] ||= { count: 0, jsonChars: 0, contentChars: 0, reasoningChars: 0, toolArgChars: 0 }; row.count += 1; row.jsonChars += JSON.stringify(message).length; row.contentChars += typeof message?.content === 'string' ? message.content.length : JSON.stringify(message?.content ?? '').length; row.reasoningChars += String(message?.reasoning_content || '').length; row.toolArgChars += (message?.tool_calls || []).reduce((sum, call) => sum + String(call?.function?.arguments || '').length, 0); } const body = JSON.stringify({ sessionId: 'group-context-overflow', runId: process.env.QQ_CONTEXT_DEBUG_RUN || 'post-fix', hypothesisId: 'A,C,D', location: 'src/orchestrator.js:#runAgent.round', msg: '[DEBUG] Request budget evaluated', data: { sessionId: session.id, threadId: thread?.threadId || null, round: round + 1, maxRounds, messageCount: messages.length, messageChars: JSON.stringify(messages).length, toolSchemaChars: JSON.stringify(openAiTools).length, cumulativeRunTokens: Number(session.usage.totalTokens) || 0, maxRunTokens, estimatedPromptTokens, outputReserveTokens, projectedRunTokens: Number(session.usage.totalTokens) + estimatedPromptTokens + outputReserveTokens, roles: stats }, ts: Date.now() }); const req = process.getBuiltinModule('node:http').request(process.env.QQ_CONTEXT_DEBUG_URL || 'http://192.168.31.10:7781/event', { method: 'POST', signal: AbortSignal.timeout(500), headers: { 'content-type': 'application/json' } }, (res) => res.resume()); req.on('error', () => {}); req.on('socket', (socket) => socket.unref()); req.end(body); } catch {} })();
      // #endregion
      if (session.usage.totalTokens + estimatedPromptTokens + outputReserveTokens > maxRunTokens) {
        // #region debug-point C:run-budget-rejected
        if (chatKey === 'group:1044877051' && !process.env.NODE_TEST_CONTEXT) (() => { try { const body = JSON.stringify({ sessionId: 'group-context-overflow', runId: process.env.QQ_CONTEXT_DEBUG_RUN || 'post-fix', hypothesisId: 'C', location: 'src/orchestrator.js:#runAgent.round', msg: '[DEBUG] Run stopped before exceeding token budget', data: { sessionId: session.id, threadId: thread?.threadId || null, nextRound: round + 1, cumulativeRunTokens: Number(session.usage.totalTokens) || 0, estimatedPromptTokens, outputReserveTokens, projectedRunTokens: Number(session.usage.totalTokens) + estimatedPromptTokens + outputReserveTokens, maxRunTokens, sentCount: session.sent.length }, ts: Date.now() }); const req = process.getBuiltinModule('node:http').request(process.env.QQ_CONTEXT_DEBUG_URL || 'http://192.168.31.10:7781/event', { method: 'POST', signal: AbortSignal.timeout(500), headers: { 'content-type': 'application/json' } }, (res) => res.resume()); req.on('error', () => {}); req.on('socket', (socket) => socket.unref()); req.end(body); } catch {} })();
        // #endregion
        session.budgetStopped = true;
        session.budgetStopReason = 'next-call-budget';
        session.estimatedNextPromptTokens = estimatedPromptTokens;
        session.finishReason ||= session.sent.length
          ? '已发送内容，因本轮 Token 预算不足安全结束'
          : '本轮 Token 预算不足，已安全结束';
        completed = true;
        break;
      }
      session.inputRound = round + 1;
      session.inputPayloadChars = requestPayloadChars;
      session.inputEstimateChars = requestEstimateChars;
      session.inputImageCount = requestImageCount;
      session.tokenEstimator = 'audit-chars-plus-image-reserve-v2';
      session.inputHasOmittedImages = hasInlineImage(messages);
      session.inputMessages = requestAuditMessages;
      markActivity('正在思考…');
      // 网络抖动/5xx/429 会自动重试（同一轮请求，messages 不变，幂等不重复发言）
      const response = await chatCompletionWithRetry({
        messages,
        tools: openAiTools,
        signal,
        cacheKey: `qq-agent:${promptPrefixHash.slice(0, 32)}`
      });
      signal.throwIfAborted();
      session.model = response.model || session.model;
      addUsage(session.usage, response.usage);
      session.usage.calls += 1;
      const promptTokens = Number(response.usage?.prompt_tokens) || 0;
      const cachedTokens = Number(
        response.usage?.prompt_tokens_details?.cached_tokens
        ?? response.usage?.prompt_cache_hit_tokens
        ?? response.usage?.cached_tokens
      ) || 0;
      session.callUsage ||= [];
      session.callUsage.push({
        round: round + 1,
        promptTokens,
        cachedTokens: Math.min(promptTokens, cachedTokens),
        cacheHitRate: promptTokens ? Math.min(1, cachedTokens / promptTokens) : 0,
        completionTokens: Number(response.usage?.completion_tokens) || 0,
        totalTokens: Number(response.usage?.total_tokens) || 0
      });
      // #region debug-point C-D:provider-usage-returned
      if (chatKey === 'group:1044877051' && !process.env.NODE_TEST_CONTEXT) (() => { try { const body = JSON.stringify({ sessionId: 'group-context-overflow', runId: process.env.QQ_CONTEXT_DEBUG_RUN || 'post-fix', hypothesisId: 'C,D', location: 'src/orchestrator.js:#runAgent.response', msg: '[DEBUG] Provider usage returned', data: { sessionId: session.id, threadId: thread?.threadId || null, round: round + 1, promptTokens, completionTokens: Number(response.usage?.completion_tokens) || 0, totalTokens: Number(response.usage?.total_tokens) || 0, cachedTokens: Math.min(promptTokens, cachedTokens), cumulativeRunTokens: Number(session.usage.totalTokens) || 0, finishReason: response.finishReason || null, assistantContentChars: typeof response.message?.content === 'string' ? response.message.content.length : 0, reasoningChars: String(response.message?.reasoning_content || '').length, toolNames: (response.message?.tool_calls || []).map((call) => call?.function?.name || '') }, ts: Date.now() }); const req = process.getBuiltinModule('node:http').request(process.env.QQ_CONTEXT_DEBUG_URL || 'http://192.168.31.10:7781/event', { method: 'POST', signal: AbortSignal.timeout(500), headers: { 'content-type': 'application/json' } }, (res) => res.resume()); req.on('error', () => {}); req.on('socket', (socket) => socket.unref()); req.end(body); } catch {} })();
      // #endregion

      const msg = response.message;
      const finalContent = typeof msg.content === 'string' ? msg.content : (msg.content ?? null);
      const reasoningContent = typeof msg.reasoning_content === 'string'
        ? msg.reasoning_content
        : null;
      const finalToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : undefined;
      const providerAssistant = {
        role: 'assistant',
        content: finalContent,
        ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
        ...(finalToolCalls ? { tool_calls: finalToolCalls } : {})
      };
      const assistantEntry = {
        ...providerAssistant,
        raw: response.raw ?? null
      };
      messages.push(providerAssistant);
      session.messages.push(structuredClone(assistantEntry));
      session.rounds = round + 1;
      markActivity('');

      let toolCalls = msg.tool_calls ?? [];
      // 兼容：少数模型把工具调用写成文本而不是原生 tool_calls。解析成功后需要把
      // 该 assistant 消息改成 tool_calls 形态回填 messages，并追加真正的 tool 结果。
      const rawContent = typeof msg.content === 'string' ? msg.content : '';
      let inlineCalls = [];
      if (!toolCalls.length && rawContent) {
        inlineCalls = parseInlineToolCalls(rawContent);
      }
      if (inlineCalls.length) {
        toolCalls = inlineCalls.map((c, i) => ({
          id: `inline_${round}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
        }));
        // 替换最后一条 assistant 消息：文本清空、附加 tool_calls，避免后续请求报错
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant') {
          last.content = null;
          last.tool_calls = toolCalls;
        }
        const live2 = this.sessions.current.get(session.id);
        const uiLast = live2?.messages?.[live2.messages.length - 1];
        if (uiLast?.role === 'assistant') {
          uiLast.content = null;
          uiLast.tool_calls = structuredClone(toolCalls);
          uiLast.inlineParsed = true;
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
      }
      if (!toolCalls.length) {
        // 没有工具调用 = 模型结束思考（文本不会发给 QQ）
        completed = true;
        break;
      }

      const toolResults = [];
      const imageUserMessages = [];
      // 流式响应结束后，把 assistant 条目的 tool_calls 也同步到会话消息流（一次）
      const liveTool = this.sessions.current.get(session.id);
      const lastAssistantUi = liveTool?.messages?.[liveTool.messages.length - 1];
      if (lastAssistantUi?.role === 'assistant' && Array.isArray(toolCalls) && toolCalls.length) {
        if (!lastAssistantUi.tool_calls) lastAssistantUi.tool_calls = structuredClone(toolCalls);
      }
      for (const call of toolCalls) {
        signal.throwIfAborted();
        if (!canRun(chatKey)) throw new Error('Run cancelled');
        const name = call?.function?.name ?? '';
        const argsRaw = call?.function?.arguments ?? '{}';
        if (name === 'web_search' || name === 'web_fetch') webSearchCount += 1;
        session.webSearchCount = webSearchCount;
        markActivity(`正在调用 ${name}…`);
        const result = await executeTool(toolDefs, ctx, name, argsRaw);
        // 工具结果：文本走 tool 消息；图片（parts 数组）不能塞进 tool 消息——
        // 很多 OpenAI 兼容端点不接受。做法：tool 消息只带文本，图片随后以 user 消息补发
        // （[{type:'text'},{type:'image_url'}]），这是兼容面最广的视觉输入方式。
        let contentStr = '';
        let images = [];
        if (Array.isArray(result.content)) {
          contentStr = result.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          images = result.content.filter((p) => p.type === 'image_url');
        } else {
          contentStr = String(result.content);
        }
        toolResults.push({ role: 'tool', tool_call_id: call.id, name, content: contentStr, isError: !!result.isError });
        session.messages.push({ toolCall: { name, args: safeParse(argsRaw), result: contentStr.slice(0, 2000), isError: !!result.isError } });
        if (images.length) {
          imageUserMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: `[系统：以下是工具 ${name} 返回的 ${images.length} 张图片，请直接"看图"回应]` },
              ...images
            ]
          });
          session.messages.push({ toolImages: { tool: name, count: images.length } });
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
        if (this.store.hasUncertainEffects(session.leaseId)) {
          throw new Error('Delivery uncertain; batch held for operator review');
        }
        if (name === 'finish' && !result.isError) finish = true;
      }
      messages.push(...toolResults.map(({ role, tool_call_id, name, content }) => ({ role, tool_call_id, content, name })));
      // 图片消息跟随在全部 tool 结果之后（OpenAI 校验要求每个 tool_call 都有对应 tool 消息）
      messages.push(...imageUserMessages);
      // 给 UI 的简化消息流（跳过纯 tool 结果的重复展示）
    }

    signal.throwIfAborted();
    if (!finish && !completed) throw new Error('Run round budget exceeded');
    const providerTranscriptDelta = conversationCfg.mode === 'lifecycle'
      ? structuredClone(messages.slice(transcriptStart))
      : [];
    // 普通 assistant 文本不会发到 QQ，它只是本次运行的内部输出。下一生命周期轮次
    // 不应把它伪装成机器人曾经说过的话；移除后仍能完整命中上一请求的输入边界。
    const tail = providerTranscriptDelta.at(-1);
    const terminalReasoning = tail?.role === 'assistant' && !tail.tool_calls?.length
      ? tail.reasoning_content
      : '';
    if (tail?.role === 'assistant' && !tail.tool_calls?.length) providerTranscriptDelta.pop();
    providerTranscriptDelta.push({
      role: 'assistant',
      content: session.sent.length
        ? lastSentText(session)
        : '（本轮未向 QQ 发送消息）',
      ...(terminalReasoning ? { reasoning_content: terminalReasoning } : {})
    });
    const containsInlineImage = hasInlineImage(providerTranscriptDelta);
    // #region debug-point A-D:lifecycle-delta-ready
    if (chatKey === 'group:1044877051' && !process.env.NODE_TEST_CONTEXT) (() => { try { const body = JSON.stringify({ sessionId: 'group-context-overflow', runId: process.env.QQ_CONTEXT_DEBUG_RUN || 'post-fix', hypothesisId: 'A,D', location: 'src/orchestrator.js:#runAgent.return', msg: '[DEBUG] Lifecycle transcript delta ready', data: { sessionId: session.id, threadId: thread?.threadId || null, messageCount: providerTranscriptDelta.length, deltaChars: JSON.stringify(providerTranscriptDelta).length, containsInlineImage, sentCount: session.sent.length, rounds: session.rounds }, ts: Date.now() }); const req = process.getBuiltinModule('node:http').request(process.env.QQ_CONTEXT_DEBUG_URL || 'http://192.168.31.10:7781/event', { method: 'POST', signal: AbortSignal.timeout(500), headers: { 'content-type': 'application/json' } }, (res) => res.resume()); req.on('error', () => {}); req.on('socket', (socket) => socket.unref()); req.end(body); } catch {} })();
    // #endregion
    return {
      providerTranscriptDelta: containsInlineImage ? [] : providerTranscriptDelta,
      forceThreadRollover: containsInlineImage ? 'multimodal-context' : ''
    };
  }

  /**
   * 取群名（公开版）。复用 #chatName 的缓存，供 HTTP 接口给 UI 显示用。
   * 与私有版的区别：这个不会因异常抛错，拿不到就返回空串（UI 自行退回显示群号）。
   */
  async getChatName(groupId) {
    try {
      return (await this.#chatName(groupId)) || '';
    } catch {
      return '';
    }
  }

  async #chatName(groupId) {
    if (this.chatNameCache.has(groupId)) return this.chatNameCache.get(groupId);
    try {
      const info = await this.onebot.getGroupInfo(groupId);
      if (info?.group_name) {
        this.chatNameCache.set(groupId, String(info.group_name));
        return String(info.group_name);
      }
    } catch { /* 拿不到就用群号 */ }
    return '';
  }

  // ── 主动开话题 ─────────────────────────────────────────────────────────

  startProactiveLoop() {
    this.stopProactiveLoop();
    // #region debug-point A-C:proactive-loop-restart
    if (!String(process.argv[1]).includes('/test/')) (() => { try { const cfg = getConfig(); const body = JSON.stringify({ sessionId: 'daily-summary-group-send', runId: 'post-fix', hypothesisId: 'A,C', location: 'src/orchestrator.js:startProactiveLoop', msg: '[DEBUG] Proactive loop restarted', data: { enabled: cfg.proactive?.enabled === true, initialDelayMs: 15000, checkIntervalMinMs: cfg.proactive?.checkIntervalMinMs, checkIntervalMaxMs: cfg.proactive?.checkIntervalMaxMs, probability: cfg.proactive?.probability, suppressions: [...this.proactiveSuppressions] }, ts: Date.now() }); const req = process.getBuiltinModule('node:http').request('http://192.168.31.10:7777/event', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => res.resume()); req.on('error', () => {}); req.on('socket', (socket) => socket.unref()); req.setTimeout(500, () => req.destroy()); req.end(body); } catch {} })();
    // #endregion
    const tick = async () => {
      const cfg = getConfig();
      const next = randInt(
        Math.max(60000, Number(cfg.proactive?.checkIntervalMinMs) || 1800000),
        Math.max(120000, Number(cfg.proactive?.checkIntervalMaxMs) || 5400000)
      );
      this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, next);
      if (this.aborted || this.paused || cfg.proactive?.enabled !== true) return;
      if (this.proactiveSuppressions.size > 0) {
        // #region debug-point A-C:proactive-tick-suppressed
        if (!String(process.argv[1]).includes('/test/')) (() => { try { const body = JSON.stringify({ sessionId: 'daily-summary-group-send', runId: 'post-fix', hypothesisId: 'A,C', location: 'src/orchestrator.js:startProactiveLoop.tick', msg: '[DEBUG] Proactive tick suppressed by background task', data: { suppressions: [...this.proactiveSuppressions], nextDelayMs: next }, ts: Date.now() }); const req = process.getBuiltinModule('node:http').request('http://192.168.31.10:7777/event', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => res.resume()); req.on('error', () => {}); req.on('socket', (socket) => socket.unref()); req.setTimeout(500, () => req.destroy()); req.end(body); } catch {} })();
        // #endregion
        return;
      }
      if (this.runningChats.size >= Math.max(1, Number(cfg.maxConcurrentRuns) || 2)) return;
      if (Math.random() > (Number(cfg.proactive?.probability) || 0.25)) return;
      // 挑一个"安静且允许"的群
      const candidates = this.#proactiveCandidates(cfg);
      if (!candidates.length) return;
      const chatKey = candidates[Math.floor(Math.random() * candidates.length)];
      // #region debug-point A-C:proactive-chat-selected
      if (!String(process.argv[1]).includes('/test/')) (() => { try { const body = JSON.stringify({ sessionId: 'daily-summary-group-send', runId: 'post-fix', hypothesisId: 'A,C', location: 'src/orchestrator.js:startProactiveLoop.tick', msg: '[DEBUG] Proactive loop selected a chat', data: { chatKey, candidateCount: candidates.length, runningChats: this.runningChats.size }, ts: Date.now() }); const req = process.getBuiltinModule('node:http').request('http://192.168.31.10:7777/event', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => res.resume()); req.on('error', () => {}); req.on('socket', (socket) => socket.unref()); req.setTimeout(500, () => req.destroy()); req.end(body); } catch {} })();
      // #endregion
      this.wake(chatKey, { proactive: true }).catch((error) => console.error('[orchestrator] proactive 出错:', error));
    };
    this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, 15000);
  }

  #proactiveCandidates(cfg) {
    const idleMs = Math.max(300000, Number(cfg.proactive?.idleThresholdMs) || 1800000);
    const allowGroups = (cfg.allow?.groups ?? []).map(String);
    const out = [];
    for (const chatKey of this.store.listChats()) {
      const [kind, id] = chatKey.split(':');
      if (kind !== 'group') continue;
      if (!canRun(chatKey)) continue;
      if (allowGroups.length > 0 ? !allowGroups.includes(id) : !cfg.allowAllWhenEmpty) continue;
      const meta = this.store.getChatMeta(chatKey);
      if (meta.unread > 0) continue;
      if (Date.now() - meta.lastTs < idleMs) continue;
      if (this.runningChats.has(chatKey)) continue;
      out.push(chatKey);
    }
    return out;
  }

  // ── 群友印象自动整理 ──
  // 触发条件（二者同时满足）：印象条数超过阈值，且距上次整理超过冷却时间。
  //
  // 阈值原为硬编码 8，实测用户群里 5 位成员各 1 条印象（合计 5），5 > 8 恒 false
  // → 自动整理永远不触发。改为可配置（config.memory.consolidateMinImpressions），
  // 且默认值下调，避免在"人不多、印象还没攒起来"的群里彻底失灵。
  static MEMORY_THRESHOLDS = { memberImpression: 4 };
  static MEMBER_MIN_MESSAGES = 3;         // 整理条件：该群友在聊天记录里至少出现 3 条
  static MEMBER_MIN_IMPRESSIONS = 1;      // 整理条件：至少有 1 条印象（旧数据也可整理）
  // "发现新人"：批量整理时，聊天记录里发言够多但完全没有印象的人，也纳入整理（新建印象）。
  // 否则记忆为空的群点整理会得到"没有可整理的群友"，功能对新群完全无效。
  static DISCOVER_MIN_MESSAGES = 20;      // 至少发过这么多条才值得分析
  static DISCOVER_MAX_MEMBERS = 3;        // 单次最多发现几个人（控制成本）

  #maybeConsolidateMemory(chatKey) {
    try {
      const cfg = getConfig();
      if (!canRun(chatKey)) return;
      if (cfg.memory?.consolidateEnabled === false) return;
      if (this.paused || this.aborted) return;
      if (!cfg.api?.model || !cfg.api?.baseUrl) return;   // 没选模型就不整理
      if (this.consolidating.has(chatKey)) return;
      const st = this.memory.consolidationState(chatKey);
      // 阈值可配置：config.memory.consolidateMinImpressions（默认取类常量）
      // 注意：这里原先误写成裸标识符 T，运行时会抛 ReferenceError 导致自动整理彻底失效。
      const minImpressions = Math.max(1,
        Number(cfg.memory?.consolidateMinImpressions) || Orchestrator.MEMORY_THRESHOLDS.memberImpression);
      // 触发条件二选一：
      //   A. 全群印象总数超过阈值
      //   B. 任一成员的印象条数超过上限
      // 只看总数会在"人少"的群里彻底失灵 —— 比如 3 位成员各 1 条，
      // 总数 3 永远够不到阈值，自动整理形同虚设。
      const maxPerMember = Math.max(2, Number(cfg.memory?.maxImpressionsPerMember) || 5);
      const anyMemberOverloaded = st.members.some((m) => m.count > maxPerMember);
      if (!(st.counts.memberImpression > minImpressions) && !anyMemberOverloaded) return;
      const minInterval = Math.max(30 * 60 * 1000, Number(cfg.memory?.consolidateMinIntervalMs) || 6 * 60 * 60 * 1000);
      if (Date.now() - (st.lastConsolidatedAt || 0) < minInterval) return;
      this.consolidating.add(chatKey);
      this.consolidateMemoryForChat(chatKey)
        .catch((error) => console.error(`[memory] 整理 ${chatKey} 失败:`, error?.message ?? error))
        .finally(() => this.consolidating.delete(chatKey));
    } catch { /* 整理是锦上添花，绝不影响聊天主流程 */ }
  }

  /**
   * 整理群友印象 —— 唯一入口。
   * 手动按钮、自动整理、针对特定群友，三种用法都走这里，避免逻辑分叉走样。
   *
   * @param {string} chatKey  会话 key
   * @param {object} [opts]
   * @param {string[]} [opts.userIds]  只整理这些人（指定群友时用）；不传 = 按规则筛选全部
   * @param {boolean} [opts.force]     跳过冷却/门槛检查（手动触发时用）
   * @returns {Promise<{ok, note, changed, results, skipped, failed}>}
   *
   * 身份识别（"同一个人"的判定）：
   *   1) 优先用记忆里的 userId（QQ 号）匹配聊天记录 senderId；
   *   2) 匹配不到时，用备注名/记忆名反查 senderName，命中后把 QQ 号回写进记忆；
   *   3) 仍匹配不到但有名字 → 允许整理（历史遗留的"按名字存"条目不能永远排队）；
   *   4) 既无名也无号 → 跳过。
   */
  consolidateMemoryForChat(chatKey, options = {}) {
    return withTimeScope(chatKey, async () => {
      assertTimeAllowed();
      return this.#consolidateMemoryForChat(chatKey, options);
    });
  }

  async #consolidateMemoryForChat(chatKey, { userIds = null, force = false } = {}) {
    const cfg = getConfig();
    if (!cfg.api?.model || !cfg.api?.baseUrl) throw new Error('模型未配置，无法整理记忆');
    const notes = cfg.memberNotes || {};
    const only = Array.isArray(userIds) && userIds.length
      ? new Set(userIds.map((u) => String(u ?? '').trim()).filter(Boolean))
      : null;

    const stats = this.#scanChatActivity(chatKey);
    const existing = this.memory.members(chatKey);

    // ── 选出要整理的人 ──
    const targets = [];
    const skipped = [];

    // 指定群友但记忆里还没有 → 也要能"新建"印象（这是本功能的关键价值：
    // 聊了 200 条却零印象的人，可以手动让他被分析一次）
    if (only) {
      for (const uid of only) {
        const found = existing.find((m) => String(m.userId || '') === uid);
        if (found) {
          const resolved = this.#resolveIdentity(chatKey, found, stats, notes);
          targets.push({ ...resolved, isNew: false });
          continue;
        }
        // 记忆里没有这个人：用聊天记录里的名字兜底，允许新建
        const name = stats.uidToName.get(uid) || notes[uid] || '';
        if (!name && !stats.memberMsgCount.get(uid)) {
          skipped.push({ userId: uid, name: '', reason: '聊天记录里没有此人发言' });
          continue;
        }
        targets.push({
          userId: uid,
          name: name || `QQ ${uid}`,
          impressions: [],
          isNew: true
        });
      }
    } else {
      // 先整理记忆里已有的人
      const knownUserIds = new Set();
      for (const mem of existing) {
        const resolved = this.#resolveIdentity(chatKey, mem, stats, notes);
        if (String(resolved.userId || '')) knownUserIds.add(String(resolved.userId));
        if (this.#shouldSkip(resolved, force)) {
          skipped.push({
            userId: resolved.userId,
            name: resolved.name,
            reason: this.#skipReason(resolved)
          });
          continue;
        }
        targets.push({ ...resolved, isNew: false });
      }

      // 再"发现"聊天记录里的活跃群友：他们发言很多却没有任何印象。
      // 没有这一步，记忆为空的群（如刚启用记忆的群）点整理只会得到
      // "没有可整理的群友"，功能形同虚设。
      const discoverMin = Math.max(1,
        Number(cfg.memory?.discoverMinMessages) || Orchestrator.DISCOVER_MIN_MESSAGES);
      const discoverMax = Math.max(1,
        Number(cfg.memory?.discoverMaxMembers) || Orchestrator.DISCOVER_MAX_MEMBERS);
      const discovered = [...stats.memberMsgCount.entries()]
        .filter(([uid, n]) => n >= discoverMin && !knownUserIds.has(uid))
        .sort((a, b) => b[1] - a[1])
        .slice(0, discoverMax);
      for (const [uid, n] of discovered) {
        targets.push({
          userId: uid,
          name: stats.uidToName.get(uid) || notes[uid] || `QQ ${uid}`,
          impressions: [],
          isNew: true,
          discoveredFrom: n
        });
      }
    }

    const skippedNote = skipped.length
      ? `（跳过 ${skipped.length} 位：${skipped.slice(0, 3).map((s) => `${s.name || s.userId} ${s.reason}`).join('；')}${skipped.length > 3 ? ' 等' : ''}）`
      : '';

    if (!targets.length) {
      return {
        ok: true,
        note: `没有可整理的群友${skippedNote || (only ? '（未指定有效群友）' : '（该群还没有任何群友印象，且聊天记录里没有发言足够多的活跃成员）')}`,
        changed: 0,
        results: [],
        skipped,
        failed: []
      };
    }

    // ── 逐个整理 ──
    const results = [];
    const failed = [];
    let changed = 0;

    for (const mem of targets) {
      if (this.aborted) break;
      assertTimeAllowed();
      const before = mem.impressions.map((e) => e.content);
      try {
        const next = await this.#consolidateOneMember(chatKey, mem, { force, stats });
        if (!next) { failed.push({ userId: mem.userId, name: mem.name, reason: '模型返回无法解析' }); continue; }
        const after = next.impressions.map((e) => e.content);
        const isChanged = after.length !== before.length || after.some((c, i) => c !== before[i]);
        if (isChanged) changed += 1;
        results.push({
          userId: mem.userId,
          name: mem.name,
          before: before.length,
          after: after.length,
          changed: isChanged,
          isNew: !!mem.isNew
        });
      } catch (error) {
        failed.push({ userId: mem.userId, name: mem.name, reason: String(error?.message ?? error) });
      }
    }

    const discoveredCount = targets.filter((t) => t.isNew).length;
    const note = this.#buildConsolidateNote({
      total: targets.length, changed, failed, skipped, only, discoveredCount
    });
    this.#markConsolidated(chatKey, targets.map((t) => t.userId).filter(Boolean));
    return { ok: true, note, changed, results, skipped, failed };
  }

  /** 统计会话里各成员的出现次数与名字（用于身份识别与"新建印象"）。 */
  #scanChatActivity(chatKey) {
    const memberMsgCount = new Map();
    const nameMsgCount = new Map();
    const nameToUserId = new Map();
    const uidToName = new Map();
    for (const m of this.store.recent(chatKey, { limit: 2000 })) {
      if (m.self || !m.senderId) continue;
      const uid = String(m.senderId);
      memberMsgCount.set(uid, (memberMsgCount.get(uid) || 0) + 1);
      const nm = String(m.senderName || '').trim();
      // 跳过占位名（历史脏数据：拍一拍事件曾把 senderName 写成"（拍一拍事件）"）
      if (nm && !PLACEHOLDER_NAMES.has(nm)) {
        nameMsgCount.set(nm, (nameMsgCount.get(nm) || 0) + 1);
        if (!nameToUserId.has(nm)) nameToUserId.set(nm, uid);
        if (!uidToName.has(uid)) uidToName.set(uid, nm);
      }
    }
    return { memberMsgCount, nameMsgCount, nameToUserId, uidToName };
  }

  /** 确定一个记忆条目的 QQ 号（必要时反查名字并回写记忆文件）。 */
  #resolveIdentity(chatKey, mem, stats, notes) {
    let userId = String(mem.userId || '').trim();
    let msgCount = userId ? (stats.memberMsgCount.get(userId) || 0) : 0;

    if (msgCount < Orchestrator.MEMBER_MIN_MESSAGES) {
      const candidates = [notes[userId], mem.name, userId].filter(Boolean);
      for (const name of candidates) {
        const byName = stats.nameMsgCount.get(name) || 0;
        if (byName >= Orchestrator.MEMBER_MIN_MESSAGES) {
          const matched = stats.nameToUserId.get(name) || '';
          if (matched) {
            userId = matched;
            msgCount = byName;
            try {
              this.memory.replaceMember(chatKey, userId, mem.name, mem.impressions.map((e) => e.content));
            } catch { /* 回写失败不阻塞整理 */ }
          }
          break;
        }
      }
    }
    return { ...mem, userId, name: mem.name || stats.uidToName.get(userId) || '', msgCount };
  }

  /** 批量整理时是否跳过某人（指定群友 / 强制模式不跳过）。 */
  #shouldSkip(resolved, force) {
    if (force) return false;
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES && !String(resolved.name || '').trim()) return true;
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES && !resolved.impressions.length) return true;
    if (resolved.impressions.length < Orchestrator.MEMBER_MIN_IMPRESSIONS) return true;
    return false;
  }

  #skipReason(resolved) {
    if (resolved.impressions.length < Orchestrator.MEMBER_MIN_IMPRESSIONS) return '没有印象';
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES) return '聊天记录出现不足 3 条';
    return '无法确认身份';
  }

  /** 生成人话总结：区分"整理过但没变化"与"真的失败了"。 */
  #buildConsolidateNote({ total, changed, failed, skipped, only, discoveredCount = 0 }) {
    const skippedNote = skipped.length
      ? `（跳过 ${skipped.length} 位：${skipped.slice(0, 3).map((s) => `${s.name || s.userId} ${s.reason}`).join('；')}${skipped.length > 3 ? ' 等' : ''}）`
      : '';
    const head = only ? '已整理指定群友' : '已整理';
    const discoverNote = discoveredCount > 0 ? `（其中 ${discoveredCount} 位是新建印象）` : '';
    const body = changed > 0
      ? `${head} ${total} 位${discoverNote}，其中 ${changed} 位印象有更新`
      : `${head} ${total} 位${discoverNote}，内容无需改动（印象已足够精简）`;
    const failNote = failed.length
      ? `；${failed.length} 位失败（已保留原印象）`
      : '';
    return body + failNote + skippedNote;
  }

  /** 记录整理时间，供冷却判断使用。 */
  #markConsolidated(chatKey, userIds) {
    const now = Date.now();
    try {
      this.memory.markConsolidated(chatKey, now, userIds);
    } catch (error) {
      console.warn('[memory] 记录整理时间失败:', error?.message ?? error);
    }
  }

  /**
   * 整理单个群友的印象。
   *
   * 两种模式：
   *   - 整理模式（已有印象）：合并重复、删过时，只减不增，绝不发明新事实
   *   - 新建模式（isNew，针对零印象的活跃群友）：读他最近的发言，提炼长期印象
   *
   * 新建模式是本功能的关键补充：实测有群友聊了 200+ 条却零印象，
   * 而模型日常几乎不主动调 memory_append —— 没有这个入口就永远补不上。
   */
  async #consolidateOneMember(chatKey, mem, { force = false, stats = null } = {}) {
    const existing = mem.impressions || [];
    const isNew = !!mem.isNew || (!existing.length && !!force);

    const { system, user } = isNew
      ? this.#buildNewImpressionPrompt(chatKey, mem, stats)
      : this.#buildConsolidatePrompt(mem);

    const res = await this.#memoryChat([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]);
    assertTimeAllowed();

    const parsed = extractJsonObject(String(res?.message?.content ?? ''));
    if (!parsed) {
      console.warn(`[memory] ${isNew ? '新建' : '整理'} ${chatKey}/${mem.userId || mem.name} 结果无法解析为 JSON，本轮放弃`);
      if (process.env.QQ_AGENT_DEBUG_MEMORY) {
        console.warn('[memory][debug] 原始返回 =', JSON.stringify(String(res?.message?.content ?? '')).slice(0, 1500));
      }
      return null;
    }

    const raw = Array.isArray(parsed.impressions) ? parsed.impressions : [];
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;

    // 整理模式：条数变多 = 疑似幻觉，放弃（保留原印象）
    if (!isNew && raw.length > existing.length) {
      console.warn(`[memory] 整理 ${chatKey}/${mem.userId} 结果条数变多（${existing.length}→${raw.length}），疑似幻觉，放弃`);
      return null;
    }

    const clean = raw
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, maxKeep)
      .map((content) => content.slice(0, 120));

    return this.memory.replaceMember(chatKey, mem.userId, mem.name, clean);
  }

  /** 整理模式：合并/删减已有印象。 */
  #buildConsolidatePrompt(mem) {
    const fmtTs = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    const lines = [`群友 QQ：${mem.userId}`, `当前名字：${mem.name}`];
    for (const e of mem.impressions) lines.push(`- ${e.content} (${fmtTs(e.createdAt)})`);
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;
    return {
      system: '你是聊天机器人的记忆整理模块，负责整理对某一位群友的长期印象。你只做合并、改写与删除，绝不发明任何新事实。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"impressions":["…"]}',
      user: [
        '下面是机器人对一位群友的全部印象，请整理：',
        '1. 把同义/重复的印象合并成一条，以最新的观感为准。',
        '2. 明显过时、矛盾、或一次性事件（不会再次影响相处）的印象删除。',
        `3. 最多保留 ${maxKeep} 条，每条不超过 120 字。`,
        '原则：所有信息只能来自原文，语义不变，宁少勿错；没有可保留的时输出空数组。',
        '',
        ...lines
      ].join('\n')
    };
  }

  /** 新建模式：从聊天记录里提炼对某人的长期印象。 */
  #buildNewImpressionPrompt(chatKey, mem, stats) {
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;
    const uid = String(mem.userId || '');
    const sample = (this.store.recent(chatKey, { limit: 2000 }) || [])
      .filter((m) => !m.self && String(m.senderId) === uid)
      .slice(-40)
      .map((m) => String(m.text || '').slice(0, 200))
      .filter(Boolean);

    return {
      system: '你是聊天机器人的记忆模块，负责从聊天记录里提炼对某一位群友的长期印象。只提炼"以后跟这个人打交道用得上"的稳定特征，严格依据给定的发言，不要编造。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"impressions":["…"]}',
      user: [
        `下面是群友（QQ ${uid}${(mem.name && `，名字 ${mem.name}`) || ''}）最近的部分发言，请提炼对他的长期印象：`,
        '1. 只保留稳定特征：说话风格、爱玩的梗、常聊话题、雷点、身份关系。',
        '2. 不要记一次性事件、临时话题，也不要记录流水账。',
        `3. 最多 ${maxKeep} 条，每条不超过 120 字，用第一人称视角（"他/她…"）。`,
        '4. 宁少勿错：信息不足就少写，不要脑补。',
        '5. 若实在提炼不出任何稳定特征，输出空数组。',
        '',
        sample.length ? sample.join('\n') : '（没有抓到该群友的发言）'
      ].join('\n')
    };
  }

  /**
   * 记忆整理专用模型调用。
   * useChatModel=true 时跟随聊天模型（cfg.api.*）；
   * false 时使用 cfg.memory.provider/model 指向的目录模型（端点/密钥取自 providers）。
   */
  async #memoryChat(messages) {
    const cfg = getConfig();
    const mem = cfg.memory || {};
    if (mem.useChatModel !== false) {
      return chatCompletion({ messages, temperature: 0.2 });
    }    const providers = currentProviders();
    const p = providers.find((x) => x.id === mem.provider);
    if (!p?.baseURL || !p?.apiKey || !mem.model) {
      throw new Error('记忆整理专用模型未配置：请在设置 → 记忆里选择提供商与模型');
    }
    return chatCompletion({
      messages,
      temperature: 0.2,
      overrides: { baseUrl: p.baseURL, apiKey: p.apiKey, model: mem.model, timeoutMs: 180000 }
    });
  }

  stopProactiveLoop() {
    clearTimeout(this.proactiveTimer);
    this.proactiveTimer = null;
  }

  // ── 控制接口 ───────────────────────────────────────────────────────────

  setPaused(paused, reason = 'manual') {
    this.paused = !!paused;
    updateConfig({ runtime: { paused: this.paused } });
    if (this.paused) {
      for (const controller of this.controllers.values()) controller.abort(new Error('Run cancelled'));
    }
    this.pauseReason = this.paused ? reason : null;
    this.emit('status', { paused: this.paused, pauseReason: this.pauseReason });
  }

  async abortAll() {
    this.aborted = true;
    clearInterval(this.retryTimer);
    for (const controller of this.controllers.values()) controller.abort(new Error('Run cancelled'));
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    this.pendingWake.clear();
    this.firstPendingAt.clear();
    for (const sessionId of this.pendingSessions.values()) this.#finishWaiting(sessionId, 'aborted');
    this.pendingSessions.clear();
    this.stopProactiveLoop();
    await Promise.allSettled([...this.runTasks]);
  }

  statusSummary() {
    const cfg = getConfig();
    return {
      paused: this.paused,
      mode: cfg.runtime?.mode || 'observe',
      pauseReason: this.pauseReason ?? null,
      running: [...this.runningChats],
      activeSessions: [...this.activeRuns.entries()].map(([chatKey, sessionId]) => ({ chatKey, sessionId })),
      consolidating: [...this.consolidating],
      onebotConnected: this.onebot.connected,
      model: cfg.api.model,
      maxConcurrentRuns: cfg.maxConcurrentRuns
    };
  }
}

function safeParse(text) {
  try { return typeof text === 'string' ? JSON.parse(text) : text; } catch { return { raw: String(text).slice(0, 500) }; }
}

// ── 内联工具调用解析（少数模型不返回原生 tool_calls，而是把调用写进文本） ──
// 支持的格式：
//   1. <tool_call> <function=send_message> <parameter=messages>…</parameter> </function> </tool_call>
//   2. <tool_call> {"name":"send_message","arguments":{...}} </tool_call>
//   3. <tool_call> send_message \n {"messages":"..."} </tool_call>
// 返回 [{ name, args }]；没有解析到则返回 []。
export function parseInlineToolCalls(text) {
  const out = [];
  const blockRe = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi;
  let match;
  while ((match = blockRe.exec(String(text || ''))) !== null) {
    const block = match[1].trim();
    if (!block) continue;
    const call = parseInlineBlock(block);
    if (call) out.push(call);
  }
  return out;
}

function parseInlineBlock(block) {
  // 1) 整个块是 JSON：{"name": "...", "arguments": {...}}（部分模型用 parameters/args）
  const jsonMatch = block.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const name = obj.name || obj.function || obj.tool;
      const args = obj.arguments || obj.parameters || obj.args || obj.input || {};
      if (name) return { name: String(name), args: (args && typeof args === 'object' && !Array.isArray(args)) ? args : {} };
    } catch { /* 不是 JSON，继续按 XML 解析 */ }
  }

  // 2) <function=send_message> + <parameter=key>value</parameter>
  const fnMatch = block.match(/<function\s*=\s*([^>]+)>/i);
  let name = fnMatch ? fnMatch[1].trim().replace(/^["']|["']$/g, '') : '';
  const args = {};
  const paramRe = /<parameter\s*=\s*([^>]+)>([\s\S]*?)<\/parameter>/gi;
  let pm;
  while ((pm = paramRe.exec(block)) !== null) {
    const key = pm[1].trim().replace(/^["']|["']$/g, '');
    let value = pm[2].trim();
    try { value = JSON.parse(value); } catch { /* 保持原始文本 */ }
    args[key] = value;
  }
  if (name && fnMatch) return { name, args };

  // 3) 首行是函数名，其余是 JSON 参数（GLM/Qwen 部分格式）
  const lines = block.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!name && lines.length >= 2 && /^[a-zA-Z_][\w.-]*$/.test(lines[0])) {
    name = lines[0];
    try {
      const parsed = JSON.parse(lines.slice(1).join('\n'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { name, args: parsed };
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * 聊天记录里可能出现的占位名（非真实昵称）。
 * 来源：历史版本的拍一拍事件把 senderName 硬编码成"（拍一拍事件）"。
 * 取名字时必须跳过，否则记忆里会出现"某人的名字叫（拍一拍事件）"。
 */
const PLACEHOLDER_NAMES = new Set([
  '（拍一拍事件）',
  '(拍一拍事件)',
  '未知',
  '某人'
]);

/**
 * 从模型输出里稳健提取 JSON 对象。
 *
 * 模型并不总会乖乖只吐 JSON，常见变体：
 *   1) ```json\n{...}\n```            —— Markdown 代码块
 *   2) "好的，这是整理结果：\n{...}"   —— 前后带解释文字
 *   3) '{"impressions":[...]}'        —— 用了单引号
 *   4) 结尾多了个逗号                  —— 尾随逗号
 * 原实现只会剥掉"整段被 ``` 包裹"这一种，其余全部解析失败 → 整理静默放弃。
 */
function extractJsonObject(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  // 1) 先尝试直接解析
  try { return JSON.parse(text); } catch { /* 继续尝试 */ }

  // 2) 剥掉 ``` 代码块（可能在中间任意位置）
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1].trim());

  // 3) 取第一个 { 到最后一个 } 之间的内容
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const cand of candidates) {
    try { return JSON.parse(cand); } catch { /* 继续 */ }
    // 修正常见瑕疵后重试：尾随逗号、单引号
    try {
      const fixed = cand
        .replace(/,\s*([}\]])/g, '$1')          // 尾随逗号
        .replace(/'/g, '"');                     // 单引号 → 双引号
      const parsed = JSON.parse(fixed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 继续 */ }
    // 兜底：只抽 impressions 数组
    const arrMatch = cand.match(/"impressions"\s*:\s*\[([\s\S]*?)\]\s*[,}]?/);
    if (arrMatch) {
      try {
        const items = JSON.parse('[' + arrMatch[1].replace(/,\s*$/, '') + ']');
        return { impressions: items };
      } catch { /* 继续 */ }
    }
  }
  return null;
}
