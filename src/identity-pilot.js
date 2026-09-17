import crypto from 'node:crypto';
import { IdentityPilotManager as CoreIdentityPilotManager } from './identity-pilot-core.js';
import { chatCompletionWithRetry, cachedTokensOfUsage } from './llm.js';
import {
  buildFriendReviewSystemPrompt,
  buildFriendReviewUserPrompt,
  FRIEND_REVIEW_TOOL
} from './friend-review-prompt.js';

export { inactiveIdentityPilotStatus } from './identity-pilot-core.js';

const FRIEND_REVIEW_RATINGS = ['quality', 'interest', 'reciprocity', 'stability'];

function cloneAuditMessages(messages) {
  return structuredClone(Array.isArray(messages) ? messages : []);
}

function buildCallUsage(response) {
  const usage = response?.usage || {};
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const cachedTokens = Math.min(promptTokens, cachedTokensOfUsage(usage));
  return {
    round: 1,
    promptTokens,
    cachedTokens,
    cacheHitRate: promptTokens ? Math.min(1, cachedTokens / promptTokens) : 0,
    completionTokens: Number(usage.completion_tokens) || 0,
    totalTokens: Number(usage.total_tokens) || 0
  };
}

function buildReviewUsage(response) {
  const call = buildCallUsage(response);
  return {
    promptTokens: call.promptTokens,
    completionTokens: call.completionTokens,
    totalTokens: call.totalTokens,
    cachedTokens: call.cachedTokens,
    calls: 1
  };
}

function normalizeFriendReviewSession(session, audit) {
  if (!session || session.kind !== 'friend-review' || !audit?.response) return;
  const response = audit.response;
  const message = response?.message || {};
  const lastIndex = session.messages.length - 1;
  const last = lastIndex >= 0 ? session.messages[lastIndex] : null;

  // Core implementation historically stored { assistant, toolCalls } here. Convert that
  // legacy shape into the same OpenAI-compatible audit shape used by normal agent sessions.
  if (last && !last.role && ('assistant' in last || 'toolCalls' in last)) {
    session.messages[lastIndex] = {
      role: 'assistant',
      content: message.content ?? null,
      ...(typeof message.reasoning_content === 'string' && message.reasoning_content
        ? { reasoning_content: message.reasoning_content }
        : {}),
      ...(Array.isArray(message.tool_calls) && message.tool_calls.length
        ? { tool_calls: structuredClone(message.tool_calls) }
        : {}),
      raw: response.raw ?? null
    };
  }

  session.inputMessages = cloneAuditMessages(audit.messages);
  session.inputTools = structuredClone(audit.tools);
  session.inputRequestOptions = {
    toolChoice: audit.toolChoice,
    temperature: audit.temperature,
    maxTokens: audit.maxTokens
  };
  session.inputRound = 1;
  session.inputPayloadChars = JSON.stringify({
    messages: audit.messages,
    tools: audit.tools
  }).length;
  session.finishReason = response.finishReason ?? null;
  session.model = response.model || session.model || '';
  session.callUsage = [buildCallUsage(response)];
}

