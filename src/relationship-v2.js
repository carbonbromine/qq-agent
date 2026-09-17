import fs from 'node:fs';
import { chatCompletionWithRetry, cachedTokensOfUsage } from './llm.js';
import { shanghaiDayStart } from './util.js';
import { normalizeRelationshipV2Config, relationshipV2Enabled } from './relationship-v2-config.js';
import {
  RelationshipV2Store,
  relationshipV2DatabasePath,
  RELATIONSHIP_V2_EVALUATOR_VERSION,
  RELATIONSHIP_V2_REDUCER_VERSION,
  RELATIONSHIP_V2_POLICY_VERSION
} from './relationship-v2-store.js';
import {
  buildRelationshipV2SystemPrompt,
  buildRelationshipV2UserPrompt,
  personaRelationshipProfile,
  RELATIONSHIP_V2_EVENT_TOOL,
  RELATIONSHIP_V2_EVENT_TYPES
} from './relationship-v2-prompt.js';

const EVENT_TYPES = new Set(RELATIONSHIP_V2_EVENT_TYPES);
const clean = (value, max = 240) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function usageOf(response) {
  const usage = response?.usage || {};
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const cachedTokens = Math.min(promptTokens, cachedTokensOfUsage(usage));
  return {
    promptTokens,
    completionTokens: Number(usage.completion_tokens) || 0,
    totalTokens: Number(usage.total_tokens) || 0,
    cachedTokens,
    calls: 1
  };
}

export function parseRelationshipV2Response(response, evidence = [], personaBasisIds = []) {
  const calls = Array.isArray(response?.message?.tool_calls) ? response.message.tool_calls : [];
  if (calls.length !== 1 || calls[0]?.function?.name !== 'submit_relationship_v2_events') {
    throw new Error('V2 关系评估未提交唯一的结构化结果');
  }
  let value;
  try { value = JSON.parse(String(calls[0].function.arguments || '{}')); }
  catch { throw new Error('V2 关系评估结果不是有效 JSON'); }
  if (!Array.isArray(value?.events) || value.events.length > 4) {
    throw new Error('V2 关系事件必须是最多 4 项的数组');
  }
  const allowed = new Map(evidence
    .filter((item) => item.countableEvidence === true)
    .map((item) => [String(item.evidenceId), item]));
  const allowedPersonaBasis = new Set(personaBasisIds.map(String));
  const events = value.events.map((raw) => {
    const type = String(raw?.type || '');
    if (!EVENT_TYPES.has(type)) throw new Error(`未知 V2 关系事件：${type}`);
    const strength = Number(raw?.strength);
    const confidence = Number(raw?.confidence);
    if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('事件 strength 越界');
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('事件 confidence 越界');
    const evidenceIds = [...new Set((raw?.evidenceIds || []).map(String).filter(Boolean))];
    if (!evidenceIds.length || evidenceIds.some((id) => !allowed.has(id))) {
      throw new Error('事件引用了不可计数或不存在的证据');
    }
    const basisIds = [...new Set((raw?.personaBasisIds || []).map(String).filter(Boolean))].slice(0, 6);
    if (basisIds.some((id) => !allowedPersonaBasis.has(id))) {
      throw new Error('事件引用了不存在的人格依据');
    }
    return {
      type,
      strength,
      confidence,
      durableEligible: raw?.durableEligible === true,
      evidenceIds,
      sourceChatKeys: [...new Set(evidenceIds.map((id) => allowed.get(id)?.chatKey).filter(Boolean))],
      personaBasisIds: basisIds,
      summary: clean(raw?.summary, 240)
    };
  });
  return { events, noChangeReason: clean(value?.noChangeReason, 300) };
}

export function inactiveRelationshipV2Status({ enabled = false, error = '' } = {}) {
  return {
    enabled: Boolean(enabled), active: false, shadowMode: true,
    behaviorInjectionEnabled: false, error: String(error || ''),
    database: 'relationship-v2.sqlite',
    counts: { states: 0, events: 0, queuedJobs: 0, failedJobs: 0 },
    evaluatorVersion: RELATIONSHIP_V2_EVALUATOR_VERSION,
    reducerVersion: RELATIONSHIP_V2_REDUCER_VERSION,
    policyVersion: RELATIONSHIP_V2_POLICY_VERSION
  };
}

export class RelationshipV2Manager {
  constructor({
    dataDir,
    config,
    evidenceProvider,
    personProvider = null,
    complete = chatCompletionWithRetry,
    emit = null,
    log = console.log,
    now = Date.now
  } = {}) {
    this.dataDir = dataDir;
    this.config = config;
    this.evidenceProvider = evidenceProvider;
    this.personProvider = typeof personProvider === 'function' ? personProvider : (() => null);
    this.complete = complete;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.log = log;
    this.now = now;
    this.store = null;
    this.active = false;
    this.running = false;
    this.queue = Promise.resolve();
    this.generation = 1;
    this.currentAbortController = null;
    this.lastError = '';
  }

