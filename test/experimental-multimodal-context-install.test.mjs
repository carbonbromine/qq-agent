import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installExperimentalMultimodalContextPilot } from '../src/experimental-multimodal-context.js';

test('installer is idempotent and disabled multimodal path forwards exact options object', () => {
  class FakeStore {
    commitLifecycleRun(options) {
      this.received = options;
      return options;
    }
  }
  const cfg = { multimodalContextPilot: { enabled: false } };
  assert.equal(installExperimentalMultimodalContextPilot({
    StoreClass: FakeStore,
    getConfigFn: () => cfg
  }), true);
  assert.equal(installExperimentalMultimodalContextPilot({
    StoreClass: FakeStore,
    getConfigFn: () => cfg
  }), false);
  const store = new FakeStore();
  const options = { forceRollover: 'multimodal-context', marker: {} };
  assert.equal(store.commitLifecycleRun(options), options);
  assert.equal(store.received, options);
});

test('enabled installer rewrites only multimodal lifecycle commits', () => {
  class FakeStore {
    findByLocalId() { return { mid: 42 }; }
    commitLifecycleRun(options) {
      this.received = options;
      return options;
    }
  }
  const cfg = {
    multimodalContextPilot: { enabled: true },
    conversation: { lifecycleRolloverInputTokens: 32000 }
  };
  installExperimentalMultimodalContextPilot({ StoreClass: FakeStore, getConfigFn: () => cfg });
  const store = new FakeStore();
  const original = {
    chatKey: 'group:1',
    forceRollover: 'multimodal-context',
    sourceMessageIds: [1],
    checkpointState: { summary: '看过图片' },
    threadOptions: { promptTokens: 40000 }
  };
  const result = store.commitLifecycleRun(original);
  assert.notEqual(result, original);
  assert.equal(store.received.forceRollover, '');
  assert.equal(store.received.threadOptions.promptTokens, 31999);
  assert.match(store.received.messages[0].content, /#42/);
});
