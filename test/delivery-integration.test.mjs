import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-delivery-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const { ChatStore } = await import('../src/store.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { SendQueue } = await import('../src/sender.js');
const { OneBotActionError, OneBotClient } = await import('../src/onebot.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');

it('holds uncertain deliveries and does not automatically send again on new input', async (t) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  let sends = 0;
  const onebot = {
    getGroupInfo: async () => ({ group_name: 'test' }),
    sendText: async () => { sends++; throw new Error('HTTP response lost after remote delivery'); }
  };
  const store = new ChatStore(0, { dataDir: dir });
  const sessions = new SessionRegistry();
  const sender = new SendQueue({ store, onebot });
  const runner = new Orchestrator({ store, sessions, sender, onebot,
    stickers: {}, memory: { formatForPrompt: () => '' } });
  const oldFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = oldFetch; await runner.abortAll(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  globalThis.fetch = async () => Response.json({ choices: [{ message: { tool_calls: [
    { id: 'send-1', function: { name: 'send_message', arguments: '{"messages":"hello"}' } }
  ] } }], usage: { total_tokens: 10 } });
  store.appendIncoming('group:1', { mid: 1, text: 'hello', senderId: '42' });
  await runner.wake('group:1');
  assert.equal(sends, 1);
  assert.equal(store.getChatMeta('group:1').held, 1);
  assert.equal(sessions.listSummaries(1)[0].status, 'error');
  store.appendIncoming('group:1', { mid: 2, text: 'new', senderId: '42' });
  await runner.wake('group:1');
  assert.equal(sends, 1);
  assert.equal(store.findByMid('group:1', 2).state, 'pending');
  assert.equal(store.retryFailed('group:1'), 0);
  assert.equal(store.resolveHeld('group:1'), 1);
  assert.equal(store.getChatMeta('group:1').held, 0);
});

it('also blocks a chat after an uncertain proactive send with no input lease', async (t) => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  let sends = 0;
  const onebot = {
    getGroupInfo: async () => ({ group_name: 'test' }),
    sendText: async () => { sends++; throw new Error('response lost'); }
  };
  const store = new ChatStore(0, { dataDir: dir });
  const sessions = new SessionRegistry();
  const runner = new Orchestrator({
    store, sessions, onebot, stickers: {}, memory: { formatForPrompt: () => '' },
    sender: new SendQueue({ store, onebot })
  });
  const oldFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = oldFetch; await runner.abortAll(); store.close(); });
  globalThis.fetch = async () => Response.json({ choices: [{ message: { tool_calls: [
    { id: 'send-2', function: { name: 'send_message', arguments: '{"messages":"hello"}' } }
  ] } }], usage: { total_tokens: 10 } });
  await runner.wake('group:1', { proactive: true });
  assert.equal(sends, 1);
  assert.equal(store.getChatMeta('group:1').held, 1);
  store.appendIncoming('group:1', { mid: 2, text: 'new', senderId: '42' });
  await runner.wake('group:1');
  assert.equal(sends, 1);
  assert.equal(store.resolveHeld('group:1'), 1);
});

it('incident pilot quarantines an unknown write without blocking later messages', async (t) => {
  const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-delivery-pilot-'));
  t.after(() => fs.rmSync(caseDir, { recursive: true, force: true }));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  let sends = 0;
  const onebot = {
    connected: true,
    getGroupInfo: async () => ({ group_name: 'test' }),
    sendText: async () => {
      sends++;
      if (sends === 1) throw new Error('response lost');
      return { message_id: 99 };
    }
  };
  const store = new ChatStore(0, { dataDir: caseDir });
  const sessions = new SessionRegistry();
  const incidentPilot = {
    active: true,
    capture: () => null,
    chatDecision: (_chatKey, meta) => ({
      allowed: true,
      mode: 'auto',
      effectiveState: meta.held ? 'degraded' : 'normal',
      reason: meta.held ? '旧写入待核对' : ''
    }),
    contextForChat: () => '【异常隔离】不要重试旧操作'
  };
  const runner = new Orchestrator({
    store,
    sessions,
    onebot,
    stickers: {},
    memory: { formatForPrompt: () => '' },
    sender: new SendQueue({ store, onebot }),
    getIncidentPilot: () => incidentPilot
  });
  const oldFetch = globalThis.fetch;
  let calls = 0;
  t.after(async () => {
    globalThis.fetch = oldFetch;
    await runner.abortAll();
    store.close();
  });
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      choices: [{
        message: calls <= 2
          ? { tool_calls: [{
              id: `send-${calls}`,
              function: { name: 'send_message', arguments: `{"messages":"message-${calls}"}` }
            }] }
          : { content: 'done' }
      }],
      usage: { total_tokens: 10 }
    });
  };

  store.appendIncoming('group:1', { mid: 1, text: 'first', senderId: '42' });
  await runner.wake('group:1');
  assert.equal(store.getChatMeta('group:1').held, 1);
  store.appendIncoming('group:1', { mid: 2, text: 'second', senderId: '42' });
  await runner.wake('group:1');
  assert.equal(sends, 2);
  assert.equal(store.findByMid('group:1', 2).state, 'acked');
  assert.equal(store.getChatMeta('group:1').held, 1);
  const latest = sessions.get(sessions.listSummaries(1)[0].id);
  assert.match(latest.userPrompt, /异常隔离/);
});

