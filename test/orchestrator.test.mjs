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
      stickers: {}, sender, onebot: {
        selfId: '888',
        selfNickname: 'bot',
        getGroupInfo: async () => ({ group_name: 'test' })
      }
    });
    const original = globalThis.fetch;
    t.after(async () => { await runner.abortAll(); store.close(); globalThis.fetch = original; });
    const append = (mid, text = 'hi', senderId = '42', reply = null) => store.appendIncoming('group:1', {
      mid, text, senderId, senderName: `member-${senderId}`, reply
    });
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
                hypotheses: ['第二项可能异常'],
                evidence: ['第一项检查结果正常'],
                facts: ['第一项正常'],
                rejectedDirections: ['不是第一项导致'],
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
    assert.deepEqual(handoffs[0].state.hypotheses, ['第二项可能异常']);
    assert.deepEqual(handoffs[0].state.rejectedDirections, ['不是第一项导致']);
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

  it('passes provider reasoning content into the next tool round', async (t) => {
    const { runner, append } = fixture(t);
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        return Response.json({
          choices: [{
            message: {
              reasoning_content: '先读取成员再决定',
              tool_calls: [{
                id: 'members-1',
                type: 'function',
                function: { name: 'get_active_members', arguments: '{}' }
              }]
            }
          }],
          usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 40, total_tokens: 110 }
        });
      }
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { prompt_tokens: 120, prompt_cache_hit_tokens: 100, total_tokens: 130 }
      });
    };

    append(1);
    await runner.wake('group:1');

    assert.equal(requests.length, 2);
    const assistant = requests[1].messages.find((m) => m.role === 'assistant');
    assert.equal(assistant.reasoning_content, '先读取成员再决定');
    const session = runner.sessions.get(runner.sessions.listSummaries(1)[0].id);
    assert.equal(session.callUsage.length, 2);
    assert.equal(session.callUsage[0].cacheHitRate, 0.4);
    assert.equal(session.inputRound, 2);
    assert.ok(session.inputTools.length > 0);
    const auditedAssistant = session.inputMessages.find((m) => m.role === 'assistant');
    assert.equal(auditedAssistant.reasoning_content, '先读取成员再决定');
    assert.equal(auditedAssistant.tool_calls[0].function.name, 'get_active_members');
    assert.ok(session.inputPayloadChars > 0);
  });

  it('deterministically wakes the same participant inside the threaded continuation window', async (t) => {
    const { cfg, runner, store, append } = fixture(t);
    cfg.conversation.mode = 'threaded';
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
                  arguments: JSON.stringify({ messages: ['继续说'], replyToMessageId: 1 })
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

    append(1, '@bot 先聊这个', '42');
    append(2, '我在旁边说一句', '43');
    await runner.wake('group:1');
    const thread = store.getConversationThread('group:1');
    assert.ok(thread);
    assert.deepEqual(thread.participantIds, ['42']);
    assert.ok(store.latestThreadCheckpoint('group:1'));

    cfg.store.contextTier = 1;
    cfg.store.randomPercent = 0;
    append(3, '旁观者继续说', '43');
    await runner.wake('group:1');
    assert.equal(calls, 2, '未被回复的旁观者不应获得续接资格');
    append(4, '那接下来呢', '42');
    await runner.wake('group:1');

    assert.equal(calls, 3, '普通跟话应绕过低概率门控并进入第二次模型调用');
    const latest = runner.sessions.listSummaries(1)[0];
    const latestDetail = runner.sessions.get(latest.id);
    assert.equal(latestDetail.contextTier, 5);
    assert.match(latestDetail.contextReason, /续接/);
  });

  it('deterministically wakes a reply to the bot without an existing thread', async (t) => {
    const { cfg, runner, append } = fixture(t);
    cfg.conversation.mode = 'threaded';
    cfg.store.contextTier = 1;
    cfg.store.randomPercent = 0;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { total_tokens: 10 }
      });
    };

    append(1, '你刚才那句什么意思', '43', {
      senderId: '888',
      sender: 'bot',
      text: '上一条机器人消息'
    });
    await runner.wake('group:1');

    assert.equal(calls, 1);
    const latest = runner.sessions.get(runner.sessions.listSummaries(1)[0].id);
    assert.equal(latest.contextTier, 5);
    assert.equal(latest.contextReason, '续接：引用机器人');
  });

  it('supports per-group lifecycle mode and reuses the append-only DeepSeek transcript', async (t) => {
    const { cfg, runner, store, append } = fixture(t);
    cfg.conversation.mode = 'legacy';
    cfg.conversation.unifiedMode = false;
    cfg.conversation.groupModes = { 1: 'lifecycle' };
    cfg.store.contextTier = 1;
    cfg.store.randomPercent = 0;
    const requests = [];
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        return Response.json({
          choices: [{
            message: {
              reasoning_content: '先回应并保持当前生命周期',
              tool_calls: [{
                id: 'send-life-1',
                type: 'function',
                function: { name: 'send_message', arguments: JSON.stringify({ messages: ['继续说'] }) }
              }]
            }
          }],
          usage: { total_tokens: 10 }
        });
      }
      if (requests.length === 2) {
        return Response.json({
          choices: [{ message: { reasoning_content: '已经回复，等待后续', content: 'done' } }],
          usage: { total_tokens: 10 }
        });
      }
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { total_tokens: 10 }
      });
    };

    append(1, '@bot 开始生命周期', '42');
    await runner.wake('group:1');
    const firstThread = store.getConversationThread('group:1');
    assert.equal(firstThread.mode, 'lifecycle');
    assert.equal(firstThread.state, 'active');
    assert.ok(firstThread.hardDeadline > firstThread.idleDeadline);
    assert.ok(store.getThreadTurns(firstThread.threadId).length >= 3);

    append(2, '路过说一句', '99');
    await runner.wake('group:1');

    assert.equal(requests.length, 3, '生命周期内任意参与者消息都应进入模型');
    assert.ok(requests[2].messages.length > 2, '第二次运行应携带持久化 transcript');
    assert.deepEqual(
      requests[2].messages.slice(0, requests[1].messages.length),
      requests[1].messages,
      '生命周期下一次请求应完整复用上一请求前缀'
    );
    const priorReasoning = requests[2].messages.find(
      (message) => message.reasoning_content === '先回应并保持当前生命周期'
    );
    assert.ok(priorReasoning, 'DeepSeek reasoning_content 应跨生命周期调用续传');
    assert.ok(
      requests[2].messages.some((message) => message.reasoning_content === '已经回复，等待后续'),
      '终止轮 reasoning_content 也应随实际发言记录续传'
    );
    assert.match(
      String(requests[2].messages.at(-1)?.content || ''),
      /【生命周期续接】/
    );
    const secondThread = store.getConversationThread('group:1');
    assert.equal(secondThread.threadId, firstThread.threadId);
    assert.equal(secondThread.state, 'listening', '无回复后应进入短空闲监听状态');
    const latest = runner.sessions.get(runner.sessions.listSummaries(1)[0].id);
    assert.equal(latest.contextTier, 6);
    assert.match(latest.contextReason, /生命周期/);
    assert.deepEqual(
      latest.injectedMessages,
      requests[2].messages.slice(1, -1),
      'Session 应单独保存生命周期注入的 provider transcript'
    );
    assert.deepEqual(
      latest.inputMessages,
      requests[2].messages,
      'Session 应保存当前轮发送给模型的完整 messages'
    );
  });

  it('consumes rollover-armed state with the next arbitrary message', async (t) => {
    const { cfg, runner, store, append } = fixture(t);
    cfg.conversation.mode = 'lifecycle';
    cfg.store.contextTier = 1;
    cfg.store.randomPercent = 0;
    const old = store.updateLifecycleThread('group:1', {
      disposition: 'active',
      participantIds: ['42'],
      promptHash: 'old-prefix'
    });
    store.armLifecycleRollover('group:1', 'hard-lifetime', 600000);
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({
        choices: [{ message: { content: 'not related, stay silent' } }],
        usage: { total_tokens: 10 }
      });
    };

    append(1, '完全普通的新消息', '99');
    await runner.wake('group:1');

    assert.equal(calls, 1);
    const latest = runner.sessions.get(runner.sessions.listSummaries(1)[0].id);
    assert.equal(latest.contextTier, 7);
    const next = store.getConversationThread('group:1');
    assert.notEqual(next.threadId, old.threadId);
    assert.equal(next.state, 'listening');
  });

  it('honors an explicit active lifecycle disposition even without sending', async (t) => {
    const { cfg, runner, store, append } = fixture(t);
    cfg.conversation.mode = 'lifecycle';
    globalThis.fetch = async () => Response.json({
      choices: [{
        message: {
          tool_calls: [{
            id: 'finish-active',
            type: 'function',
            function: {
              name: 'finish',
              arguments: JSON.stringify({
                summary: '等待对方补充日志',
                topic: '继续排查',
                openQuestions: ['完整日志是什么'],
                nextStep: '等待日志',
                threadDisposition: 'active'
              })
            }
          }]
        }
      }],
      usage: { total_tokens: 10 }
    });

    append(1, '@bot 我稍后补日志', '42');
    await runner.wake('group:1');

    const thread = store.getConversationThread('group:1');
    assert.equal(thread.state, 'active');
    assert.ok(thread.idleDeadline - thread.updatedAt >= 19 * 60000);
    assert.equal(store.latestThreadCheckpoint('group:1').state.nextStep, '等待日志');
  });

  it('clears handoff memory without closing a listening lifecycle', async (t) => {
    const { cfg, runner, store, memory, append } = fixture(t);
    cfg.conversation.mode = 'lifecycle';
    memory.setHandoff('group:1', { topic: '旧话题', summary: '应当清除' });
    globalThis.fetch = async () => Response.json({
      choices: [{
        message: {
          tool_calls: [{
            id: 'finish-clear-memory',
            type: 'function',
            function: {
              name: 'finish',
              arguments: JSON.stringify({
                summary: '旧话题结束，但继续监听新消息',
                threadDisposition: 'listening',
                clearHandoff: true
              })
            }
          }]
        }
      }],
      usage: { total_tokens: 10 }
    });

    append(1, '@bot 换个话题', '42');
    await runner.wake('group:1');

    assert.equal(memory.getHandoff('group:1'), null);
    assert.equal(store.getConversationThread('group:1')?.state, 'listening');
  });

  it('keeps the lifecycle thread id on the Session that closes it', async (t) => {
    const { cfg, runner, store, append } = fixture(t);
    cfg.conversation.mode = 'lifecycle';
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({
        choices: [{
          message: {
            tool_calls: [{
              id: `finish-${calls}`,
              type: 'function',
              function: {
                name: 'finish',
                arguments: JSON.stringify({
                  summary: calls === 1 ? '继续' : '结束',
                  threadDisposition: calls === 1 ? 'active' : 'close'
                })
              }
            }]
          }
        }],
        usage: { total_tokens: 10 }
      });
    };

    append(1, '@bot 开始', '42');
    await runner.wake('group:1');
    const threadId = store.getConversationThread('group:1')?.threadId;

    append(2, '结束吧', '42');
    await runner.wake('group:1');
    const latest = runner.sessions.get(runner.sessions.listSummaries(1)[0].id);

    assert.ok(threadId);
    assert.equal(store.getConversationThread('group:1'), null);
    assert.equal(latest.threadId, threadId);
    assert.equal(latest.threadState, 'closed');
  });

  it('does not drop a previously claimed retry when the trigger state changes', async (t) => {
    const { cfg, runner, store, append } = fixture(t);
    cfg.store.contextTier = 1;
    cfg.store.randomPercent = 0;
    append(1, '普通消息', '42');
    const firstLease = store.claimUnread('group:1');
    store.failLease(firstLease.id, 'temporary failure', { delayMs: 0 });
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { total_tokens: 10 }
      });
    };

    await runner.wake('group:1');

    assert.equal(calls, 1);
    assert.equal(store.findByMid('group:1', 1).read, true);
    const latest = runner.sessions.get(runner.sessions.listSummaries(1)[0].id);
    assert.equal(latest.contextReason, '失败批次重试');
  });

  it('does not recreate a lifecycle after its mode is changed during a run', async (t) => {
    const { cfg, runner, store, append } = fixture(t);
    cfg.conversation.mode = 'lifecycle';
    globalThis.fetch = async () => {
      cfg.conversation.mode = 'legacy';
      return Response.json({
        choices: [{ message: { content: 'done' } }],
        usage: { total_tokens: 10 }
      });
    };

    append(1, '@bot start', '42');
    await runner.wake('group:1');

    assert.equal(store.findByMid('group:1', 1).read, true);
    assert.equal(store.getConversationThread('group:1'), null);
  });
});

process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
