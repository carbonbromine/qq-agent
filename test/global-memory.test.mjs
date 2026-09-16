import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-global-memory-'));
process.env.QQ_AGENT_DATA_DIR = root;

const { MemoryStore } = await import('../src/memory.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.memory.handoffEnabled = true;
cfg.memory.handoffTtlMinutes = 30;
setRuntimeConfig(cfg);

test('global person memory migration and isolation rules', async (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const memoryRoot = path.join(root, 'memory');
  fs.mkdirSync(path.join(memoryRoot, 'group_100'), { recursive: true });
  fs.mkdirSync(path.join(memoryRoot, 'private_12345'), { recursive: true });

  fs.writeFileSync(path.join(memoryRoot, 'group_100', '12345.json'), JSON.stringify({
    userId: '12345',
    name: 'Alice',
    impressions: [{ content: '喜欢 C++', createdAt: 100 }],
    updatedAt: 100,
    lastConsolidatedAt: 0
  }), 'utf8');
  fs.writeFileSync(path.join(memoryRoot, 'private_12345', '12345.json'), JSON.stringify({
    userId: '12345',
    name: 'Alice',
    impressions: [{ content: '正在准备面试', createdAt: 200 }],
    updatedAt: 200,
    lastConsolidatedAt: 0
  }), 'utf8');

  const memory = new MemoryStore();

  await t.test('merges the same QQ across group and private memory files', () => {
    const member = memory.getMember('group:999', '12345');
    assert.deepEqual(member.impressions.map((x) => x.content), ['喜欢 C++', '正在准备面试']);
    assert.deepEqual(new Set(member.sourceChatKeys), new Set(['group:100', 'private:12345']));
    assert.ok(fs.existsSync(path.join(memoryRoot, 'people', '12345.json')));
    assert.ok(!fs.existsSync(path.join(memoryRoot, 'group_100', '12345.json')));
    assert.ok(!fs.existsSync(path.join(memoryRoot, 'private_12345', '12345.json')));
    assert.ok(fs.existsSync(path.join(memoryRoot, 'backups', 'global-people-v1', 'group_100', '12345.json')));
  });

  await t.test('injects a person global memory in a chat where it was never created', () => {
    const prompt = memory.formatForPrompt('group:999', { userIds: ['12345'] });
    assert.match(prompt, /【对群友的全局印象】/);
    assert.match(prompt, /喜欢 C\+\+/);
    assert.match(prompt, /正在准备面试/);

    memory.append('group:200', 'memberImpression', '爱玩烂梗', {
      userId: '12345',
      target: 'Alice'
    });
    assert.match(memory.formatForPrompt('group:100', { userIds: ['12345'] }), /爱玩烂梗/);
  });

  await t.test('does not erase old global memories when a known person is first consolidated in a new chat', () => {
    memory.append('group:400', 'memberImpression', '旧群里形成的长期印象', {
      userId: '24680',
      target: 'Carol'
    });
    memory.replaceMember('group:500', '24680', 'Carol', ['新群里新提炼的印象']);

    const member = memory.getMember('group:500', '24680');
    assert.deepEqual(
      member.impressions.map((x) => x.content),
      ['旧群里形成的长期印象', '新群里新提炼的印象']
    );
    assert.deepEqual(new Set(member.sourceChatKeys), new Set(['group:400', 'group:500']));
  });

  await t.test('keeps handoff state isolated by chatKey', () => {
    memory.setHandoff('group:100', { summary: '群里正在聊 A' });
    memory.setHandoff('private:12345', { summary: '私聊正在聊 B' });
    assert.match(memory.formatHandoffForPrompt('group:100'), /群里正在聊 A/);
    assert.doesNotMatch(memory.formatHandoffForPrompt('group:100'), /私聊正在聊 B/);
    assert.match(memory.formatHandoffForPrompt('private:12345'), /私聊正在聊 B/);
  });

  await t.test('clearing one source does not erase memories that still belong to another source', () => {
    memory.append('group:300', 'memberImpression', '只来自群300', {
      userId: '67890',
      target: 'Bob'
    });
    memory.append('private:67890', 'memberImpression', '只来自私聊', {
      userId: '67890',
      target: 'Bob'
    });

    memory.clear('group:300');
    const member = memory.getMember('private:67890', '67890');
    assert.deepEqual(member.impressions.map((x) => x.content), ['只来自私聊']);
    assert.equal(memory.getHandoff('group:300'), null);
  });
});
