import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyStableFeaturePolicy } from '../src/stable-feature-policy.js';
test('graduated features are always active; retired V2 is unrevivable', () => {
  const cfg = { relationshipV2: { enabled: true, graduated: true, behaviorInjectionEnabled: true }, multimodalContextPilot: { enabled: false }, toolSchedulerPilot: { enabled: false, maxParallelReads: 6 } };
  applyStableFeaturePolicy(cfg);
  assert.deepEqual(cfg.relationshipV2, { enabled: false, graduated: false });
  assert.deepEqual(cfg.multimodalContextPilot, { enabled: true, graduated: true });
  assert.deepEqual(cfg.toolSchedulerPilot, { enabled: true, graduated: true, maxParallelReads: 6 });
});
