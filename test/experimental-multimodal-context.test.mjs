import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalMultimodalMessages,
  multimodalContextPilotConfig,
  recordMultimodalToolResult,
  rewriteMultimodalLifecycleCommit
} from '../src/experimental-multimodal-context-core.js';

const store = {
  findByLocalId(chatKey, id) {
    const map = {
      7: { mid: -12345 },
      8: { mid: '9988' }
    };
    return chatKey === 'group:1' ? map[id] || null : null;
  }
};

test('pilot defaults disabled and not graduated', () => {
  assert.deepEqual(multimodalContextPilotConfig({}), {
    enabled: false,
    graduated: false
  });
});

test('disabled mode returns the exact commit object without touching legacy behavior', () => {
  const options = {
    chatKey: 'group:1',
    forceRollover: 'multimodal-context',
    messages: [],
    threadOptions: { promptTokens: 42000 }
  };
  const result = rewriteMultimodalLifecycleCommit(store, options, {});
  assert.equal(result, options);
});

test('non multimodal rollover is untouched even when experiment is enabled', () => {
  const options = { forceRollover: 'context-budget' };
  const result = rewriteMultimodalLifecycleCommit(store, options, {
    multimodalContextPilot: { enabled: true }
  });
  assert.equal(result, options);
});

test('explicit model close remains authoritative', () => {
  const options = {
    forceRollover: 'multimodal-context',
    closeReason: 'model-close'
  };
  const result = rewriteMultimodalLifecycleCommit(store, options, {
    multimodalContextPilot: { enabled: true }
  });
  assert.equal(result, options);
});

test('enabled pilot replaces raw multimodal rollover with a compact text continuation', () => {
  const options = {
    chatKey: 'group:1',
    forceRollover: 'multimodal-context',
    sourceMessageIds: [7, 8],
    checkpointState: {
      topic: '报错截图',
      summary: '截图显示连接超时，已经建议检查代理。',
      facts: ['错误发生在网络请求阶段'],
      decisions: ['先检查代理配置'],
      openQuestions: ['内网是否也受影响'],
      nextStep: '等待用户反馈测试结果',
      lastReply: '先把代理关掉再试一下'
    },
    messages: [],
    threadOptions: { promptTokens: 48000 }
  };
  const result = rewriteMultimodalLifecycleCommit(store, options, {
    multimodalContextPilot: { enabled: true },
    conversation: { lifecycleRolloverInputTokens: 32000 }
  });
  assert.notEqual(result, options);
  assert.equal(result.forceRollover, '');
  assert.equal(result.threadOptions.promptTokens, 31999);
  assert.equal(result.messages.length, 2);
  assert.match(result.messages[0].content, /#-12345/);
  assert.match(result.messages[0].content, /#9988/);
  assert.match(result.messages[0].content, /get_message_images/);
  assert.match(result.messages[0].content, /截图显示连接超时/);
  assert.equal(result.messages[1].content, '先把代理关掉再试一下');
  assert.doesNotMatch(JSON.stringify(result.messages), /data:image\//);
});

test('provider prompt tokens below rollover threshold are preserved exactly', () => {
  const options = {
    chatKey: 'group:1',
    forceRollover: 'multimodal-context',
    checkpointState: { summary: '看过一张表情包' },
    threadOptions: { promptTokens: 18000 }
  };
  const result = rewriteMultimodalLifecycleCommit(store, options, {
    multimodalContextPilot: { enabled: true },
    conversation: { lifecycleRolloverInputTokens: 32000 }
  });
  assert.equal(result.threadOptions.promptTokens, 18000);
});

test('canonical transcript remains valid when source message ids cannot be resolved', () => {
  const messages = canonicalMultimodalMessages({
    store: null,
    chatKey: 'group:1',
    checkpointState: { summary: '模型识别出这是一个无奈表情' },
    sourceMessageIds: [1]
  });
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant']);
  assert.match(messages[0].content, /原始图片数据未写入/);
  assert.match(messages[0].content, /无奈表情/);
  assert.equal(messages[1].content, '（本轮未向 QQ 发送消息）');
});

test('image tool observations are attached to the handoff only when experiment is enabled', () => {
  const session = { handoffDraft: { summary: 'done' } };
  const imageResult = {
    content: [
      { type: 'text', text: 'image' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }
    ]
  };
  recordMultimodalToolResult(session, 'get_message_images', { messageId: -77 }, imageResult, {
    multimodalContextPilot: { enabled: true }
  });
  recordMultimodalToolResult(session, 'get_sticker_image', { stickerId: 'cat-1' }, imageResult, {
    multimodalContextPilot: { enabled: true }
  });
  recordMultimodalToolResult(session, 'finish', {}, { content: 'ok' }, {
    multimodalContextPilot: { enabled: true }
  });
  assert.deepEqual(session.handoffDraft.multimodalSources, [
    { kind: 'message', id: '-77' },
    { kind: 'sticker', id: 'cat-1' }
  ]);

  const messages = canonicalMultimodalMessages({
    checkpointState: session.handoffDraft
  });
  assert.match(messages[0].content, /#-77/);
  assert.match(messages[0].content, /cat-1/);
  assert.match(messages[0].content, /get_sticker_image/);
});

test('disabled image observation path does not mutate the session', () => {
  const session = { handoffDraft: { summary: 'done' } };
  const result = { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] };
  assert.equal(recordMultimodalToolResult(session, 'get_message_images', { messageId: 1 }, result, {}), result);
  assert.equal(session.multimodalContextSources, undefined);
  assert.equal(session.handoffDraft.multimodalSources, undefined);
});
