import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  parseRelationshipV2Response,
  RelationshipV2Manager
} from '../src/relationship-v2.js';

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function response(events) {
  return {
    message: {
      tool_calls: [{
        id: 'call-1', type: 'function',
        function: { name: 'submit_relationship_v2_events', arguments: JSON.stringify({ events }) }
      }]
    },
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  };
}

test('disabled V2 creates no database and has no model or prompt effects', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relationship-v2-disabled-'));
  dirs.push(dataDir);
  let calls = 0;
  const manager = new RelationshipV2Manager({
    dataDir,
    config: () => ({ relationshipV2: { enabled: false } }),
    evidenceProvider: async () => [],
    complete: async () => { calls += 1; return response([]); },
    log: () => {}
  });
  const status = manager.start();
  assert.equal(status.active, false);
  assert.equal(manager.observeMessage('private:12345', { senderId: '12345' }), false);
  assert.equal(manager.guidanceFor(['12345']), '');
  assert.throws(() => manager.enqueueManual({ userId: '12345' }), /未启用/);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(dataDir, 'relationship-v2.sqlite')), false);
  await manager.stop();
});

test('parser accepts only countable target evidence', () => {
  const evidence = [
    { evidenceId: 'group:1#1', chatKey: 'group:1', countableEvidence: true },
    { evidenceId: 'group:1#2', chatKey: 'group:1', countableEvidence: false }
  ];
  const parsed = parseRelationshipV2Response(response([{
    type: 'pleasant_moment', strength: 0.4, confidence: 0.8,
    durableEligible: false, evidenceIds: ['group:1#1'], personaBasisIds: [], summary: '一次愉快互动'
  }]), evidence);
  assert.equal(parsed.events.length, 1);
  assert.throws(() => parseRelationshipV2Response(response([{
    type: 'pleasant_moment', strength: 0.4, confidence: 0.8,
    durableEligible: false, evidenceIds: ['group:1#2'], personaBasisIds: [], summary: '非法证据'
  }]), evidence), /不可计数/);
  assert.throws(() => parseRelationshipV2Response(response([{
    type: 'conflict', strength: 0.7, confidence: 0.8,
    durableEligible: false, evidenceIds: ['group:1#1'], personaBasisIds: ['role:99'], summary: '越过角色边界'
  }]), evidence, ['role:1']), /人格依据/);
});

test('manual job uses forced structured output and includes current persona', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relationship-v2-manager-'));
  dirs.push(dataDir);
  let request = null;
  const config = {
    api: { model: 'test-model' },
    onebot: { selfId: '99999' },
    persona: {
      botName: '测试角色', behaviorProfile: 'grounded',
      roleText: '重视兑现承诺，不喜欢持续施压。', customRules: ''
    },
    relationshipV2: { enabled: true, autoEvaluationEnabled: false, model: 'relationship-model' }
  };
  const manager = new RelationshipV2Manager({
    dataDir,
    config: () => config,
    evidenceProvider: async ({ userId }) => [{
      evidenceId: `private:${userId}#1`, chatKey: `private:${userId}`,
      at: Date.now(), speaker: 'target', text: '谢谢你还记得',
      countableEvidence: true, directToAgent: true
    }],
    complete: async (payload) => {
      request = payload;
      return response([]);
    },
    log: () => {}
  });
  manager.start();
  manager.store.recordDirectInteraction('12345', 'private:12345', Date.now(), manager.settings(), '测试用户');
  assert.equal(manager.listStates(10)[0].name, '测试用户');
  const job = manager.enqueueManual({ userId: '12345' });
  for (let i = 0; i < 50; i += 1) {
    if (manager.listJobs({ limit: 10 }).find((item) => item.id === job.id)?.status === 'done') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const done = manager.listJobs({ limit: 10 }).find((item) => item.id === job.id);
  assert.equal(done.status, 'done');
  assert.equal(request.toolChoice.function.name, 'submit_relationship_v2_events');
  assert.equal(request.overrides.model, 'relationship-model');
  assert.match(request.messages[0].content, /重视兑现承诺/);
  assert.equal(manager.listJobs({ limit: 10 }).find((item) => item.id === job.id).name, '测试用户');
  assert.equal(manager.guidanceFor(['12345']), '', 'behavior injection defaults off');
  await manager.stop();
});

