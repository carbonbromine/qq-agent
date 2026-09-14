import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-slang-pilot-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.env.NODE_TEST_CONTEXT = '1';

const { extractSlangCandidates } = await import('../src/slang-detector.js');
const {
  SlangPilotStore,
  slangPilotDatabasePath
} = await import('../src/slang-pilot-store.js');
const { SlangPilotManager } = await import('../src/slang-pilot.js');

const settings = {
  minOccurrences: 3,
  minSpeakers: 2,
  windowHours: 72,
  maxPending: 100,
  perChatDailyLimit: 5,
  rejectCooldownDays: 14,
  maxEvidence: 12
};

async function waitFor(fn, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待黑话任务超时');
}

test('zero-token detector extracts likely slang and rejects sensitive material', () => {
  const terms = extractSlangCandidates({
    senderName: '测试者',
    text: '“无名剑法”到底是什么意思，yyds'
  });
  assert.ok(terms.some((item) => item.displayTerm === '无名剑法'));
  assert.ok(terms.some((item) => item.normalizedTerm === 'yyds'));
  assert.deepEqual(extractSlangCandidates({
    senderName: '测试者',
    text: 'token=secret-value'
  }), []);
  assert.deepEqual(extractSlangCandidates({
    senderName: '测试者',
    text: '/设置角色 无名剑法'
  }), []);
});

test('persistent detector promotes repeated evidence and enforces two approval stages', (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'store-'));
  const store = new SlangPilotStore({ dataDir: dir });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = {
    normalizedTerm: '无名剑法',
    displayTerm: '无名剑法',
    chatKey: 'group:100',
    text: '这招叫无名剑法',
    score: 0.58,
    reason: 'short-utterance',
    settings
  };
  store.observeCandidate({
    ...base, speakerId: '1', senderName: '甲', messageId: 1, at: 1000
  });
  store.observeCandidate({
    ...base, speakerId: '2', senderName: '乙', messageId: 2, at: 2000
  });
  const promoted = store.observeCandidate({
    ...base, speakerId: '1', senderName: '甲', messageId: 3, at: 3000
  });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.discovery.state, 'pending_research');
  assert.equal(promoted.discovery.occurrenceCount, 3);
  assert.equal(promoted.discovery.speakerCount, 2);

  const queued = store.decideResearch(promoted.discovery.id, 'approve', {
    decidedBy: '900001',
    expectedVersion: promoted.discovery.version,
    now: 4000
  });
  assert.equal(queued.state, 'research_queued');
  const researching = store.claimResearch(queued.id, 5000);
  assert.equal(researching.state, 'researching');
  const researched = store.completeResearch(queued.id, {
    research: {
      canonical: '无名剑法',
      meaning: '群内对某种临时招式的调侃称呼',
      recommendedScope: 'chat-private',
      confidence: 0.8
    },
    usage: { totalTokens: 120 },
    now: 6000
  });
  assert.equal(researched.state, 'pending_admission');
  const admitted = store.decideAdmission(researched.id, 'approve', {
    decidedBy: '900001',
    expectedVersion: researched.version,
    slangId: 'slang-1',
    now: 7000
  });
  assert.equal(admitted.state, 'admitted_candidate');
  assert.equal(admitted.admittedSlangId, 'slang-1');
  assert.deepEqual(store.events(admitted.id).map((event) => event.stage), [
    'research',
    'admission'
  ]);
});

test('manager performs research only after approval and admits an editable candidate', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'manager-'));
  const cfg = {
    slangPilot: {
      enabled: true,
      ownerUin: '900001',
      minOccurrences: 2,
      minSpeakers: 2,
      windowHours: 72,
      maxPending: 10,
      perChatDailyLimit: 5,
      rejectCooldownDays: 14,
      maxEvidence: 12,
      webResearch: false,
      maxResearchRounds: 2
    },
    webSearch: { enabled: false },
    runtime: { mode: 'observe', paused: false },
    timeControl: { enabled: false },
    allow: { groups: ['100'], private: ['900001'] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false
  };
  const admitted = [];
  let modelCalls = 0;
  const notifications = [];
  const manager = new SlangPilotManager({
    dataDir: dir,
    config: () => cfg,
    assetObserver: {
      admitSlangCandidate(input) {
        admitted.push(input);
        return { id: 'slang-test', ...input };
      }
    },
    complete: async () => {
      modelCalls += 1;
      return {
        model: 'mock',
        message: {
          content: JSON.stringify({
            canonical: '无名剑法',
            meaning: '群内临时创造的招式梗',
            usage: '调侃没有固定套路',
            example: '这就是无名剑法',
            nonExample: '',
            origin: '',
            risk: '仅限原群语境',
            variants: [],
            recommendedScope: 'chat-private',
            confidence: 0.9,
            evidenceAssessment: '两位群友重复使用'
          })
        },
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
      };
    },
    notify: async (stage, discovery) => {
      notifications.push({ stage, id: discovery.id });
    },
    log: () => {}
  });
  t.after(async () => {
    await manager.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  manager.start();
  assert.equal(modelCalls, 0);
  manager.observeMessage('group:100', {
    id: 1, ts: 1000, senderId: '1', senderName: '甲', text: '无名剑法'
  });
  manager.observeMessage('group:100', {
    id: 2, ts: 2000, senderId: '2', senderName: '乙', text: '无名剑法'
  });
  const pending = manager.list({ state: 'pending_research' })[0];
  assert.ok(pending);
  assert.equal(modelCalls, 0, '研究审批前不得调用模型');

  manager.decideResearch(pending.id, 'approve', {
    decidedBy: '900001',
    expectedVersion: pending.version
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(modelCalls, 0, '观察模式不得运行已批准研究');
  assert.equal(manager.detail(pending.id).state, 'research_queued');
  cfg.runtime.mode = 'active';
  manager.resumeQueued();
  const researched = await waitFor(() => {
    const item = manager.detail(pending.id);
    return item?.state === 'pending_admission' ? item : null;
  });
  assert.equal(modelCalls, 1);
  assert.equal(researched.research.meaning, '群内临时创造的招式梗');
  assert.deepEqual(notifications.map((item) => item.stage), [
    'pending-research',
    'pending-admission'
  ]);

  const result = manager.decideAdmission(researched.id, 'approve', {
    decidedBy: '900001',
    expectedVersion: researched.version,
    edits: { meaning: '管理员修订后的含义', scope: 'chat-private' }
  });
  assert.equal(result.discovery.state, 'admitted_candidate');
  assert.equal(result.entry.id, 'slang-test');
  assert.equal(admitted[0].meaning, '管理员修订后的含义');
  assert.equal(admitted[0].scopeChatKey, 'group:100');
});

test('disabled pilot creates no database or model work', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'disabled-'));
  const manager = new SlangPilotManager({
    dataDir: dir,
    config: () => ({ slangPilot: { enabled: false } }),
    assetObserver: {},
    complete: async () => {
      throw new Error('disabled pilot must not call model');
    }
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(manager.start().active, false);
  assert.deepEqual(manager.observeMessage('group:100', {
    id: 1, senderId: '1', senderName: '甲', text: '无名剑法'
  }), []);
  assert.equal(fs.existsSync(slangPilotDatabasePath(dir)), false);
});