  settings() {
    const cfg = this.config?.() || {};
    return normalizeRelationshipV2Config(cfg.relationshipV2 || {});
  }

  start() {
    if (!relationshipV2Enabled(this.config?.() || {})) return this.status();
    this.store ||= new RelationshipV2Store({ dataDir: this.dataDir });
    this.store.recoverInterruptedJobs();
    this.active = true;
    this.lastError = '';
    this.#scheduleDrain();
    return this.status();
  }

  openExisting() {
    if (!this.store && fs.existsSync(relationshipV2DatabasePath(this.dataDir))) {
      this.store = new RelationshipV2Store({ dataDir: this.dataDir });
    }
    this.active = false;
    return this.status();
  }

  async stop() {
    this.active = false;
    this.generation += 1;
    this.currentAbortController?.abort(new Error('关系 V2 已停用'));
    try { await this.queue; } catch { /* job is already audited */ }
    this.running = false;
    this.currentAbortController = null;
    this.store?.close();
    this.store = null;
  }

  status() {
    const settings = this.settings();
    return {
      enabled: settings.enabled,
      active: this.active,
      shadowMode: !settings.behaviorInjectionEnabled,
      behaviorInjectionEnabled: this.active && settings.behaviorInjectionEnabled,
      error: this.lastError,
      database: 'relationship-v2.sqlite',
      counts: this.store?.counts() || { states: 0, events: 0, queuedJobs: 0, failedJobs: 0 },
      runningJobs: this.running ? 1 : 0,
      evaluatorVersion: RELATIONSHIP_V2_EVALUATOR_VERSION,
      reducerVersion: RELATIONSHIP_V2_REDUCER_VERSION,
      policyVersion: RELATIONSHIP_V2_POLICY_VERSION,
      settings
    };
  }

  observeMessage(chatKey, message) {
    if (!this.active) return false;
    const settings = this.settings();
    if (!settings.autoEvaluationEnabled) return false;
    const uin = String(message?.senderId || '').trim();
    if (message?.self || !/^\d{1,15}$/.test(uin)) return false;
    const selfId = String(this.config?.()?.onebot?.selfId || '');
    const direct = String(chatKey).startsWith('private:')
      || message?.mentionsSelf === true
      || (selfId && String(message?.reply?.senderId || '') === selfId);
    if (!direct) return false;
    const pending = this.store.recordDirectInteraction(
      uin, chatKey, Number(message?.ts) || this.now(), settings
    );
    const state = this.store.getState(uin, settings, this.now());
    const cooldownMs = settings.perUserCooldownHours * 3600000;
    if (
      pending.directCount >= settings.minDirectMessages
      && (!state.lastEvaluatedAt || this.now() - state.lastEvaluatedAt >= cooldownMs)
      && !this.store.hasActiveJob(uin)
      && this.store.evaluationsSince(shanghaiDayStart(this.now())) < settings.maxEvaluationsPerDay
    ) {
      const profile = personaRelationshipProfile(this.config?.()?.persona || {});
      this.store.enqueueJob({
        uin,
        triggerKind: 'auto',
        fromTs: Math.max(0, pending.firstAt - 10 * 60000),
        toTs: pending.lastAt + 10 * 60000,
        personaVersion: profile.version,
        model: settings.model || this.config?.()?.api?.model || ''
      });
      this.store.clearPending(uin);
      this.#scheduleDrain();
    }
    return true;
  }

  enqueueManual({ userId, fromTs, toTs } = {}) {
    if (!this.active || !this.store) throw new Error('关系 V2 实验当前未启用');
    const uin = String(userId || '').trim();
    if (!/^\d{1,15}$/.test(uin)) throw new Error('userId 必须是数字 QQ 号');
    const now = this.now();
    const from = Number(fromTs) || Math.max(0, now - 7 * 86400000);
    const to = Number(toTs) || now;
    if (from < 0 || to < from || to - from > 90 * 86400000) {
      throw new Error('手动评估时间范围必须有效且不超过 90 天');
    }
    const settings = this.settings();
    const profile = personaRelationshipProfile(this.config?.()?.persona || {});
    const job = this.store.enqueueJob({
      uin, triggerKind: 'manual', fromTs: from, toTs: to,
      personaVersion: profile.version,
      model: settings.model || this.config?.()?.api?.model || ''
    });
    this.#scheduleDrain();
    return job;
  }

  listStates(limit = 100) {
    return this.store?.listStates(limit, this.settings(), this.now()) || [];
  }

  listEvents(options = {}) { return this.store?.recentEvents(options) || []; }
  listJobs(options = {}) { return this.store?.listJobs(options) || []; }

