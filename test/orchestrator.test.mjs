import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-orchestrator-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { Orchestrator } = await import('../src/orchestrator.js');
const { ChatStore } = await import('../src/store.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');

describe('Orchestrator', () => {
  function fixture(t) {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.runtime.mode = 'active';
    cfg.allow.groups = ['1'];
    cfg.api.model = 'mock';
    cfg.api.baseUrl = 'https://model.invalid';
    cfg.sticker.enabled = false;
    cfg.memory.consolidateEnabled = false;
    cfg.wakeDelayMs = 30;
    cfg.maxBatchWaitMs = 120;
    cfg.drainDelayMs = 200;
    setRuntimeConfig(cfg);
    const dir = fs.mkdtempSync(path.join(root, 'store-'));
    const store = new ChatStore(0, { dataDir: dir });
    const sessions = new SessionRegistry();
    const runner = new Orchestrator({
      store, sessions, memory: { formatForPrompt: () => '' },
      stickers: {}, sender: {}, onebot: { getGroupInfo: async () => ({ group_name: 'test' }) }
    });
    const original = globalThis.fetch;
    t.after(async () => { await runner.abortAll(); store.close(); globalThis.fetch = original; });
    const append = (mid) => store.appendIncoming('group:1', { mid, text: 'hi', senderId: '42' });
    return { cfg, runner, store, sessions, append };
  }

  it('only acknowledges the claimed batch after successful model processing', async (t) => {
    const { runner, store, append } = fixture(t);
    append(1);
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      assert.equal(store.findByMid('group:1', 1).read, false);
      append(2);
      return Response.json({ choices: [{ message: { content: 'No reply needed' } }], usage: { total_tokens: 10 } });
    };
    await runner.wake('group:1');
    assert.equal(calls, 1);
    assert.equal(store.findByMid('group:1', 1).read, true);
    assert.equal(store.findByMid('group:1', 2).read, false);
  });

  it('preserves failed input and recorded token usage without clearing a run', async (t) => {
    const { runner, store, sessions, append } = fixture(t);
    append(1);
    let calls = 0;
    globalThis.fetch = async () => {
      if (++calls === 1) return Response.json({
        choices: [{ message: { tool_calls: [{ id: '1', function: { name: 'get_active_members', arguments: '{}' } }] } }],
        usage: { prompt_tokens: 50, total_tokens: 50 }
      });
      return new Response('bad request', { status: 400 });
    };
    await runner.wake('group:1');
    assert.equal(store.getChatMeta('group:1').failed, 1);
    const session = sessions.get(sessions.listSummaries(1)[0].id);
    assert.equal(session.status, 'error');
    assert.equal(session.usage.totalTokens, 50);
  });

  it('does not start a model call in observe mode or in an unapproved chat', async (t) => {
    const { cfg, runner, append } = fixture(t);
    cfg.runtime.mode = 'observe';
    append(1);
    globalThis.fetch = async () => assert.fail('unexpected model request');
    await runner.wake('group:1');
    cfg.runtime.mode = 'active';
    await runner.wake('group:2');
    assert.equal(runner.activeRuns.size, 0);
  });

  it('caps a continuously extended debounce window at the first-message deadline', async (t) => {
    const { runner, append } = fixture(t);
    append(1);
    const started = Date.now();
    const elapsed = await new Promise((resolve) => {
      runner.wake = async () => resolve(Date.now() - started);
      runner.scheduleWake('group:1');
      const timer = setInterval(() => runner.scheduleWake('group:1'), 10);
      t.after(() => clearInterval(timer));
    });
    assert.ok(elapsed >= 100 && elapsed < 300, `elapsed=${elapsed}`);
  });

  it('cancels a running request and releases the batch for a later attempt', async (t) => {
    const { runner, store, append } = fixture(t);
    append(1);
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    globalThis.fetch = async (_url, { signal }) => {
      started();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    };
    const task = runner.wake('group:1');
    await ready;
    await runner.abortAll();
    await task;
    assert.equal(store.findByMid('group:1', 1).state, 'pending');
    assert.equal(runner.runningChats.size, 0);
  });
});

process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
