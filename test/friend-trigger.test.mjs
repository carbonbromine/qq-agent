import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-friend-trigger-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.env.NODE_TEST_CONTEXT = '1';

const { ChatStore } = await import('../src/store.js');
const { IdentityPilotManager } = await import('../src/identity-pilot.js');

function config(probability = 1) {
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
          probability,
          historyDays: 30,
          minMessages: 1,
          minActiveDays: 1,
          minDirectExchanges: 1,
          maxTriggerAgeMinutes: 10,
          friendStatusMaxAgeMinutes: 15,
          drawCooldownMinutes: 30,
          maxDrawsPerUserPerDay: 6,
          maxReviewsPerDay: 10,
          skipCooldownDays: 7,
          errorCooldownMinutes: 60,
          maxQueueAgeSeconds: 120,
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

function toolResponse(decision = 'propose') {
  return {
    model: 'mock-model',
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120
    },
    message: {
      tool_calls: [{
        id: 'friend-review',
        type: 'function',
        function: {
          name: 'submit_friend_review',
          arguments: JSON.stringify({
            decision,
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
      }]
    }
  };
}

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待好友评估完成超时');
}

async function fixture(t, {
  probability = 1,
  friends = [],
  complete = async () => toolResponse()
} = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const store = new ChatStore(0, { dataDir: dir });
  const cfg = config(probability);
  const incoming = store.appendIncoming('private:123456', {
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
    text: '可以',
    targetUserId: '123456',
    eventKind: 'message'
  });
  const notices = [];
  const manager = new IdentityPilotManager({
    store,
    dataDir: dir,
    config: () => cfg,
    onebot: {
      selfId: '888888',
      call: async (action) => action === 'get_friend_list' ? friends : {}
    },
    random: () => 0,
    complete,
    notifyFriendProposal: async (proposal) => notices.push(proposal),
    log: () => {}
  });
  await manager.start();
  t.after(() => {
    manager.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { cfg, store, incoming, manager, notices };
}

test('triggered friend review creates a proposal through one isolated model request', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    complete: async (args, retries) => {
      calls += 1;
      assert.equal(retries, 0);
      assert.deepEqual(
        args.tools.map((tool) => tool.function.name),
        ['submit_friend_review']
      );
      assert.doesNotMatch(args.messages[0].content, /send_message|memory_append/);
      return toolResponse();
    }
  });
  const result = await f.manager.handleSuccessfulTurn({
    chatKey: 'private:123456',
    triggerEntries: [f.incoming],
    parentSessionId: 'parent-session',
    triggerReason: '私聊',
    repliedThisRun: true
  });
  assert.equal(result.triggered, true);
  await waitFor(() =>
    f.manager.listFriendOpportunities()[0]?.status === 'proposed');
  assert.equal(calls, 1);
  assert.equal(f.manager.listFriendProposals().length, 1);
  assert.equal(f.manager.listFriendProposals()[0].opportunityId, result.opportunity.id);
  assert.equal(f.notices.length, 1);
});

test('an existing friend never creates a draw or model review', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    friends: [{ user_id: 123456, nickname: '已有好友' }],
    complete: async () => {
      calls += 1;
      return toolResponse();
    }
  });
  const result = await f.manager.handleSuccessfulTurn({
    chatKey: 'private:123456',
    triggerEntries: [f.incoming],
    parentSessionId: 'parent-session',
    triggerReason: '私聊'
  });
  assert.equal(result.triggered, false);
  assert.equal(calls, 0);
  assert.deepEqual(f.manager.listFriendOpportunities(), []);
  assert.deepEqual(f.manager.listFriendProposals(), []);
});

test('zero probability persists a miss without calling the model', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    probability: 0,
    complete: async () => {
      calls += 1;
      return toolResponse();
    }
  });
  const result = await f.manager.handleSuccessfulTurn({
    chatKey: 'private:123456',
    triggerEntries: [f.incoming],
    parentSessionId: 'parent-session',
    triggerReason: '私聊'
  });
  assert.equal(result.triggered, true);
  assert.equal(result.reason, 'lottery-miss');
  assert.equal(calls, 0);
  assert.equal(f.manager.listFriendOpportunities()[0].status, 'lottery_miss');
});

test('approval refresh closes a proposal when the user has become a friend', async (t) => {
  const friends = [];
  const f = await fixture(t, { friends });
  await f.manager.handleSuccessfulTurn({
    chatKey: 'private:123456',
    triggerEntries: [f.incoming],
    parentSessionId: 'parent-session',
    triggerReason: '私聊'
  });
  const proposal = await waitFor(() => f.manager.listFriendProposals()[0]);
  friends.push({ user_id: 123456, nickname: '刚成为好友' });

  const result = await f.manager.decideFriendProposal(
    proposal.id,
    'approve',
    { decidedBy: '900001' }
  );

  assert.equal(result.execution, 'accepted');
  assert.equal(result.proposal.status, 'accepted');
  assert.match(result.note, /已经是好友/);
});
