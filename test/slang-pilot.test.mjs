import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inactiveSlangPilotStatus, SlangPilotManager } from '../src/slang-pilot.js';

test('retired slang research keeps only a non-operational compatibility surface', async () => {
  const status = inactiveSlangPilotStatus({ enabled: true });
  assert.equal(status.enabled, false);
  assert.equal(status.active, false);
  assert.equal(status.retired, true);

  const manager = new SlangPilotManager();
  assert.equal(manager.start().active, false);
  assert.deepEqual(manager.list(), []);
  assert.equal(manager.detail('anything'), null);
  assert.throws(() => manager.decideResearch('id', 'approve'), /已下线/);
  assert.throws(() => manager.decideAdmission('id', 'approve'), /已下线/);
  assert.throws(() => manager.retryResearch('id'), /已下线/);
  await manager.stop();
});
