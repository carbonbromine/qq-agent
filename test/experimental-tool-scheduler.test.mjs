import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
  annotateExperimentalToolSchemas,
  experimentalToolSchedulerConfig,
  ExperimentalToolBatch
} from '../src/experimental-tool-scheduler.js';

function call(id, name, args = {}) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  };
}

test('disabled experiment preserves tool schema object and defaults to old path', () => {
  const tools = [{ type: 'function', function: { name: 'finish', description: 'old', parameters: {} } }];
  assert.deepEqual(experimentalToolSchedulerConfig({}), {
    enabled: false,
    maxParallelReads: 4
  });
  // 关闭时必须直接返回同一引用：不修改 description，也不改变 prompt hash 输入。
  assert.equal(annotateExperimentalToolSchemas(tools, {}), tools);
  assert.equal(tools[0].function.description, 'old');
});

test('enabled experiment annotates a clone without mutating base schemas', () => {
  const tools = [
    { type: 'function', function: { name: 'web_search', description: 'read', parameters: {} } },
    { type: 'function', function: { name: 'send_message', description: 'send', parameters: {} } },
    { type: 'function', function: { name: 'finish', description: 'finish', parameters: {} } }
  ];
  const next = annotateExperimentalToolSchemas(tools, {
    toolSchedulerPilot: { enabled: true }
  });
  assert.notEqual(next, tools);
  assert.equal(tools[0].function.description, 'read');
  assert.match(next[0].function.description, /并行执行/);
  assert.match(next[1].function.description, /同轮再调用 finish/);
  assert.match(next[2].function.description, /前置工具全部成功/);
});

test('consecutive read tools execute concurrently but are returned in host order', async () => {
  const calls = [
    call('a', 'web_search', { query: 'a' }),
    call('b', 'get_message_detail', { messageId: 1 }),
    call('c', 'send_message', { messages: 'done' }),
    call('d', 'finish', { summary: 'done' })
  ];
  const starts = [];
  const finishes = [];
  let active = 0;
  let peak = 0;
  const batch = new ExperimentalToolBatch(calls, {
    maxParallelReads: 4,
    execute: async (item, index) => {
      const name = item.function.name;
      starts.push(name);
      active += 1;
      peak = Math.max(peak, active);
      if (index === 0) await delay(35);
      if (index === 1) await delay(5);
      active -= 1;
      finishes.push(name);
      return { content: name };
    }
  });

  const first = await batch.next('web_search', calls[0].function.arguments);
  assert.equal(first.result.content, 'web_search');
  assert.deepEqual(starts.slice(0, 2).sort(), ['get_message_detail', 'web_search']);
  assert.deepEqual(finishes.slice(0, 2), ['get_message_detail', 'web_search']);
  assert.equal(peak, 2);
  assert.equal(starts.includes('send_message'), false);

  const second = await batch.next('get_message_detail', calls[1].function.arguments);
  assert.equal(second.result.content, 'get_message_detail');
  assert.equal(starts.includes('send_message'), false);

  await batch.next('send_message', calls[2].function.arguments);
  assert.equal(starts.at(-1), 'send_message');
  await batch.next('finish', calls[3].function.arguments);
  assert.equal(starts.at(-1), 'finish');
  assert.deepEqual(batch.metrics(), {
    parallelWaves: 1,
    parallelCalls: 2,
    finishBarrierBlocks: 0,
    trailingSkipped: 0
  });
});

test('parallel read concurrency respects configured limit', async () => {
  const calls = [
    call('a', 'web_search'),
    call('b', 'web_fetch'),
    call('c', 'memory_query')
  ];
  let active = 0;
  let peak = 0;
  const batch = new ExperimentalToolBatch(calls, {
    maxParallelReads: 2,
    execute: async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(10);
      active -= 1;
      return { content: item.function.name };
    }
  });
  for (const item of calls) {
    await batch.next(item.function.name, item.function.arguments);
  }
  assert.equal(peak, 2);
  assert.equal(batch.metrics().parallelCalls, 3);
});

test('failed earlier tool blocks finish instead of committing terminal state', async () => {
  const calls = [
    call('a', 'send_message', { messages: 'x' }),
    call('b', 'finish', { summary: 'sent' })
  ];
  const executed = [];
  const batch = new ExperimentalToolBatch(calls, {
    execute: async (item) => {
      executed.push(item.function.name);
      return item.function.name === 'send_message'
        ? { content: 'send failed', isError: true }
        : { content: 'finished' };
    }
  });
  const send = await batch.next('send_message', calls[0].function.arguments);
  assert.equal(send.result.isError, true);
  const finish = await batch.next('finish', calls[1].function.arguments);
  assert.equal(finish.result.isError, true);
  assert.equal(finish.result.errorCode, 'FINISH_BARRIER_BLOCKED');
  assert.deepEqual(executed, ['send_message']);
  assert.equal(batch.metrics().finishBarrierBlocks, 1);
});

test('finish is a hard barrier and tools after it never execute', async () => {
  const calls = [
    call('a', 'finish', { summary: 'done' }),
    call('b', 'send_message', { messages: 'must not send' })
  ];
  const executed = [];
  const batch = new ExperimentalToolBatch(calls, {
    execute: async (item) => {
      executed.push(item.function.name);
      return { content: 'ok' };
    }
  });
  const finish = await batch.next('finish', calls[0].function.arguments);
  assert.equal(finish.result.isError, undefined);
  const trailing = await batch.next('send_message', calls[1].function.arguments);
  assert.equal(trailing.result.isError, true);
  assert.equal(trailing.result.errorCode, 'SKIPPED_AFTER_FINISH_BARRIER');
  assert.deepEqual(executed, ['finish']);
  assert.equal(batch.metrics().trailingSkipped, 1);
});

test('batch mismatch fails closed to caller fallback instead of guessing call identity', async () => {
  const calls = [call('a', 'web_search', { query: 'a' })];
  const batch = new ExperimentalToolBatch(calls, {
    execute: async () => ({ content: 'unexpected' })
  });
  const result = await batch.next('web_search', JSON.stringify({ query: 'different' }));
  assert.equal(result.handled, false);
});