function wrapSessions(sessions, takeAudit) {
  if (!sessions) return sessions;
  const live = new Map();

  return new Proxy(sessions, {
    get(target, prop) {
      if (prop === 'create') {
        return (...args) => {
          const session = target.create(...args);
          if (session?.id) live.set(session.id, session);
          return session;
        };
      }
      if (prop === 'update') {
        return (id, ...args) => {
          const session = live.get(id);
          if (session?.kind === 'friend-review') {
            const audit = takeAudit(false);
            if (audit) normalizeFriendReviewSession(session, audit);
          }
          return target.update(id, ...args);
        };
      }
      if (prop === 'finish') {
        return (id, ...args) => {
          const session = live.get(id);
          if (session?.kind === 'friend-review') {
            const audit = takeAudit(true);
            if (audit) normalizeFriendReviewSession(session, audit);
          }
          const result = target.finish(id, ...args);
          live.delete(id);
          return result;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function parseManualFriendReview(response, history, settings) {
  const calls = Array.isArray(response?.message?.tool_calls)
    ? response.message.tool_calls
    : [];
  if (calls.length !== 1 || calls[0]?.function?.name !== 'submit_friend_review') {
    throw new Error('模型未提交唯一的 submit_friend_review 结果');
  }
  let value;
  try {
    value = JSON.parse(String(calls[0].function.arguments || '{}'));
  } catch {
    throw new Error('好友评估工具参数不是有效 JSON');
  }
  if (!['propose', 'skip'].includes(value?.decision)) {
    throw new Error('好友评估 decision 必须是 propose 或 skip');
  }
  const ratings = {};
  for (const key of FRIEND_REVIEW_RATINGS) {
    const rating = Number(value?.ratings?.[key]);
    if (!Number.isInteger(rating) || rating < 0 || rating > 4) {
      throw new Error(`好友评估评分 ${key} 必须是 0 到 4 的整数`);
    }
    ratings[key] = rating;
  }
  const allowedEvidence = new Set(history?.evidenceIds || []);
  const evidenceIds = [...new Set((Array.isArray(value.evidenceIds)
    ? value.evidenceIds
    : []).map(String))];
  if (evidenceIds.some((id) => !allowedEvidence.has(id))) {
    throw new Error('好友评估引用了不存在的证据');
  }
  const reasonCode = ['interest', 'frequent', 'banter'].includes(value.reasonCode)
    ? value.reasonCode
    : '';
  const reason = String(value.reason || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (!reasonCode || !reason) throw new Error('好友评估缺少有效原因');

  const weights = settings.weights || {};
  const score = FRIEND_REVIEW_RATINGS.reduce((sum, key) =>
    sum + (Number(weights[key]) || 0) * ratings[key] / 4, 0);
  return {
    decision: value.decision,
    ratings,
    evidenceIds,
    reasonCode,
    reason,
    verificationMessage: String(value.verificationMessage || '')
      .replace(/\s+/g, ' ').trim().slice(0, 50),
    score: Math.round(score * 100) / 100,
    qualified: value.decision === 'propose'
      && score >= Number(settings.scoreThreshold)
      && evidenceIds.length >= 2
  };
}

function normalizeManualSettings(cfg) {
  const raw = cfg.identityPilot?.friendProposal?.triggered || {};
  return {
    ...structuredClone(raw),
    historyDays: Number(raw.historyDays) || 30,
    scoreThreshold: Number(raw.scoreThreshold) || 70,
    weights: raw.weights || {
      quality: 40,
      interest: 30,
      reciprocity: 20,
      stability: 10
    }
  };
}

function manualPrompt(basePrompt, alreadyFriend) {
  const payload = JSON.parse(basePrompt);
  payload.task = '管理员手动触发好友评分；忽略自动触发资格、概率、冷却与是否已是好友，只评估真实互动质量';
  payload.trigger = {
    ...(payload.trigger || {}),
    manual: true,
    reason: '管理员手动触发'
  };
  payload.eligibility = {
    ...(payload.eligibility || {}),
    alreadyFriend: Boolean(alreadyFriend),
    automaticGatesIgnored: true
  };
  payload.rules = [
    '这是管理员手动评分，不应用自动候选触发门槛；即使已经是好友也必须正常评分',
    '是否已经是好友只影响后续是否生成好友候选，不得影响四项评分本身',
    ...(Array.isArray(payload.rules) ? payload.rules : [])
  ];
  return JSON.stringify(payload, null, 2);
}

async function refreshKnownFriends(manager) {
  try {
    const result = await manager.onebot.call('get_friend_list', {}, 15000);
    const friends = Array.isArray(result)
      ? result
      : Array.isArray(result?.data)
        ? result.data
        : null;
    if (!friends) throw new Error('OneBot 好友列表响应格式无效');
    manager.identityStore.replaceKnownFriends(friends);
    return { fresh: true, error: '' };
  } catch (error) {
    return { fresh: false, error: String(error?.message ?? error) };
  }
}

async function resolveAccountUin(manager) {
  let accountUin = String(manager.onebot?.selfId || '').trim();
  if (/^\d{5,15}$/.test(accountUin)) return accountUin;
  const login = await manager.onebot.call('get_login_info', {}, 15000);
  accountUin = String(login?.user_id || '').trim();
  if (!/^\d{5,15}$/.test(accountUin)) {
    throw new Error('OneBot 未返回有效的机器人 QQ');
  }
  return accountUin;
}

function manualReviewResultNote({ alreadyFriend, review, completed }) {
  if (alreadyFriend) {
    return `评分完成：${review.score} 分；对方已经是好友，不生成或发送好友申请。`;
  }
  if (completed?.proposal) {
    return `评分完成：${review.score} 分；已生成好友候选，等待管理员审批。`;
  }
  if (review.qualified) {
    const reason = completed?.opportunity?.reason || '候选未生成';
    return `评分完成：${review.score} 分；达到阈值，但未生成新的好友候选（${reason}）。`;
  }
  return `评分完成：${review.score} 分；本次未达到主动好友候选条件。`;
}

export class IdentityPilotManager extends CoreIdentityPilotManager {
  constructor(options = {}) {
    let pendingAudit = null;
    const originalComplete = options.complete || chatCompletionWithRetry;
    const complete = async (args, ...rest) => {
      const response = await originalComplete(args, ...rest);
      pendingAudit = {
        messages: cloneAuditMessages(args?.messages),
        tools: structuredClone(Array.isArray(args?.tools) ? args.tools : []),
        toolChoice: args?.toolChoice ?? 'auto',
        temperature: args?.temperature ?? null,
        maxTokens: args?.maxTokens ?? null,
        response
      };
      return response;
    };
    const takeAudit = (consume) => {
      const audit = pendingAudit;
      if (consume) pendingAudit = null;
      return audit;
    };

    super({
      ...options,
      complete,
      sessions: wrapSessions(options.sessions, takeAudit)
    });
    this.manualFriendReviewComplete = originalComplete;
    this.manualFriendReviewSessions = options.sessions || null;
  }

  /**
   * Persist prompt-mode friend candidates even when no administrator QQ is
   * configured. The global administrator is an approval/notification edge,
   * not a prerequisite for the always-on identity/friend infrastructure.
   *
   * Keep the mature core path unchanged when an owner exists; only the
   * missing-owner case is handled here so the compatibility core can be
   * retired independently later.
   */
  async proposeFriend({
    userId,
    chatKey,
    reasonCode,
    reason,
    verificationMessage = '',
    signal
  }) {
    const cfg = this.config();
    const settings = cfg.identityPilot?.friendProposal || {};
    const ownerUin = String(settings.ownerUin || '').trim();
    if (/^\d{5,15}$/.test(ownerUin)) {
      return super.proposeFriend({
        userId,
        chatKey,
        reasonCode,
        reason,
        verificationMessage,
        signal
      });
    }
    if (!this.identityStore || settings.mode === 'triggered') {
      throw new Error('主动好友候选功能当前未启用');
    }

    const result = this.identityStore.createFriendProposal({
      userId: String(userId || '').trim(),
      sourceChatKey: chatKey,
      reasonCode,
      reason,
      verificationMessage,
      minMessageCount: settings.minMessageCount,
      cooldownDays: settings.cooldownDays,
      maxPending: settings.maxPending
    });
    if (!result.created) {
      return {
        ...result,
        adminNotified: Boolean(result.proposal.notifiedAt),
        protocolDispatchSupported: true
      };
    }

    const notifyError = '尚未配置接收好友审批的管理员 QQ';
    const proposal = this.identityStore.markFriendProposalNotification(
      result.proposal.id,
      { notified: false, error: notifyError }
    );
    this.log(`[identity-pilot] 好友候选 ${proposal.id} 已记录，管理员通知跳过：${notifyError}`);
    return {
      created: true,
      proposal,
      adminNotified: false,
      protocolDispatchSupported: true
    };
  }

  async manualFriendReview({
    userId,
    chatKey = '',
    requestedBy = 'console',
    signal = null
  } = {}) {
    const cfg = this.config();
    if (!this.identityStore || cfg.identityPilot?.friendProposal?.enabled !== true) {
      throw new Error('主动好友候选功能当前未启用');
    }

    const targetUin = String(userId || '').trim();
    if (!/^\d{1,15}$/.test(targetUin) || Number(targetUin) <= 0) {
      throw new Error('QQ 号必须是正整数');
    }

    const accountUin = await resolveAccountUin(this);
    if (targetUin === accountUin) throw new Error('不能评估机器人自己的 QQ');

    const snapshot = await refreshKnownFriends(this);
    if (!snapshot.fresh) {
      this.log(`[identity-pilot] 手动好友评分刷新好友列表失败，继续按本地快照评分：${snapshot.error}`);
    }
    const alreadyFriend = this.identityStore.isKnownFriend(targetUin);

    const people = this.identityStore.listPeople(500);
    const personSummary = people.find((person) => String(person.userId) === targetUin) || null;
    const sourceChatKey = String(
      chatKey || personSummary?.sourceChatKey || `private:${targetUin}`
    ).trim();
    if (!/^(group|private):\d+$/.test(sourceChatKey)) {
      throw new Error('来源会话格式必须为 group:<群号> 或 private:<QQ号>');
    }

    const now = Date.now();
    const settings = normalizeManualSettings(cfg);
    const metrics = this.store.friendEligibilityMetrics(sourceChatKey, targetUin, {
      since: 0,
      until: now,
      selfId: accountUin
    });
    const history = this.store.friendReviewHistory(sourceChatKey, targetUin, {
      since: 0,
      until: now,
      maxCandidate: 24,
      maxAgent: 24,
      maxChars: 12000
    });
    const person = this.identityStore.getPerson(targetUin, {
      chatKey: sourceChatKey
    }) || personSummary;

    // createFriendOpportunity normally applies all automatic gates. The manual path must
    // still create a normal auditable record, but deliberately bypass those gates.
    const blockCheck = this.identityStore.triggeredCandidateBlockReason;
    let created;
    this.identityStore.triggeredCandidateBlockReason = () => '';
    try {
      created = this.identityStore.createFriendOpportunity({
        accountUin,
        userId: targetUin,
        sourceChatKey,
        parentSessionId: '',
        triggerKey: `manual:${accountUin}:${targetUin}:${crypto.randomUUID()}`,
        triggerMessageIds: [],
        triggerReason: '管理员手动触发',
        eligibility: {
          ...metrics,
          manual: true,
          alreadyFriend,
          automaticGatesIgnored: true
        },
        config: {
          ...settings,
          manual: true,
          requestedBy: String(requestedBy || 'console').slice(0, 80),
          model: String(cfg.api?.model || '')
        },
        probability: 1,
        randomValue: 0,
        dayStart: 0,
        maxDrawsPerDay: Number.MAX_SAFE_INTEGER,
        maxReviewsPerDay: Number.MAX_SAFE_INTEGER,
        drawCooldownMs: 0,
        now
      });
    } finally {
      this.identityStore.triggeredCandidateBlockReason = blockCheck;
    }
    if (!created?.created || created.opportunity?.status !== 'queued') {
      throw new Error(`无法创建手动好友评分记录：${created?.reason || 'unknown'}`);
    }

    const opportunity = created.opportunity;
    const systemPrompt = buildFriendReviewSystemPrompt(cfg.persona || {});
    const userPrompt = manualPrompt(buildFriendReviewUserPrompt({
      opportunity,
      person,
      metrics,
      history,
      settings,
      triggerReason: '管理员手动触发',
      repliedThisRun: false
    }), alreadyFriend);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    const tools = [FRIEND_REVIEW_TOOL];
    const reviewSessions = this.manualFriendReviewSessions;
    const reviewSession = reviewSessions?.create({
      chatKey: sourceChatKey,
      trigger: [],
      triggerSummary: `手动好友评估：${person?.primaryName || targetUin}`
    }) || null;

    if (reviewSession) {
      reviewSession.kind = 'friend-review';
      reviewSession.manualTrigger = true;
      reviewSession.manualTargetUserId = targetUin;
      reviewSession.alreadyFriend = alreadyFriend;
      reviewSession.opportunityId = opportunity.id;
      reviewSession.systemPrompt = systemPrompt;
      reviewSession.userPrompt = userPrompt;
      reviewSession.promptChars = systemPrompt.length + userPrompt.length;
      reviewSession.model = String(cfg.api?.model || '');
      reviewSession.inputMessages = cloneAuditMessages(messages);
      reviewSession.inputTools = structuredClone(tools);
      reviewSession.inputRequestOptions = {
        toolChoice: 'auto',
        temperature: 0.2,
        maxTokens: 2048
      };
      reviewSession.inputRound = 1;
      reviewSession.inputPayloadChars = JSON.stringify({ messages, tools }).length;
      reviewSession.triggerKind = 'manual';
      reviewSession.triggerReason = '管理员手动好友评估';
      reviewSessions.update(reviewSession.id);
      this.emit('session-start', {
        sessionId: reviewSession.id,
        chatKey: sourceChatKey,
        triggerSummary: reviewSession.triggerSummary
      });
    }

    let consumedUsage = {};
    try {
      const response = await this.manualFriendReviewComplete({
        messages,
        tools,
        toolChoice: 'auto',
        temperature: 0.2,
        maxTokens: 2048,
        signal
      }, 0);
      const usage = buildReviewUsage(response);
      consumedUsage = usage;
      const review = parseManualFriendReview(response, history, settings);

      if (reviewSession) {
        reviewSession.rounds = 1;
        reviewSession.usage = usage;
        reviewSession.finishReason = response.finishReason ?? null;
        reviewSession.model = response.model || reviewSession.model || '';
        reviewSession.callUsage = [buildCallUsage(response)];
        reviewSession.messages.push({
          role: 'assistant',
          content: response?.message?.content ?? null,
          ...(typeof response?.message?.reasoning_content === 'string'
            && response.message.reasoning_content
            ? { reasoning_content: response.message.reasoning_content }
            : {}),
          ...(Array.isArray(response?.message?.tool_calls)
            && response.message.tool_calls.length
            ? { tool_calls: structuredClone(response.message.tool_calls) }
            : {}),
          raw: response.raw ?? null
        });
        reviewSessions.update(reviewSession.id);
      }

      const desiredStatus = review.qualified ? 'proposed' : 'skipped';
      const reason = review.decision === 'skip'
        ? 'model-skip'
        : review.score < Number(settings.scoreThreshold)
          ? 'below-threshold'
          : review.evidenceIds.length < 2
            ? 'insufficient-evidence'
            : '';
      const proposalSettings = cfg.identityPilot?.friendProposal || {};
      const completed = this.identityStore.finishFriendReview(
        opportunity.id,
        desiredStatus,
        {
          reason,
          review,
          usage,
          model: response.model,
          proposal: review.qualified
            ? {
                reasonCode: review.reasonCode,
                reason: review.reason,
                verificationMessage: review.verificationMessage,
                cooldownDays: proposalSettings.cooldownDays,
                maxPending: proposalSettings.maxPending
              }
            : null
        }
      );

      let proposal = completed.proposal;
      if (proposal && this.notifyFriendProposal) {
        const ownerUin = String(proposalSettings.ownerUin || '').trim();
        let notified = false;
        let notifyError = '';
        try {
          if (!/^\d{5,15}$/.test(ownerUin)) {
            throw new Error('尚未配置接收好友审批的管理员 QQ');
          }
          await this.notifyFriendProposal(proposal, ownerUin, signal);
          notified = true;
        } catch (error) {
          notifyError = String(error?.message ?? error);
          this.log(`[identity-pilot] 手动好友候选 ${proposal.id} 通知管理员失败：${notifyError}`);
        }
        proposal = this.identityStore.markFriendProposalNotification(proposal.id, {
          notified,
          error: notifyError
        });
      }

      if (reviewSession) {
        reviewSessions.finish(reviewSession.id, 'done');
        this.emit('session-end', {
          sessionId: reviewSession.id,
          chatKey: sourceChatKey,
          status: 'done',
          usage
        });
      }
      this.emit('identity-pilot-update', this.status());

      const finalCompleted = {
        ...completed,
        proposal
      };
      return {
        userId: targetUin,
        sourceChatKey,
        alreadyFriend,
        friendSnapshotFresh: snapshot.fresh,
        friendSnapshotError: snapshot.error,
        review,
        opportunity: finalCompleted.opportunity,
        proposal: finalCompleted.proposal,
        note: manualReviewResultNote({
          alreadyFriend,
          review,
          completed: finalCompleted
        })
      };
    } catch (error) {
      try {
        this.identityStore.finishFriendReview(opportunity.id, 'review_failed', {
          reason: String(error?.message ?? error),
          usage: consumedUsage
        });
      } catch { /* record may already be closed */ }
      if (reviewSession) {
        reviewSession.error = String(error?.message ?? error);
        reviewSessions.finish(reviewSession.id, 'error');
        this.emit('session-end', {
          sessionId: reviewSession.id,
          chatKey: sourceChatKey,
          status: 'error',
          error: reviewSession.error
        });
      }
      this.emit('identity-pilot-update', this.status());
      throw error;
    }
  }
}
