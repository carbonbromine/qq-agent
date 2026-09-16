import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-backup-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { backupPersonBeforeConsolidation } = await import('../src/memory-consolidation-backup.js');

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('consolidation keeps append-only global history and legacy latest snapshot', () => {
  const person = {
    version: 2,
    userId: '114514',
    name: '测试人物',
    impressions: [
      { content: '旧印象 A', createdAt: 100, lastObservedAt: 200, sourceChatKeys: ['group:456'] },
      { content: '旧印象 B', createdAt: 300, lastObservedAt: 400, sourceChatKeys: ['private:114514'] }
    ],
    sourceChatKeys: ['group:456', 'private:114514'],
    updatedAt: 400,
    lastConsolidatedAt: 0
  };

  const first = backupPersonBeforeConsolidation(person, {
    sourceChatKey: 'group:456',
    at: 1000
  });
  const second = backupPersonBeforeConsolidation(person, {
    sourceChatKey: 'group:456',
    at: 2000
  });

  assert.ok(first && second && first !== second);
  const historyDir = path.join(dataDir, 'memory', 'backups', 'consolidation', '114514');
  const history = fs.readdirSync(historyDir).filter((name) => name.endsWith('.json'));
  assert.equal(history.length, 2, 'global audit history must be append-only');

  const payload = JSON.parse(fs.readFileSync(second, 'utf8'));
  assert.equal(payload.reason, 'consolidation');
  assert.equal(payload.sourceChatKey, 'group:456');
  assert.equal(payload.backedUpAt, 2000);
  assert.deepEqual(payload.person, person);

  const legacy = JSON.parse(fs.readFileSync(
    path.join(dataDir, 'memory', 'backups', 'group_456', '114514.json'),
    'utf8'
  ));
  assert.deepEqual(legacy, person, 'legacy path keeps the latest pre-consolidation person snapshot');
});