  guidanceFor(userIds = []) {
    const settings = this.settings();
    if (!this.active || !settings.behaviorInjectionEnabled || !this.store) return '';
    const lines = [];
    for (const userId of [...new Set(userIds.map(String))].slice(0, 4)) {
      const state = this.store.getState(userId, settings, this.now());
      if (!state) continue;
      const name = this.personProvider(userId)?.primaryName || userId;
      const policy = state.policy;
      let instruction = '保持人格原本的社交距离';
      if (policy.mode === 'boundary') instruction = '存在未解决边界问题；克制、明确，不继续互怼或主动拉近关系';
      else if (policy.mode === 'deescalate') instruction = '近期有摩擦；语气平稳，不翻旧账，不主动升级冲突';
      else if (policy.mode === 'trusted') instruction = '关系较稳定；可以自然引用共同经历，但不要过度亲昵';
      else if (policy.mode === 'familiar-positive') instruction = '较熟悉且关系正向；可以稍自然地接话';
      else if (policy.mode === 'cool') instruction = '关系偏冷；保持礼貌和边界，不降低事实与任务质量';
      if (policy.warmthStep && ['baseline', 'familiar-positive', 'trusted'].includes(policy.mode)) {
        instruction += '；最近互动较轻松，表达最多温暖一个档位';
      }
      lines.push(`- ${name}（${userId}）：${instruction}`);
    }
    if (!lines.length) return '';
    return [
      '关系状态只允许细微调节社交距离，不能改变角色性格、事实标准、帮助质量或安全边界。',
      ...lines
    ].join('\n');
  }

  #scheduleDrain() {
    if (!this.active || this.running) return;
    const generation = this.generation;
    this.queue = this.queue.then(async () => {
      if (!this.active || generation !== this.generation) return;
      this.running = true;
      try {
        let job;
        while (this.active && generation === this.generation && (job = this.store?.claimNextJob())) {
          await this.#runJob(job, generation);
        }
      } finally {
        this.running = false;
      }
    }).catch((error) => {
      this.lastError = String(error?.message ?? error);
      this.running = false;
      this.log(`[relationship-v2] 后台队列失败：${this.lastError}`);
    });
  }

  async #runJob(job, generation) {
    const settings = this.settings();
    let usage = {};
    const controller = new AbortController();
    this.currentAbortController = controller;
    try {
      const evidence = await this.evidenceProvider({
        userId: job.userId,
        fromTs: job.fromTs,
        toTs: job.toTs,
        limit: settings.maxEvidenceMessages
      });
      if (!this.active || generation !== this.generation) {
        this.store.requeueJob(job.id, '实验停用，任务未评估并已重新排队');
        return;
      }
      if (!Array.isArray(evidence) || !evidence.some((item) => item.countableEvidence === true)) {
        this.store.finishJob(job.id, { evidenceCount: evidence?.length || 0, eventCount: 0 });
        this.emit('relationship-v2-update', this.status());
        return;
      }
      const config = this.config?.() || {};
      const profile = personaRelationshipProfile(config.persona || {});
      const state = this.store.getState(job.userId, settings, this.now());
      const messages = [
        { role: 'system', content: buildRelationshipV2SystemPrompt(profile) },
        { role: 'user', content: buildRelationshipV2UserPrompt({
          userId: job.userId,
          person: this.personProvider(job.userId) || {},
          evidence,
          openBoundary: state?.boundaryState === 'open'
        }) }
      ];
      const response = await this.complete({
        messages,
        tools: [RELATIONSHIP_V2_EVENT_TOOL],
        toolChoice: {
          type: 'function',
          function: { name: 'submit_relationship_v2_events' }
        },
        temperature: 0.1,
        maxTokens: 1400,
        signal: controller.signal,
        ...(settings.model ? { overrides: { ...(config.api || {}), model: settings.model } } : {})
      }, 0);
      if (!this.active || generation !== this.generation) {
        this.store.requeueJob(job.id, '实验停用，模型结果未应用并已重新排队');
        return;
      }
      usage = usageOf(response);
      const parsed = parseRelationshipV2Response(response, evidence, profile.basis.map((item) => item.id));
      const result = this.store.applyEvaluation(job.userId, parsed.events, {
        settings,
        personaVersion: profile.version,
        now: this.now()
      });
      this.store.finishJob(job.id, {
        evidenceCount: evidence.length,
        eventCount: result.appliedEvents.length,
        usage
      });
      this.lastError = '';
      this.emit('relationship-v2-update', {
        status: this.status(), userId: job.userId,
        state: result.state, appliedEvents: result.appliedEvents.length
      });
    } catch (error) {
      if (controller.signal.aborted || !this.active || generation !== this.generation) {
        this.store?.requeueJob(job.id, '实验停用，后台请求已取消并重新排队');
        return;
      }
      this.lastError = String(error?.message ?? error);
      this.store?.failJob(job.id, this.lastError);
      this.emit('relationship-v2-update', this.status());
      this.log(`[relationship-v2] 任务 ${job.id} 失败：${this.lastError}`);
    } finally {
      if (this.currentAbortController === controller) this.currentAbortController = null;
    }
  }
}
