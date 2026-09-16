import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-global-memory-identity-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
const { MemoryStore } = await import('../src/memory.js');
const { IdentityStore, readLegacyIdentityMemories } = await import('../src/identity-store.js');
const { ChatStore } = await import('../src/store.js');

const cfg = structuredClone(DEFAULT_CONFIG);
setRuntimeConfig(cfg);

test('IdentityStore person views consume the single global MemoryStore source', (t) => {
  const memoryDir = path.join(root, 'memory');
  fs.mkdirSync(path.join(memoryDir, 'group_100'), { recursive: true });
  fs.mkdirSync(path.join(memoryDir, 'private_12345'), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'group_100', '12345.json'), JSON.stringify({
    userId: '12345',
    name: 'Alice',
    impressions: [{ content: '喜欢 C++', createdAt: 100 }],
    updatedAt: 100
  }), 'utf8');
  fs.writeFileSync(path.join(memoryDir, 'private_12345', '12345.json'), JSON.stringify({
    userId: '12345',
    name: 'Alice',
    impressions: [{ content: '正在准备面试', createdAt: 200 }],
    updatedAt: 200
  }), 'utf8');

  const memory = new MemoryStore();
  // MemoryStore 构造阶段已完成旧文件迁移，因此 IdentityStore 的旧索引扫描应为空。
  assert.equal(readLegacyIdentityMemories(root).length, 0);

  const chatStore = new ChatStore(0, { dataDir: root });
  const now = Date.now();
  chatStore.appendIncoming('group:100', {
    mid: 1,
    ts: now - 1000,
    senderId: '12345',
    senderName: 'Alice',
    text: '群里消息'
  });
  chatStore.appendIncoming('private:12345', {
    mid: 2,
    ts: now,
    senderId: '12345',
    senderName: 'Alice',
    text: '私聊消息'
  });

  const identity = new IdentityStore({ dataDir: root });
  t.after(() => {
    identity.close();
    chatStore.close();
  });
  identity.rebuild({
    activityRows: chatStore.identityActivityRows(),
    legacyMemories: [],
    friends: []
  });

  const person = identity.getPerson('12345', { chatKey: 'group:100', maxMemories: 10 });
  assert.ok(person);
  assert.equal(person.globalMemoryCount, 2);
  assert.deepEqual(
    new Set(person.globalMemories.map((item) => item.content)),
    new Set(['喜欢 C++', '正在准备面试'])
  );
  assert.deepEqual(
    new Set(person.memorySourceChatKeys),
    new Set(['group:100', 'private:12345'])
  );
  assert.deepEqual(person.currentContextMemories, person.globalMemories);
  assert.equal(person.otherContextMemoryCount, 0);
  assert.equal(person.legacyMemoryCount, 0);

  const listed = identity.listPeople(10).find((item) => item.userId === '12345');
  assert.equal(listed.globalMemoryCount, 2);
  assert.equal(listed.legacyMemoryCount, 0);

  const queried = memory.query('group:999').memberImpression
    .filter((item) => item.userId === '12345')
    .map((item) => item.content);
  assert.deepEqual(new Set(queried), new Set(['喜欢 C++', '正在准备面试']));
});