test('disabling aborts an in-flight evaluation and safely requeues it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relationship-v2-cancel-'));
  dirs.push(dataDir);
  const config = {
    persona: { botName: '角色', roleText: '边界清晰。' },
    relationshipV2: { enabled: true, autoEvaluationEnabled: false }
  };
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const manager = new RelationshipV2Manager({
    dataDir,
    config: () => config,
    evidenceProvider: async ({ userId }) => [{
      evidenceId: `private:${userId}#1`, chatKey: `private:${userId}`,
      at: Date.now(), speaker: 'target', text: '证据', countableEvidence: true, directToAgent: true
    }],
    complete: ({ signal }) => new Promise((resolve, reject) => {
      requestStarted();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    log: () => {}
  });
  manager.start();
  const job = manager.enqueueManual({ userId: '54321' });
  await started;
  await manager.stop();
  manager.openExisting();
  const persisted = manager.listJobs({ limit: 10 }).find((item) => item.id === job.id);
  assert.equal(persisted.status, 'queued');
  assert.match(persisted.error, /取消|停用/);
  assert.equal(manager.listEvents({ uin: '54321' }).length, 0);
  await manager.stop();
});

test('automatic evaluation cannot queue repeatedly while one user job is active', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relationship-v2-auto-gate-'));
  dirs.push(dataDir);
  const now = Date.now();
  const config = {
    onebot: { selfId: '99999' },
    persona: { botName: '角色', roleText: '稳定。' },
    relationshipV2: {
      enabled: true, autoEvaluationEnabled: true, minDirectMessages: 3,
      perUserCooldownHours: 12, maxEvaluationsPerDay: 20
    }
  };
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const manager = new RelationshipV2Manager({
    dataDir,
    config: () => config,
    now: () => now,
    evidenceProvider: async ({ userId }) => [{
      evidenceId: `private:${userId}#1`, chatKey: `private:${userId}`,
      at: now, speaker: 'target', text: '证据', countableEvidence: true, directToAgent: true
    }],
    complete: ({ signal }) => new Promise((resolve, reject) => {
      requestStarted();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
    log: () => {}
  });
  manager.start();
  for (let index = 0; index < 3; index += 1) {
    manager.observeMessage('private:12345', { senderId: '12345', ts: now + index });
  }
  await started;
  for (let index = 3; index < 12; index += 1) {
    manager.observeMessage('private:12345', { senderId: '12345', ts: now + index });
  }
  assert.equal(manager.listJobs({ limit: 100 }).length, 1);
  await manager.stop();
});

test('behavior guidance is deterministic, bounded and separately switchable', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relationship-v2-guidance-'));
  dirs.push(dataDir);
  const config = {
    persona: { botName: '角色', roleText: '冷静但友好。', customRules: '' },
    relationshipV2: { enabled: true, behaviorInjectionEnabled: true }
  };
  const manager = new RelationshipV2Manager({
    dataDir,
    config: () => config,
    evidenceProvider: async () => [],
    personProvider: () => ({ primaryName: '甲' }),
    log: () => {}
  });
  manager.start();
  manager.store.applyEvaluation('12345', [
    {
      type: 'pleasant_moment', strength: 0.9, confidence: 0.9,
      durableEligible: false, evidenceIds: ['private:12345#1'],
      sourceChatKeys: ['private:12345'], personaBasisIds: [], summary: '轻松互动一'
    },
    {
      type: 'pleasant_moment', strength: 0.9, confidence: 0.9,
      durableEligible: false, evidenceIds: ['private:12345#2'],
      sourceChatKeys: ['private:12345'], personaBasisIds: [], summary: '轻松互动二'
    }
  ], { settings: manager.settings(), now: Date.now() });
  const guidance = manager.guidanceFor(['12345']);
  assert.match(guidance, /不能改变角色性格/);
  assert.match(guidance, /最近互动较轻松/);
  assert.doesNotMatch(guidance, /0\.\d|score|好感度/);

  config.relationshipV2.behaviorInjectionEnabled = false;
  assert.equal(manager.guidanceFor(['12345']), '');
  await manager.stop();
});
