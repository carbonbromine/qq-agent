import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-friend-review-session-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.env.NODE_TEST_CONTEXT = '1';

const { ChatStore } = await import('../src/store.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { IdentityPilotManager } = await import('../src/identity-pilot.js');

function config() {
  return {
    runtime: { mode: 'active' },
    api: { model: 'mock-model' },
    persona: { botName: '测试机器人', roleText: '你是一个普通群友。', customRules: '' },
    identityPilot: {
      enabled: true,
      friendProposal: {
        enabled: true,
        mode: 'triggered',
        ownerUin: '900001',
        cooldownDays: 30,
        maxPending: 10,
        triggered: {
          probability: 1,
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
          weights: { quality: 40, interest: 30, reciprocity: 20, stability: 10 }
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
    id: 'friend-review',
    type: 'function',
    function: {
      name: 'submit_friend_review',
      arguments: JSON.stringify({
        decision: 'propose',
        ratings: { quality: 4, interest: 4, reciprocity: 4, stability: 4 },
        evidenceIds: ['message:private:123456:1', 'message:private:123456:2'],
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
      reasoning_content: '先核对互动质量、互惠性和证据，再决定是否提出好友申请。',
      tool_calls: toolCalls
    },
    raw: {
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          reasoning_content: '先核对互动质量、互惠性和证据，再决定是否提出好友申请。',
          tool_calls: toolCalls
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

test('friend review session preserves standard assistant reasoning audit', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const store = new ChatStore(0, { dataDir: dir });
  const sessions = new SessionRegistry(0);
  const cfg = config();
  const events = [];
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

  const manager = new IdentityPilotManager({
    store,
    sessions,
    dataDir: dir,
    config: () => cfg,
    onebot: {
      selfId: '888888',
      call: async (action) => action === 'get_friend_list' ? [] : {}
    },
    random: () => 0,
    complete: async () => modelResponse(),
    notifyFriendProposal: async () => {},
    emit: (type, payload) => events.push({ type, payload }),
    log: () => {}
  });

  await manager.start();
  t.after(() => {
    manager.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const result = await manager.handleSuccessfulTurn({
    chatKey: 'private:123456',
    triggerEntries: [incoming],
    parentSessionId: 'parent-session',
    triggerReason: '私聊',
    repliedThisRun: true
  });
  assert.equal(result.triggered, true);

  await waitFor(() => manager.listFriendOpportunities()[0]?.status === 'proposed');
  const sessionId = events.find((event) => event.type === 'session-start')?.payload?.sessionId;
  assert.ok(sessionId);
  const session = sessions.get(sessionId);
  assert.equal(session.kind, 'friend-review');
  assert.equal(session.parentSessionId, 'parent-session');
  assert.equal(session.messages.length, 1);
  assert.equal(session.messages[0].role, 'assistant');
  assert.match(session.messages[0].reasoning_content, /互动质量/);
  assert.equal(session.messages[0].tool_calls[0].function.name, 'submit_friend_review');
  assert.match(session.messages[0].raw.choices[0].message.reasoning_content, /互惠性/);
  assert.deepEqual(session.inputMessages.map((message) => message.role), ['system', 'user']);
  assert.equal(session.inputTools[0].function.name, 'submit_friend_review');
  assert.equal(session.inputRequestOptions.maxTokens, 2048);
  assert.equal(session.finishReason, 'tool_calls');
  assert.equal(session.callUsage[0].promptTokens, 100);
  assert.equal(session.callUsage[0].cachedTokens, 16);
});
