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
    const handoffs = [];
    let currentHandoff = null;
    const memory = {
      formatForPrompt: () => '',
      formatHandoffForPrompt: () => currentHandoff
        ? `【上次会话交接】\n- 当前话题：${currentHandoff.topic || ''}\n- 已知上下文：${currentHandoff.summary || ''}`
        : '',
      getHandoff: () => currentHandoff,
      setHandoff: (chatKey, state, meta) => {
        if (state.clearHandoff === true) {
          currentHandoff = null;
          handoffs.push({ chatKey, state: structuredClone(state), meta: structuredClone(meta) });
          return null;
        }
        const value = { ...state, ...meta, updatedAt: Date.now() };
        currentHandoff = { ...(currentHandoff || {}), ...value };
        handoffs.push({ chatKey, state: structuredClone(state), meta: structuredClone(meta) });
        return currentHandoff;
      },
      clearHandoff: () => { currentHandoff = null; }
    };
    const sender = {
      sendTextBatch: async (_chatKey, messages) => ({
        sent: messages.map((text, i) => ({ text, at: Date.now(), messageId: i + 1 })),
        failed: []
      })
    };
    const runner = new Orchestrator({
      store, sessions, memory,
      stickers: {}, sender, onebot: { getGroupInfo: async () => ({ group_name: 'test' }) }
    });
    const original = globalThis.fetch;
    t.after(async () => { await runner.abortAll(); store.close(); globalThis.fetch = original; });
    const append = (mid) => store.appendIncoming('group:1', { mid, text: 'hi', senderId: '42' });
    return { cfg, runner, store, sessions, memory, handoffs, append };
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

  it('commits an explicit finish handoff after a successful batch', async (t) => {
    const { runner, store, handoffs, append } = fixture(t);
    append(1);
    globalThis.fetch = async () => Response.json({
      choices: [{
        message: {
          tool_calls: [{
            id: 'finish-1',
            type: 'function',
            function: {
              name: 'finish',
              arguments: JSON.stringify({
                summary: '已经确认第一项',
                topic: '继续排查',
                facts: ['第一项正常'],
                openQuestions: ['第二项是否正常'],
                nextStep: '等待下一条结果'
              })
            }
          }]
        }
      }],
      usage: { total_tokens: 10 }
    });

    await runner.wake('group:1');

    assert.equal(store.findByMid('group:1', 1).read, true);
    assert.equal(handoffs.length, 1);
    assert.equal(handoffs[0].state.topic, '继续排查');
    assert.deepEqual(handoffs[0].state.openQuestions, ['第二项是否正常']);
    assert.deepEqual(handoffs[0].meta.participantIds, ['42']);
    assert.ok(handoffs[0].meta.sourceSessionId);
  });

  it('creates a conservative handoff when a successful reply ends without finish', async (t) => {
    const { runner, handoffs, append } = fixture(t);
    append(1);
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'send-1',
                type: 'function',
                function: {
                  name: 'send_message',
                  arguments: JSON.stringify({ messages: ['请继续发结果'] })
                }
              }]
            }
          }],
          usage: { total_tokens: 10 }
        });
      }
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { total_tokens: 10 }
      });
    };

    await runner.wake('group:1');

    assert.equal(handoffs.length, 1);
    assert.match(handoffs[0].state.summary, /本轮收到/);
    assert.match(handoffs[0].state.summary, /请继续发结果/);
  });

  it('injects the previous run handoff into the next stateless session', async (t) => {
    const { runner, append } = fixture(t);
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        return Response.json({
          choices: [{
            message: {
              tool_calls: [{
                id: 'finish-1',
                type: 'function',
                function: {
                  name: 'finish',
                  arguments: JSON.stringify({
                    summary: '第一轮确认了连接正常',
                    topic: '继续检查附件',
                    openQuestions: ['附件是否成功落盘'],
                    nextStep: '等待第二轮结果'
                  })
                }
              }]
            }
          }],
          usage: { total_tokens: 10 }
        });
      }
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { total_tokens: 10 }
      });
    };

    append(1);
    await runner.wake('group:1');
    append(2);
    await runner.wake('group:1');

    assert.equal(requests.length, 2);
    const secondPrompt = String(requests[1].messages?.[1]?.content || '');
    assert.match(secondPrompt, /【上次会话交接】/);
    assert.match(secondPrompt, /继续检查附件/);
    assert.match(secondPrompt, /第一轮确认了连接正常/);
  });
});

process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