it('manual incident control blocks model work while preserving unread input', async (t) => {
  const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-delivery-blocked-'));
  t.after(() => fs.rmSync(caseDir, { recursive: true, force: true }));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  const store = new ChatStore(0, { dataDir: caseDir });
  const sessions = new SessionRegistry();
  let modelCalls = 0;
  const runner = new Orchestrator({
    store,
    sessions,
    onebot: {
      connected: true,
      getGroupInfo: async () => ({ group_name: 'test' })
    },
    stickers: {},
    memory: { formatForPrompt: () => '' },
    sender: new SendQueue({ store, onebot: {} }),
    getIncidentPilot: () => ({
      active: true,
      chatDecision: () => ({
        allowed: false,
        mode: 'blocked',
        effectiveState: 'blocked',
        reason: '管理员已阻塞'
      })
    })
  });
  const oldFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = oldFetch;
    await runner.abortAll();
    store.close();
  });
  globalThis.fetch = async () => {
    modelCalls++;
    return Response.json({ choices: [{ message: { content: 'unexpected' } }] });
  };
  store.appendIncoming('group:1', { mid: 20, text: '@bot', senderId: '42' });
  await runner.wake('group:1');
  assert.equal(modelCalls, 0);
  assert.equal(store.findByMid('group:1', 20).state, 'pending');
  assert.match(runner.requestManualWake('group:1').reason, /阻塞/);
});

it('keeps explicit OneBot business rejection retryable without holding the chat', async (t) => {
  const caseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-delivery-definite-'));
  t.after(() => fs.rmSync(caseDir, { recursive: true, force: true }));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  let sends = 0;
  const onebot = {
    connected: true,
    getGroupInfo: async () => ({ group_name: 'test' }),
    sendText: async () => {
      sends++;
      throw new OneBotActionError(
        'OneBot send_group_msg 失败: retcode=100 failed to resolve UID',
        { action: 'send_group_msg', outcome: 'failed', retcode: 100 }
      );
    }
  };
  const store = new ChatStore(0, { dataDir: caseDir });
  const sessions = new SessionRegistry();
  const runner = new Orchestrator({
    store,
    sessions,
    onebot,
    stickers: {},
    memory: { formatForPrompt: () => '' },
    sender: new SendQueue({ store, onebot })
  });
  const oldFetch = globalThis.fetch;
  let calls = 0;
  t.after(async () => {
    globalThis.fetch = oldFetch;
    await runner.abortAll();
    store.close();
  });
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      choices: [{
        message: calls === 1
          ? { tool_calls: [{
              id: 'send-definite-failure',
              function: { name: 'send_message', arguments: '{"messages":"hello"}' }
            }] }
          : { content: 'stop after the explicit rejection' }
      }],
      usage: { total_tokens: 10 }
    });
  };

  store.appendIncoming('group:1', { mid: 10, text: 'hello', senderId: '42' });
  await runner.wake('group:1');

  assert.equal(sends, 1);
  assert.equal(store.getChatMeta('group:1').held, 0);
  assert.equal(store.findByMid('group:1', 10).state, 'acked');
  assert.notEqual(sessions.listSummaries(1)[0].status, 'error');
});

it('classifies a parsed OneBot retcode as failed but keeps malformed responses unknown', async (t) => {
  const client = new OneBotClient({
    httpUrl: 'http://onebot.invalid',
    wsUrl: 'ws://onebot.invalid',
    onEvent: () => {}
  });
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });

  globalThis.fetch = async () => Response.json({
    status: 'failed',
    retcode: 100,
    wording: 'Process_Nudge failed'
  });
  await assert.rejects(
    client.call('group_poke', { group_id: 1, user_id: 2 }),
    (error) => error instanceof OneBotActionError
      && error.outcome === 'failed'
      && error.retcode === 100
  );

  globalThis.fetch = async () => new Response('not-json', {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
  await assert.rejects(
    client.call('send_group_msg', { group_id: 1, message: [] }),
    (error) => error instanceof OneBotActionError && error.outcome === 'unknown'
  );
});
