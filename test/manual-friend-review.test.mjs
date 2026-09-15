import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-manual-friend-review-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.env.NODE_TEST_CONTEXT = '1';

const { ChatStore } = await import('../src/store.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { IdentityPilotManager } = await import('../src/identity-pilot.js');

function config() {
  return {
    runtime: { mode: 'active' },
    api: { model: 'mock-model' },
    persona: {
      botName: '测试机器人',
      roleText: '你是一个普通群友。',
      customRules: ''
    },
    identityPilot: {
      enabled: true,
      friendProposal: {
        enabled: true,
        mode: 'triggered',
        ownerUin: '900001',
        cooldownDays: 30,
        maxPending: 10,
        triggered: {
          probability: 0,
          historyDays: 30,
          minMessages: 999,
          minActiveDays: 999,
          minDirectExchanges: 999,
          maxTriggerAgeMinutes: 1,
          friendStatusMaxAgeMinutes: 15,
          drawCooldownMinutes: 999,
          maxDrawsPerUserPerDay: 1,
          maxReviewsPerDay: 0,
          skipCooldownDays: 365,
          errorCooldownMinutes: 999,
          maxQueueAgeSeconds: 5,
          scoreThreshold: 70,
          weights: {
            quality: 40,
            interest: 30,
            reciprocity: 20,
            stability: 10
          }
        }
      }
    },
    allow: { groups: [], private: ['123456', '900001'] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    blocklist: {}
  };
}

function modelResponse() {
  const toolCalls = [{
    id: 'manual-friend-review',
    type: 'function',
    function: {
      name: 'submit_friend_review',
      arguments: JSON.stringify({
        decision: 'propose',
        ratings: {
          quality: 4,
          interest: 4,
          reciprocity: 4,
          stability: 4
        },
        evidenceIds: [
          'message:private:123456:1',
          'message:private:123456:2'
        ],
        reasonCode: 'interest',
        reason: '双方持续有具体交流意愿',
        verificationMessage: '以后继续聊'
      })
    }
  }];
  return {
    model: 'mock-model',
    finishReason: 'tool_calls',
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 16 }
    },
    message: {
      content: null,
      reasoning_content: '手动评分仍只根据真实互动，不使用自动触发门槛。',
      tool_calls: toolCalls
    },
    raw: {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          reasoning_content: '手动评分仍只根据真实互动，不使用自动触发门槛。',
          tool_calls: toolCalls
        }
      }]
    }
  };
}

async function fixture(t, { alreadyFriend = false } = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const store = new ChatStore(0, { dataDir: dir });
  const sessions = new SessionRegistry(0);
  const cfg = config();
  const events = [];
  let notifyCalls = 0;
  let dispatchCalls = 0;

  store.appendIncoming('private:123456', {
    mid: 1001,
    ts: Date.now() - 1000,
    senderId: '123456',
    senderName: '候选人',
    text: '继续聊刚才的话题',
    eventKind: 'message'
  });
  store.appendSelf('private:123456', {
    mid: 1002,
    ts: Date.now() - 500,
    text: '可以，之后继续聊',
    targetUserId: '123456',
    eventKind: 'message'
  });

  const friends = alreadyFriend
    ? [{ user_id: 123456, nickname: '已有好友' }]
    : [];
  const manager = new IdentityPilotManager({
    store,
    sessions,
    dataDir: dir,
    config: () => cfg,
    onebot: {
      selfId: '888888',
      call: async (action) => action === 'get_friend_list' ? friends : {}
    },
    complete: async () => modelResponse(),
    notifyFriendProposal: async () => { notifyCalls += 1; },
    sendFriendRequest: async () => {
      dispatchCalls += 1;
      throw new Error('manual review must not dispatch directly');
    },
    emit: (type, payload) => events.push({ type, payload }),
    log: () => {}
  });
  await manager.start();

  t.after(() => {
    manager.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return {
    manager,
    sessions,
    events,
    get notifyCalls() { return notifyCalls; },
    get dispatchCalls() { return dispatchCalls; }
  };
}

test('manual friend review bypasses automatic trigger gates and creates a proposal', async (t) => {
  const f = await fixture(t);
  const result = await f.manager.manualFriendReview({
    userId: '123456',
    chatKey: 'private:123456'
  });

  assert.equal(result.alreadyFriend, false);
  assert.equal(result.review.score, 100);
  assert.equal(result.opportunity.status, 'proposed');
  assert.ok(result.proposal?.id);
  assert.equal(f.notifyCalls, 1);
  assert.equal(f.dispatchCalls, 0);

  const record = f.manager.listFriendOpportunities()[0];
  assert.equal(record.triggerReason, '管理员手动触发');
  assert.equal(record.config.manual, true);
  assert.equal(record.eligibility.automaticGatesIgnored, true);
});

test('manual friend review still scores an existing friend without creating or dispatching a request', async (t) => {
  const f = await fixture(t, { alreadyFriend: true });
  const result = await f.manager.manualFriendReview({
    userId: '123456',
    chatKey: 'private:123456'
  });

  assert.equal(result.alreadyFriend, true);
  assert.equal(result.review.score, 100);
  assert.equal(result.opportunity.status, 'cancelled');
  assert.equal(result.opportunity.reason, 'already-friend');
  assert.equal(result.opportunity.review.score, 100);
  assert.equal(result.proposal, null);
  assert.equal(f.notifyCalls, 0);
  assert.equal(f.dispatchCalls, 0);
  assert.match(result.note, /已经是好友/);

  const sessionId = f.events.find((event) => event.type === 'session-start')?.payload?.sessionId;
  assert.ok(sessionId);
  const session = f.sessions.get(sessionId);
  assert.equal(session.kind, 'friend-review');
  assert.equal(session.manualTrigger, true);
  assert.equal(session.alreadyFriend, true);
  assert.equal(session.messages[0].role, 'assistant');
  assert.match(session.messages[0].reasoning_content, /自动触发门槛/);
  assert.equal(session.callUsage[0].cachedTokens, 16);
});
