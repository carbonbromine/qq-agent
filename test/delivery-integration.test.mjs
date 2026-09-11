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
