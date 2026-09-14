import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig } from './config.js';
import {
  addUsage,
  cachedTokensOfUsage,
  chatCompletionWithRetry,
  emptyUsage
} from './llm.js';
import { assertTimeAllowed, watchTimeWindow, withTimeScope } from './time-gate.js';
import { timeControlState } from './time-control.js';
import {
  estimateQzoneTokens,
  parseQzoneFeed,
  qzoneCommentKey,
  qzonePostKey,
  QzoneWebClient
} from './qzone-feed.js';
import {
  buildQzoneInteractionPrompt,
  qzoneInteractionPersonaHash,
  QZONE_INTERACTION_PROMPT_VERSION
} from './qzone-interaction-prompt.js';

const STATE_FILE = path.join(DATA_DIR, 'qzone-interactions.json');
const HOUR_MS = 60 * 60 * 1000;
const MAX_STATE_ITEMS = 2000;

function cleanText(value, max = 1000) {
  return String(value ?? '').replace(/\0/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function interactionError(code, message, httpStatus = 409) {
  return Object.assign(new Error(message), { code, httpStatus });
}

function normalizedConfig(raw = getConfig().qzoneInteractions || {}) {
  return {
    enabled: raw.enabled === true,
    startupCatchup: raw.startupCatchup === true,
    feedIntervalMinutes: Math.min(1440, Math.max(5, Number(raw.feedIntervalMinutes) || 60)),
    replyIntervalMinutes: Math.min(1440, Math.max(1, Number(raw.replyIntervalMinutes) || 5)),
    feedFetchCount: Math.min(50, Math.max(1, Number(raw.feedFetchCount) || 30)),
    ownPostCount: Math.min(30, Math.max(1, Number(raw.ownPostCount) || 10)),
    maxAgeHours: Math.min(24 * 30, Math.max(1, Number(raw.maxAgeHours) || 72)),
    maxBatchItems: Math.min(50, Math.max(1, Number(raw.maxBatchItems) || 20)),
    maxLikesPerRun: Math.min(20, Math.max(0, Number(raw.maxLikesPerRun) || 0)),
    maxCommentsPerRun: Math.min(10, Math.max(0, Number(raw.maxCommentsPerRun) || 0)),
    maxRepliesPerRun: Math.min(20, Math.max(0, Number(raw.maxRepliesPerRun) || 0)),
    commentMaxChars: Math.min(200, Math.max(5, Number(raw.commentMaxChars) || 60)),
    replyMaxChars: Math.min(200, Math.max(5, Number(raw.replyMaxChars) || 60)),
    allowLikes: raw.allowLikes !== false,
    allowComments: raw.allowComments !== false,
    allowReplies: raw.allowReplies !== false,
    actionDelayMinMs: Math.min(10000, Math.max(0, Number(raw.actionDelayMinMs) || 0)),
    actionDelayMaxMs: Math.min(15000, Math.max(0, Number(raw.actionDelayMaxMs) || 0)),
    maxDecisionRounds: Math.min(5, Math.max(1, Number(raw.maxDecisionRounds) || 3))
  };
}

function defaultState() {
  return {
    version: 1,
    feedInitializedAt: 0,
    replyInitializedAt: 0,
    lastFeedPollAt: 0,
    lastReplyPollAt: 0,
    feeds: [],
    comments: [],
    watchedPosts: [],
    runs: []
  };
}

function normalizeState(raw) {
  const fallback = defaultState();
  const state = raw && typeof raw === 'object' ? raw : {};
  for (const key of ['feeds', 'comments', 'watchedPosts', 'runs']) {
    if (!Array.isArray(state[key])) state[key] = fallback[key];
  }
  state.version = 1;
  state.feedInitializedAt = Number(state.feedInitializedAt) || 0;
  state.replyInitializedAt = Number(state.replyInitializedAt) || 0;
  state.lastFeedPollAt = Number(state.lastFeedPollAt) || 0;
  state.lastReplyPollAt = Number(state.lastReplyPollAt) || 0;
  return state;
}

function openAiTools(defs) {
  return defs.map((def) => ({
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters
    }
  }));
}

function actionCounts(plan) {
  const counts = { likes: 0, comments: 0, replies: 0 };
  for (const item of plan.feedActions) {
    if (item.action === 'like' || item.action === 'like_comment') counts.likes += 1;
    if (item.action === 'comment' || item.action === 'like_comment') counts.comments += 1;
  }
  counts.replies = plan.replyActions.filter((item) => item.action === 'reply').length;
  return counts;
}

function sanitizePlan(raw, batch, cfg) {
  const fail = (message) => {
    throw interactionError('QZONE_INTERACTION_DECISION_INVALID', message, 422);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('提交参数必须为 JSON 对象');
  if (!Array.isArray(raw.feedActions) || !Array.isArray(raw.replyActions)) {
    fail('feedActions 和 replyActions 必须为数组');
  }
  const feedIds = new Set(batch.feeds.map((item) => item.id));
  const replyIds = new Set(batch.replies.map((item) => item.id));
  const seenFeed = new Set();
  const seenReply = new Set();
  const feedActions = raw.feedActions.map((item) => {
    const id = String(item?.id || '');
    const action = String(item?.action || '');
    if (!feedIds.has(id) || seenFeed.has(id)) fail('feedActions 含未知或重复 id');
    if (!['skip', 'like', 'comment', 'like_comment'].includes(action)) {
      fail('好友动态 action 必须为 skip、like、comment 或 like_comment');
    }
    if ((!cfg.allowLikes && ['like', 'like_comment'].includes(action))
      || (!cfg.allowComments && ['comment', 'like_comment'].includes(action))) {
      fail('提交了当前设置不允许的好友动态操作');
    }
    const content = cleanText(item?.content, 1000);
    if (content.length > cfg.commentMaxChars) {
      fail(`评论不能超过 ${cfg.commentMaxChars} 个字符`);
    }
    if (/@\{uin:/i.test(content)) fail('评论正文不能直接包含 QQ 原生回复标记');
    if (['comment', 'like_comment'].includes(action) && !content) fail('评论内容不能为空');
    if (['skip', 'like'].includes(action) && content) fail('不评论时 content 必须为空');
    seenFeed.add(id);
    return { id, action, content, reason: cleanText(item?.reason, 200) };
  });
  const replyActions = raw.replyActions.map((item) => {
    const id = String(item?.id || '');
    const action = String(item?.action || '');
    if (!replyIds.has(id) || seenReply.has(id)) fail('replyActions 含未知或重复 id');
    if (!['skip', 'reply'].includes(action)) fail('评论回复 action 必须为 skip 或 reply');
    if (!cfg.allowReplies && action === 'reply') fail('当前设置不允许回复评论');
    const content = cleanText(item?.content, 1000);
    if (content.length > cfg.replyMaxChars) {
      fail(`回复不能超过 ${cfg.replyMaxChars} 个字符`);
    }
    if (/@\{uin:/i.test(content)) fail('回复正文不能直接包含 QQ 原生回复标记');
    if (action === 'reply' && !content) fail('回复内容不能为空');
    if (action === 'skip' && content) fail('不回复时 content 必须为空');
    seenReply.add(id);
    return { id, action, content, reason: cleanText(item?.reason, 200) };
  });
  if (seenFeed.size !== feedIds.size || seenReply.size !== replyIds.size) {
    fail('必须为本批次每个条目提交一次决定');
  }
  const counts = actionCounts({ feedActions, replyActions });
  if (counts.likes > cfg.maxLikesPerRun) fail(`本轮点赞不能超过 ${cfg.maxLikesPerRun} 条`);
  if (counts.comments > cfg.maxCommentsPerRun) fail(`本轮评论不能超过 ${cfg.maxCommentsPerRun} 条`);
  if (counts.replies > cfg.maxRepliesPerRun) fail(`本轮回复不能超过 ${cfg.maxRepliesPerRun} 条`);
  return { feedActions, replyActions };
}

function publicPost(post) {
  return {
    author: post.nickname || '好友',
    time: post.time,
    content: cleanText(post.content, 1200),
    imageCount: post.images?.length || 0,
    commentCount: post.comments?.length || 0,
    alreadyLiked: post.isLiked === true,
    recentComments: (post.comments || []).slice(-8).map((comment) => ({
      author: comment.nickname || '好友',
      content: cleanText(comment.content, 300)
    }))
  };
}

function publicReply(item) {
  return {
    author: item.comment.nickname || '好友',
    time: item.comment.time || item.discoveredAt,
    content: cleanText(item.comment.content, 500),
    post: {
      author: item.post.nickname || '好友',
      content: cleanText(item.post.content, 800)
    },
    thread: (item.context || []).slice(-10).map((comment) => ({
      author: comment.nickname || '好友',
      content: cleanText(comment.content, 300),
      self: comment.self === true
    }))
  };
}

function publicRunDetails(run, state) {
  const feeds = new Map(state.feeds.map((item) => [item.key, item]));
  const comments = new Map(state.comments.map((item) => [item.key, item]));
  const details = new Map();
  for (const action of run.actions || []) {
    const kind = action.type === 'reply' ? 'reply' : 'feed';
    let detail = details.get(action.key);
    if (!detail) {
      const item = kind === 'reply' ? comments.get(action.key) : feeds.get(action.key);
      if (kind === 'reply' && item) {
        const reply = publicReply(item);
        detail = {
          kind,
          post: reply.post,
          comment: {
            author: reply.author,
            time: reply.time,
            content: reply.content
          },
          thread: reply.thread,
          decision: item.decision || '',
          response: item.replyContent || '',
          reason: item.reason || '',
          operations: []
        };
      } else {
        detail = {
          kind,
          ...(item ? {
            post: publicPost(item.post),
            decision: item.decision || '',
            response: item.commentContent || '',
            reason: item.reason || ''
          } : {}),
          operations: []
        };
      }
      details.set(action.key, detail);
    }
    detail.operations.push({
      type: action.type,
      status: action.status,
      ...(action.error ? { error: cleanText(action.error, 300) } : {})
    });
  }
  return [...details.values()];
}

export class QzoneInteractionManager {
  constructor({
    onebot,
    sessions = null,
    emit = null,
    complete = chatCompletionWithRetry,
    qzoneWeb = null,
    setProactiveSuppressed = () => {},
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    random = Math.random,
    log = console.log,
    stateFile = STATE_FILE
  }) {
    this.onebot = onebot;
    this.sessions = sessions;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.complete = complete;
    this.qzoneWeb = qzoneWeb || new QzoneWebClient(onebot);
    this.setProactiveSuppressed = setProactiveSuppressed;
    this.sleep = sleep;
    this.now = now;
    this.random = random;
    this.log = log;
    this.stateFile = stateFile;
    this.state = normalizeState(readJson(stateFile, defaultState()));
    this.timer = null;
    this.nextRunAt = 0;
    this.running = null;
    this.task = null;
    this.controller = null;
    this.stopped = true;
    let recovered = false;
    for (const list of [this.state.feeds, this.state.comments]) {
      for (const item of list) {
        if (item.status !== 'acting') continue;
        item.status = 'unknown';
        item.error = '外部写入期间服务中断，结果不明，不会自动重试';
        item.updatedAt = this.now();
        recovered = true;
      }
    }
    for (const run of this.state.runs) {
      if (run.status !== 'running') continue;
      run.status = 'interrupted';
      run.error = '任务执行期间服务中断';
      run.endedAt = this.now();
      recovered = true;
    }
    if (recovered) this.#save();
  }

  status() {
    const cfg = normalizedConfig();
    return {
      enabled: cfg.enabled,
      running: Boolean(this.running),
      task: this.task,
      nextRunAt: this.nextRunAt,
      lastFeedPollAt: this.state.lastFeedPollAt,
      lastReplyPollAt: this.state.lastReplyPollAt,
      unreadFeeds: this.state.feeds.filter((item) => item.status === 'unread').length,
      unreadReplies: this.state.comments.filter((item) => item.status === 'unread').length,
      uncertain: [...this.state.feeds, ...this.state.comments]
        .filter((item) => item.status === 'unknown').length,
      records: this.state.runs.slice(0, 20).map((run) => ({
        ...run,
        details: publicRunDetails(run, this.state)
      }))
    };
  }

  start() {
    this.stop();
    if (!normalizedConfig().enabled) return;
    this.stopped = false;
    this.#schedule(15000);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = 0;
  }

  async abort() {
    const running = this.running;
    this.controller?.abort(new Error('Qzone interaction task stopped'));
    if (!running) return;
    await Promise.race([
      running.catch(() => {}),
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        timer.unref?.();
      })
    ]);
  }

  reconfigure() {
    if (normalizedConfig().enabled) this.start();
    else {
      this.stop();
      this.abort().catch(() => {});
    }
  }

  async runNow(kind = 'all') {
    if (!['all', 'feed', 'reply'].includes(kind)) {
      throw interactionError('QZONE_INTERACTION_KIND_INVALID', 'kind 必须为 all、feed 或 reply', 400);
    }
    return this.#exclusive(`manual-${kind}`, () =>
      this.#run({ kind, source: 'manual', includeExisting: true })
    );
  }

  async #exclusive(task, execute) {
    if (this.running) throw interactionError('QZONE_INTERACTION_BUSY', '已有动态互动任务正在执行');
    assertTimeAllowed('');
    this.task = task;
    this.controller = new AbortController();
    this.setProactiveSuppressed(true);
    this.running = withTimeScope('', execute).finally(() => {
      this.running = null;
      this.task = null;
      this.controller = null;
      this.setProactiveSuppressed(false);
      this.emit('qzone-interactions-status', this.status());
    });
    this.emit('qzone-interactions-status', this.status());
    return this.running;
  }

  #schedule(delay = 60000) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.nextRunAt = this.now() + Math.max(1000, Number(delay) || 1000);
    this.timer = setTimeout(() => {
      this.#tick().catch((error) =>
        this.log('[qzone-interactions] scheduler error:', error?.message ?? error));
    }, Math.max(1000, Number(delay) || 1000));
    this.timer.unref?.();
  }

  async #tick() {
    if (this.stopped) return;
    const cfg = normalizedConfig();
    const now = this.now();
    const time = timeControlState(getConfig().timeControl, '', now);
    if (!time.active) {
      this.#schedule(time.nextActiveAt ? time.nextActiveAt - now + 1 : 60000);
      return;
    }
    if (this.running) {
      this.#schedule(60000);
      return;
    }
    const feedDue = !this.state.lastFeedPollAt
      || now - this.state.lastFeedPollAt >= cfg.feedIntervalMinutes * 60000;
    const replyDue = !this.state.lastReplyPollAt
      || now - this.state.lastReplyPollAt >= cfg.replyIntervalMinutes * 60000;
    if (feedDue || replyDue) {
      try {
        await this.#exclusive('scheduled', () => this.#run({
          kind: feedDue && replyDue ? 'all' : (feedDue ? 'feed' : 'reply'),
          source: 'scheduled',
          includeExisting: cfg.startupCatchup
        }));
      } catch (error) {
        this.log('[qzone-interactions] run failed:', error?.message ?? error);
      }
    }
    if (!this.stopped) {
      const nextFeed = this.state.lastFeedPollAt + cfg.feedIntervalMinutes * 60000;
      const nextReply = this.state.lastReplyPollAt + cfg.replyIntervalMinutes * 60000;
      this.#schedule(Math.max(1000, Math.min(nextFeed, nextReply) - this.now()));
    }
  }

  #save() {
    this.#prune();
    writeJson(this.stateFile, this.state);
    this.emit('qzone-interactions-status', this.status());
  }

  #prune() {
    const cutoff = this.now() - 30 * 24 * HOUR_MS;
    const trim = (items) => items
      .filter((item) => item.status === 'unread' || item.status === 'unknown'
        || Number(item.updatedAt || item.discoveredAt) >= cutoff)
      .sort((a, b) => Number(b.discoveredAt) - Number(a.discoveredAt))
      .slice(0, MAX_STATE_ITEMS);
    this.state.feeds = trim(this.state.feeds);
    this.state.comments = trim(this.state.comments);
    this.state.watchedPosts = this.state.watchedPosts
      .filter((post) => Number(post.updatedAt) >= cutoff)
      .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
      .slice(0, 100);
    this.state.runs = this.state.runs.slice(0, 90);
  }

  #watchPost(post, patch = {}) {
    const key = qzonePostKey(post);
    const existing = this.state.watchedPosts.find((item) => item.key === key);
    const suppliedCommentCount = post.commentCount ?? post.comments?.length;
    const value = {
      key,
      uin: String(post.uin),
      tid: String(post.tid),
      nickname: cleanText(post.nickname || existing?.nickname, 80),
      content: cleanText(post.content || existing?.content, 1200),
      time: Number(post.time || existing?.time) || 0,
      commentCount: suppliedCommentCount == null
        ? (Number(existing?.commentCount) || 0)
        : (Number(suppliedCommentCount) || 0),
      updatedAt: this.now(),
      ...patch
    };
    if (existing) Object.assign(existing, value);
    else this.state.watchedPosts.push(value);
  }

  #queueComments(post) {
    const selfId = String(this.onebot.selfId || '');
    const roots = new Map((post.comments || [])
      .filter((comment) => !comment.parentTid)
      .map((comment) => [String(comment.tid || comment.commentId), comment]));
    for (const comment of post.comments || []) {
      if (!comment.uin || String(comment.uin) === selfId) continue;
      const root = roots.get(String(comment.parentTid || ''));
      const directedToSelf = String(comment.targetUin || '') === selfId
        || String(root?.uin || '') === selfId;
      const eligible = (!comment.parentTid && String(post.uin) === selfId) || directedToSelf;
      if (!eligible) continue;
      const key = qzoneCommentKey(post, comment);
      if (this.state.comments.some((item) => item.key === key)) continue;
      this.state.comments.push({
        key,
        status: 'unread',
        discoveredAt: this.now(),
        updatedAt: this.now(),
        post: {
          uin: String(post.uin),
          tid: String(post.tid),
          nickname: cleanText(post.nickname, 80),
          content: cleanText(post.content, 1200),
          time: Number(post.time) || 0
        },
        comment: { ...comment },
        rootComment: root ? { ...root } : (!comment.parentTid ? { ...comment } : null),
        context: (post.comments || []).map((item) => ({
          ...item,
          self: String(item.uin) === selfId
        }))
      });
    }
  }

  async #discoverFeeds(cfg, signal) {
    const data = await this.onebot.call(
      'get_qzone_feeds',
      { page_num: 1, count: cfg.feedFetchCount },
      30000,
      signal
    );
    if (!Array.isArray(data?.feeds)) throw new Error('好友动态接口返回格式无效');
    const cutoff = Math.floor((this.now() - cfg.maxAgeHours * HOUR_MS) / 1000);
    let discovered = 0;
    for (const raw of data.feeds) {
      const post = parseQzoneFeed(raw);
      if (post.appid !== 311 || !post.tid || !post.uin || post.time < cutoff) continue;
      if (post.uin === String(this.onebot.selfId || '')) {
        this.#watchPost(post);
        this.#queueComments(post);
        continue;
      }
      const key = qzonePostKey(post);
      const existing = this.state.feeds.find((item) => item.key === key);
      if (existing) {
        existing.post = post;
        existing.updatedAt = this.now();
      } else {
        this.state.feeds.push({
          key,
          status: 'unread',
          discoveredAt: this.now(),
          updatedAt: this.now(),
          post
        });
        discovered += 1;
      }
      if (this.state.watchedPosts.some((item) => item.key === key)) this.#queueComments(post);
    }
    this.state.lastFeedPollAt = this.now();
    return discovered;
  }

  async #discoverReplies(cfg, signal) {
    const selfId = String(this.onebot.selfId || '');
    if (!selfId) throw new Error('无法确认当前登录 QQ');
    const own = await this.onebot.call(
      'get_qzone_msg_list',
      { target_uin: Number(selfId), pos: 0, num: cfg.ownPostCount },
      30000,
      signal
    );
    if (!Array.isArray(own?.msglist)) throw new Error('自己的动态列表返回格式无效');
    const candidates = new Map();
    for (const item of own.msglist) {
      const post = {
        uin: selfId,
        tid: String(item.tid || ''),
        nickname: this.onebot.selfNickname || getConfig().persona?.botName || '我',
        content: cleanText(item.content, 1200),
        time: Number(item.time) || 0,
        commentCount: Number(item.comment_num) || 0
      };
      if (!post.tid) continue;
      const previous = this.state.watchedPosts.find((watch) => watch.key === qzonePostKey(post));
      this.#watchPost(post, { own: true });
      if (post.commentCount > 0
        && Number(previous?.scannedCommentCount) !== post.commentCount) {
        candidates.set(qzonePostKey(post), post);
      }
    }
    for (const watched of this.state.watchedPosts) {
      if (!watched.tid || !watched.uin) continue;
      const ageMs = this.now() - Number(watched.time) * 1000;
      if (ageMs > cfg.maxAgeHours * HOUR_MS) continue;
      if (candidates.has(watched.key)) continue;
      if (watched.own && !watched.conversationActive) {
        if (Number(watched.commentCount) <= 0
          || Number(watched.scannedCommentCount) === Number(watched.commentCount)) continue;
      } else {
        const interval = ageMs < 6 * HOUR_MS
          ? cfg.replyIntervalMinutes * 60000
          : (ageMs < 24 * HOUR_MS ? 30 * 60000 : 2 * HOUR_MS);
        if (this.now() - Number(watched.lastDetailPollAt || 0) < interval) continue;
      }
      candidates.set(watched.key, { ...watched });
    }
    let discovered = 0;
    for (const post of [...candidates.values()]
      .sort((a, b) => Number(b.time) - Number(a.time))
      .slice(0, 20)) {
      signal?.throwIfAborted();
      try {
        const detail = await this.qzoneWeb.getPostDetail(post.uin, post.tid, signal);
        const before = this.state.comments.length;
        this.#queueComments({ ...post, ...detail });
        discovered += this.state.comments.length - before;
        this.#watchPost(
          { ...post, ...detail },
          {
            scannedCommentCount: Number(detail.commentCount) || detail.comments?.length || 0,
            lastDetailPollAt: this.now()
          }
        );
      } catch (error) {
        const watched = this.state.watchedPosts.find((item) => item.key === qzonePostKey(post));
        if (watched) {
          watched.lastDetailPollAt = this.now();
          watched.lastError = cleanText(error?.message ?? error, 300);
        }
      }
    }
    this.state.lastReplyPollAt = this.now();
    return discovered;
  }

  #batch(kind, cfg) {
    const feeds = kind === 'reply' ? [] : this.state.feeds
      .filter((item) => item.status === 'unread')
      .sort((a, b) => Number(b.post?.time || b.discoveredAt) - Number(a.post?.time || a.discoveredAt));
    const replies = kind === 'feed' ? [] : this.state.comments
      .filter((item) => item.status === 'unread')
      .sort((a, b) => Number(b.comment?.time || b.discoveredAt) - Number(a.comment?.time || a.discoveredAt));
    const candidates = [
      ...replies.map((item) => ({ type: 'reply', item })),
      ...feeds.map((item) => ({ type: 'feed', item }))
    ].slice(0, cfg.maxBatchItems);
    const root = getConfig();
    const systemPrompt = buildQzoneInteractionPrompt(root.persona);
    const tools = openAiTools([this.#submitToolDef([], [], cfg)]);
    const hardLimit = Math.min(
      Math.max(16000, Number(root.api?.contextWindowTokens) || 1000000),
      Math.max(20000, Number(root.api?.maxRunTokens) || 160000)
    );
    const budget = Math.max(4000, hardLimit - 8192);
    const selected = [];
    let estimatedTokens = estimateQzoneTokens(systemPrompt) + estimateQzoneTokens(tools) + 500;
    for (const candidate of candidates) {
      const publicItem = candidate.type === 'feed'
        ? publicPost(candidate.item.post)
        : publicReply(candidate.item);
      const cost = estimateQzoneTokens(publicItem) + 80;
      if (estimatedTokens + cost > budget) break;
      selected.push({ ...candidate, publicItem });
      estimatedTokens += cost;
    }
    return {
      feeds: selected.filter((item) => item.type === 'feed')
        .map((item, index) => ({ id: `feed-${index + 1}`, state: item.item, data: item.publicItem })),
      replies: selected.filter((item) => item.type === 'reply')
        .map((item, index) => ({ id: `reply-${index + 1}`, state: item.item, data: item.publicItem })),
      deferredFeeds: feeds.length - selected.filter((item) => item.type === 'feed').length,
      deferredReplies: replies.length - selected.filter((item) => item.type === 'reply').length,
      estimatedTokens,
      budget
    };
  }

  #submitToolDef(feeds, replies, cfg) {
    return {
      name: 'submit_qzone_interactions',
      description: '提交本批好友动态互动和评论回复决定。',
      parameters: {
        type: 'object',
        properties: {
          feedActions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                action: { type: 'string', enum: ['skip', 'like', 'comment', 'like_comment'] },
                content: { type: 'string', maxLength: cfg.commentMaxChars },
                reason: { type: 'string' }
              },
              required: ['id', 'action', 'content', 'reason']
            }
          },
          replyActions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                action: { type: 'string', enum: ['skip', 'reply'] },
                content: { type: 'string', maxLength: cfg.replyMaxChars },
                reason: { type: 'string' }
              },
              required: ['id', 'action', 'content', 'reason']
            }
          }
        },
        required: ['feedActions', 'replyActions']
      },
      execute: async (args) => ({
        content: JSON.stringify({
          accepted: true,
          counts: actionCounts(sanitizePlan(args, { feeds, replies }, cfg))
        })
      })
    };
  }

  async #decide(batch, cfg, session, signal) {
    const root = getConfig();
    const systemPrompt = buildQzoneInteractionPrompt(root.persona);
    const defs = [this.#submitToolDef(batch.feeds, batch.replies, cfg)];
    const tools = openAiTools(defs);
    const userPrompt = [
      '以下条目是本轮能够放入上下文的全部未阅览项目，已按优先级和时间从新到旧排列。',
      `本轮最多点赞 ${cfg.maxLikesPerRun} 条、评论 ${cfg.maxCommentsPerRun} 条、回复 ${cfg.maxRepliesPerRun} 条。`,
      '【好友动态】',
      JSON.stringify(batch.feeds.map((item) => ({ id: item.id, ...item.data }))),
      '【待回复评论】',
      JSON.stringify(batch.replies.map((item) => ({ id: item.id, ...item.data })))
    ].join('\n\n');
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
    const usage = emptyUsage();
    let finalPlan = null;
    if (session) {
      session.systemPrompt = systemPrompt;
      session.userPrompt = userPrompt;
      session.promptLayout = QZONE_INTERACTION_PROMPT_VERSION;
      session.promptChars = systemPrompt.length + userPrompt.length;
      session.inputTools = structuredClone(tools);
      session.inputRequestOptions = { toolChoice: 'auto', temperature: 1 };
      this.sessions.update(session.id);
    }
    for (let round = 0; round < cfg.maxDecisionRounds && !finalPlan; round++) {
      signal.throwIfAborted();
      assertTimeAllowed('');
      if (session) {
        session.inputRound = round + 1;
        session.inputMessages = structuredClone(messages);
        session.inputPayloadChars = JSON.stringify({ messages, tools }).length;
        session.activity = '正在阅览空间动态…';
        this.sessions.update(session.id);
      }
      const response = await this.complete({
        messages,
        tools,
        // DeepSeek thinking mode rejects named/required tool choices.
        // The prompt and finalPlan validation still require this sole submit tool.
        toolChoice: 'auto',
        temperature: 1,
        signal,
        cacheKey: `qq-agent:qzone-interactions:${qzoneInteractionPersonaHash(root.persona).slice(0, 24)}`
      });
      addUsage(usage, response.usage);
      usage.calls += 1;
      const message = response.message || {};
      const assistant = {
        role: 'assistant',
        content: typeof message.content === 'string' ? message.content : null,
        ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
        ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {})
      };
      messages.push(assistant);
      if (session) {
        session.messages.push({ ...structuredClone(assistant), raw: response.raw ?? null });
        session.model = response.model || session.model;
        session.rounds = round + 1;
        session.usage = { ...usage };
        session.callUsage ||= [];
        const promptTokens = Number(response.usage?.prompt_tokens) || 0;
        const cachedTokens = Math.min(promptTokens, cachedTokensOfUsage(response.usage));
        session.callUsage.push({
          round: round + 1,
          promptTokens,
          cachedTokens,
          cacheHitRate: promptTokens ? cachedTokens / promptTokens : 0,
          completionTokens: Number(response.usage?.completion_tokens) || 0,
          totalTokens: Number(response.usage?.total_tokens) || 0
        });
      }
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!calls.length) {
        messages.push({
          role: 'user',
          content: '必须调用 submit_qzone_interactions，不能只输出文本。'
        });
        continue;
      }
      for (const call of calls) {
        const name = String(call?.function?.name || '');
        let args = null;
        let result = '';
        let isError = false;
        if (name !== 'submit_qzone_interactions') {
          result = `错误：未知工具 ${name || '(空名称)'}`;
          isError = true;
        } else if (finalPlan) {
          result = '错误：本轮已经提交过有效决定';
          isError = true;
        } else {
          try {
            args = JSON.parse(String(call?.function?.arguments || '{}'));
            finalPlan = sanitizePlan(args, batch, cfg);
            result = JSON.stringify({ accepted: true, counts: actionCounts(finalPlan) });
          } catch (error) {
            result = `错误：${error instanceof SyntaxError
              ? '工具参数不是合法 JSON，请修正后重新提交'
              : error.message}`;
            isError = true;
          }
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name,
          content: result
        });
        if (session) {
          session.messages.push({
            toolCall: {
              name,
              args,
              result,
              isError
            }
          });
        }
      }
      if (session) {
        session.activity = '';
        this.sessions.update(session.id);
        this.emit('session-update', { sessionId: session.id });
      }
    }
    if (!finalPlan) throw interactionError(
      'QZONE_INTERACTION_DECISION_INVALID',
      '模型未在轮次预算内提交有效互动决定',
      422
    );
    return { plan: finalPlan, usage, model: session?.model || root.api?.model || '' };
  }

  #findRoot(item) {
    if (item.rootComment) return item.rootComment;
    if (!item.comment.parentTid) return item.comment;
    return (item.context || []).find((comment) =>
      !comment.parentTid
      && String(comment.tid || comment.commentId) === String(item.comment.parentTid)
    ) || null;
  }

  async #pauseBetweenActions(cfg, count) {
    if (!count) return;
    const min = Math.min(cfg.actionDelayMinMs, cfg.actionDelayMaxMs);
    const max = Math.max(cfg.actionDelayMinMs, cfg.actionDelayMaxMs);
    const ms = Math.round(min + this.random() * (max - min));
    if (ms > 0) await this.sleep(ms);
  }

  async #executePlan(plan, batch, cfg, signal, run) {
    const feedMap = new Map(batch.feeds.map((item) => [item.id, item.state]));
    const replyMap = new Map(batch.replies.map((item) => [item.id, item.state]));
    let writes = 0;
    for (const action of plan.replyActions) {
      const item = replyMap.get(action.id);
      item.decision = action.action;
      item.reason = action.reason;
      item.updatedAt = this.now();
      if (action.action === 'skip') {
        item.status = 'reviewed';
        continue;
      }
      await this.#pauseBetweenActions(cfg, writes++);
      item.status = 'acting';
      item.replyContent = action.content;
      this.#save();
      try {
        const result = await this.qzoneWeb.replyComment({
          ownerUin: item.post.uin,
          tid: item.post.tid,
          comment: item.comment,
          rootComment: this.#findRoot(item),
          content: action.content,
          signal
        });
        item.status = 'replied';
        item.replyCommentId = result.commentId || '';
        item.updatedAt = this.now();
        this.#watchPost(item.post, {
          conversationActive: true,
          lastDetailPollAt: this.now()
        });
        run.actions.push({ type: 'reply', key: item.key, status: 'done' });
      } catch (error) {
        item.status = 'unknown';
        item.error = cleanText(error?.message ?? error, 500);
        item.updatedAt = this.now();
        run.actions.push({ type: 'reply', key: item.key, status: 'unknown', error: item.error });
      }
      this.#save();
    }
    for (const action of plan.feedActions) {
      const item = feedMap.get(action.id);
      item.decision = action.action;
      item.reason = action.reason;
      item.updatedAt = this.now();
      if (action.action === 'skip') {
        item.status = 'reviewed';
        continue;
      }
      const wantsComment = action.action === 'comment' || action.action === 'like_comment';
      const wantsLike = action.action === 'like' || action.action === 'like_comment';
      item.status = 'acting';
      item.commentContent = action.content;
      this.#save();
      if (wantsComment) {
        await this.#pauseBetweenActions(cfg, writes++);
        try {
          const result = await this.onebot.call('comment_qzone', {
            tid: item.post.tid,
            target_uin: Number(item.post.uin),
            content: action.content
          }, 30000, signal);
          item.commentStatus = 'done';
          item.commentId = String(result?.comment_id || '');
          this.#watchPost(item.post, { ownComment: action.content });
          run.actions.push({ type: 'comment', key: item.key, status: 'done' });
        } catch (error) {
          item.commentStatus = 'unknown';
          item.status = 'unknown';
          item.error = cleanText(error?.message ?? error, 500);
          run.actions.push({ type: 'comment', key: item.key, status: 'unknown', error: item.error });
          this.#save();
          continue;
        }
      }
      if (wantsLike && !item.post.isLiked) {
        await this.#pauseBetweenActions(cfg, writes++);
        try {
          await this.onebot.call('like_qzone', {
            tid: item.post.tid,
            target_uin: Number(item.post.uin),
            abstime: Number(item.post.time) || 0
          }, 30000, signal);
          item.likeStatus = 'done';
          run.actions.push({ type: 'like', key: item.key, status: 'done' });
        } catch (error) {
          item.likeStatus = 'unknown';
          item.status = 'unknown';
          item.error = cleanText(error?.message ?? error, 500);
          run.actions.push({ type: 'like', key: item.key, status: 'unknown', error: item.error });
          this.#save();
          continue;
        }
      }
      item.status = 'reviewed';
      item.updatedAt = this.now();
      this.#save();
    }
  }

  #finishSession(session, run, error = null) {
    if (!session || !this.sessions?.current?.has(session.id)) return;
    session.usage = { ...run.usage };
    session.model = run.model || session.model;
    session.finishReason = error ? run.error : `动态 ${run.selectedFeeds}，回复 ${run.selectedReplies}`;
    session.outcome = {
      sent: run.actions.filter((action) => action.status === 'done').length,
      finishReason: session.finishReason
    };
    if (error) session.error = run.error;
    this.sessions.update(session.id);
    this.sessions.finish(session.id, error ? 'error' : 'done');
    this.emit('session-end', { sessionId: session.id, chatKey: session.chatKey });
  }

  async #run({ kind, source, includeExisting }) {
    const cfg = normalizedConfig();
    const run = {
      id: crypto.randomUUID(),
      source,
      kind,
      status: 'running',
      startedAt: this.now(),
      endedAt: 0,
      discoveredFeeds: 0,
      discoveredReplies: 0,
      selectedFeeds: 0,
      selectedReplies: 0,
      deferredFeeds: 0,
      deferredReplies: 0,
      actions: [],
      usage: emptyUsage(),
      model: '',
      error: ''
    };
    this.state.runs.unshift(run);
    this.#save();
    const release = watchTimeWindow((error) => this.controller?.abort(error), '');
    let session = null;
    try {
      if (kind === 'all' || kind === 'feed') {
        run.discoveredFeeds = await this.#discoverFeeds(cfg, this.controller.signal);
      }
      if (kind === 'all' || kind === 'reply') {
        run.discoveredReplies = await this.#discoverReplies(cfg, this.controller.signal);
      }
      const baselineFeed = !this.state.feedInitializedAt && (kind === 'all' || kind === 'feed');
      const baselineReply = !this.state.replyInitializedAt && (kind === 'all' || kind === 'reply');
      if (baselineFeed) this.state.feedInitializedAt = this.now();
      if (baselineReply) this.state.replyInitializedAt = this.now();
      if (source === 'scheduled' && !includeExisting && (baselineFeed || baselineReply)) {
        if (baselineFeed) {
          for (const item of this.state.feeds) if (item.status === 'unread') item.status = 'baseline';
        }
        if (baselineReply) {
          for (const item of this.state.comments) if (item.status === 'unread') item.status = 'baseline';
        }
        run.status = 'baseline';
        run.endedAt = this.now();
        this.#save();
        return { ok: true, run };
      }
      const batch = this.#batch(kind, cfg);
      run.selectedFeeds = batch.feeds.length;
      run.selectedReplies = batch.replies.length;
      run.deferredFeeds = batch.deferredFeeds;
      run.deferredReplies = batch.deferredReplies;
      run.estimatedInputTokens = batch.estimatedTokens;
      run.inputBudgetTokens = batch.budget;
      if (!batch.feeds.length && !batch.replies.length) {
        run.status = 'idle';
        run.endedAt = this.now();
        this.#save();
        return { ok: true, run };
      }
      session = this.sessions?.create({
        chatKey: 'system:qzone-interactions',
        trigger: 'qzone-interactions',
        triggerSummary: kind === 'reply' ? '检查空间评论回复' : '阅览好友动态'
      }) || null;
      if (session) {
        run.sessionId = session.id;
        session.chatName = '动态互动';
        session.model = getConfig().api?.model || '';
        session.conversationMode = 'legacy';
      }
      const decided = await this.#decide(batch, cfg, session, this.controller.signal);
      run.usage = decided.usage;
      run.model = decided.model;
      run.plan = decided.plan;
      for (const item of [...batch.feeds, ...batch.replies]) {
        item.state.status = 'reviewed';
        item.state.reviewedAt = this.now();
        item.state.updatedAt = this.now();
      }
      this.#save();
      await this.#executePlan(decided.plan, batch, cfg, this.controller.signal, run);
      run.status = run.actions.some((action) => action.status === 'unknown')
        ? 'partial-unknown'
        : 'done';
      run.endedAt = this.now();
      this.#save();
      this.#finishSession(session, run);
      return { ok: true, run };
    } catch (error) {
      run.status = error?.code === 'TIME_CONTROL_INACTIVE' ? 'deferred' : 'failed';
      run.error = cleanText(error?.message ?? error, 1000);
      run.endedAt = this.now();
      if (session) {
        run.usage = { ...session.usage };
        run.model = session.model || run.model;
      }
      this.#save();
      this.#finishSession(session, run, error);
      throw error;
    } finally {
      release();
    }
  }
}
