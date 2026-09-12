import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-identity-pilot-nodiff-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.env.NODE_TEST_CONTEXT = '1';

const { DEFAULT_CONFIG, identityPilotEnabled, setRuntimeConfig } =
  await import('../src/config.js');
const { ChatStore } = await import('../src/store.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const { buildSystemPrompt, buildUserPrompt } = await import('../src/prompt.js');
const { buildToolDefs, toOpenAiTools } = await import('../src/tools.js');

function configWithPilot(value) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.mode = 'active';
  config.allow.groups = ['1'];
  config.api.model = 'mock-model';
  config.api.baseUrl = 'https://model.invalid/v1';
  config.sticker.enabled = false;
  config.memory.consolidateEnabled = false;
  config.webSearch.enabled = false;
  config.wakeDelayMinMs = 0;
  config.wakeDelayMaxMs = 0;
  if (value === undefined) delete config.identityPilot;
  else config.identityPilot = { enabled: value };
  return config;
}

function promptSnapshot(config) {
  setRuntimeConfig(config);
  const now = Date.now();
  const messages = [{
    id: 1,
    mid: 1001,
    ts: now,
    senderId: '42',
    senderName: '测试成员',
    text: '测试严格 nodiff',
    self: false
  }];
  const store = {
    recent: () => [],
    getConversationThread: () => null
  };
  const memory = {
    formatForPrompt: () => '',
    formatHandoffForPrompt: () => ''
  };
  return {
    system: buildSystemPrompt(),
    user: buildUserPrompt({
      chatKey: 'group:1',
      kind: 'group',
      chatId: '1',
      chatName: '测试群',
      triggerEntries: messages,
      store,
      memory,
      stickerEntries: [],
      selfNickname: '测试机器人',
      selfLastMessageAt: 0,
      lastMessageAt: now,
      recentCount: 1,
      moreUnreadDuringRun: false,
      proactive: false,
      contextLimit: 100
    }),
    tools: toOpenAiTools(buildToolDefs())
  };
}

async function runAgent(config, suffix) {
  setRuntimeConfig(config);
  const dataDir = path.join(root, suffix);
  const store = new ChatStore(0, { dataDir });
  const sessions = new SessionRegistry();
  const requests = [];
  const onebotCalls = [];
  let finishedSessionId = '';
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json({
      id: 'nodiff-response',
      created: 2_000_000_000,
      model: 'mock-model',
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: '无需回复' }
      }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 80 }
      }
    });
  };
  const memory = {
    formatForPrompt: () => '',
    formatHandoffForPrompt: () => '',
    getHandoff: () => null,
    setHandoff: () => null,
    clearHandoff: () => {}
  };
  const runner = new Orchestrator({
    store,
    sessions,
    memory,
    stickers: {},
    sender: {
      sendTextBatch: async () => ({ sent: [], failed: [] })
    },
    onebot: {
      selfId: '888',
      selfNickname: '测试机器人',
      getGroupInfo: async (groupId) => {
        onebotCalls.push(['getGroupInfo', String(groupId)]);
        return { group_name: '测试群' };
      }
    },
    emit: (event, payload) => {
      if (event === 'session-end') finishedSessionId = String(payload?.sessionId || '');
    }
  });

  try {
    store.appendIncoming('group:1', {
      mid: 1001,
      ts: Date.now(),
      senderId: '42',
      senderName: '测试成员',
      text: '测试严格 nodiff'
    });
    await runner.wake('group:1', { manual: true });
    const session = sessions.get(finishedSessionId);
    assert.ok(session, 'Agent 运行应生成可审计 Session');
    return {
      request: requests[0],
      requestCount: requests.length,
      onebotCalls,
      session: {
        status: session.status,
        trigger: session.trigger,
        rounds: session.rounds,
        usage: session.usage
      },
      pendingTimers: runner.wakeTimers.size,
      runningTasks: runner.runTasks.size
    };
  } finally {
    await runner.abortAll();
    store.close();
    globalThis.fetch = previousFetch;
  }
}

test('identity pilot defaults off and explicit off is strict runtime nodiff', async (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const realNow = Date.now;
  Date.now = () => 2_000_000_000_000;
  t.after(() => { Date.now = realNow; });

  const legacyConfig = configWithPilot(undefined);
  const disabledConfig = configWithPilot(false);
  assert.equal(identityPilotEnabled(legacyConfig), false);
  assert.equal(identityPilotEnabled(disabledConfig), false);
  assert.deepEqual(promptSnapshot(disabledConfig), promptSnapshot(legacyConfig));

  const legacyRun = await runAgent(legacyConfig, 'legacy');
  const disabledRun = await runAgent(disabledConfig, 'disabled');
  assert.deepEqual(disabledRun, legacyRun);
  assert.equal(disabledRun.requestCount, 1);
  assert.equal(disabledRun.pendingTimers, 0);
  assert.equal(disabledRun.runningTasks, 0);
  assert.ok(!disabledRun.request.tools.some((tool) =>
    String(tool?.function?.name || '').startsWith('person_')));

  const experimentalArtifacts = fs.readdirSync(root, { recursive: true })
    .map(String)
    .filter((name) => /identity|people|profile/i.test(path.basename(name)));
  assert.deepEqual(experimentalArtifacts, []);
});
