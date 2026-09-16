import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-backup-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { backupPersonBeforeConsolidation } = await import('../src/memory-consolidation-backup.js');
const { MemoryStore } = await import('../src/memory.js');

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

test('real replaceMember path snapshots same-source destructive writes', () => {
  const memory = new MemoryStore();
  memory.append('group:456', 'memberImpression', '真实调用链里的旧印象', {
    userId: '1919810',
    target: '集成人物'
  });
  const before = memory.getMember('', '1919810');

  memory.replaceMember('group:456', '1919810', '集成人物', ['整理后的摘要']);

  const legacyPath = path.join(dataDir, 'memory', 'backups', 'group_456', '1919810.json');
  assert.ok(fs.existsSync(legacyPath), 'replaceMember must protect the actual consolidation write path');
  assert.deepEqual(JSON.parse(fs.readFileSync(legacyPath, 'utf8')), before);

  const after = memory.getMember('', '1919810');
  assert.deepEqual(after.impressions.map((entry) => entry.content), ['整理后的摘要']);
});

test('first appearance in a new chat merges without creating a destructive-write backup', () => {
  const memory = new MemoryStore();
  memory.append('private:23333', 'memberImpression', '跨会话已有印象', {
    userId: '23333',
    target: '跨会话人物'
  });

  memory.replaceMember('group:999', '23333', '跨会话人物', ['新群提炼印象']);

  const legacyPath = path.join(dataDir, 'memory', 'backups', 'group_999', '23333.json');
  assert.equal(fs.existsSync(legacyPath), false, 'non-destructive first-source merge should not create a backup');
  const after = memory.getMember('', '23333');
  assert.deepEqual(
    new Set(after.impressions.map((entry) => entry.content)),
    new Set(['跨会话已有印象', '新群提炼印象'])
  );
});
