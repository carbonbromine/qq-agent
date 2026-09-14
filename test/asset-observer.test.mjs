import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-asset-observer-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const {
  AssetObserver,
  buildSlangContextForChat,
  readMemoryAssetSummary,
  readSlangAssets
} = await import('../src/asset-observer.js');
const { IdentityStore } = await import('../src/identity-store.js');
const { MemoryStore } = await import('../src/memory.js');
const { StickerManager } = await import('../src/sticker-manager.js');

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('builds an inventory for stickers, slang, memory, and identities without mutating on read', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'inventory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const slangFile = path.join(dir, 'slang.json');
  fs.writeFileSync(slangFile, JSON.stringify([
    {
      id: 's1', content: '开香槟', meaning: '提前庆祝',
      usage: '事情还没完成时调侃', status: 'confirmed',
      source: 'ai', count: 8, evidence: [{ text: '先别开香槟' }]
    },
    {
      id: 's2', content: '神秘词', status: 'candidate',
      source: 'manual', count: 2
    }
  ]));
  const memberDir = path.join(dir, 'memory', 'group_100');
  fs.mkdirSync(memberDir, { recursive: true });
  const memberFile = path.join(memberDir, '123456.json');
  fs.writeFileSync(memberFile, JSON.stringify({
    userId: '123456',
    impressions: [{ content: '喜欢测试', createdAt: 1 }]
  }));
  fs.writeFileSync(path.join(memberDir, '_handoff.json'), JSON.stringify({ topic: '测试' }));
  const beforeSlang = digest(slangFile);
  const beforeMember = digest(memberFile);
  const identityStore = new IdentityStore({ dataDir: dir });
  identityStore.rebuild({
    activityRows: [{
      userId: '123456',
      chatKey: 'group:100',
      name: '测试成员',
      messageCount: 9,
      firstSeenAt: 1,
      lastSeenAt: 2
    }]
  });
  identityStore.close();

  let refreshes = 0;
  const observer = new AssetObserver({
    dataDir: dir,
    stickers: {
      enabled: true,
      syncedAt: 123,
      entries: [
        {
          id: 'happy',
          url: 'https://example.test/happy.png',
          desc: '开心',
          localNote: '庆祝时用',
          tags: ['开心', '庆祝'],
          source: 'qq',
          useCount: 3
        },
        {
          id: 'collected_1',
          url: 'https://example.test/reaction.gif',
          desc: '震惊',
          source: 'ai',
          useCount: 0
        }
      ],
      sync: async () => {
        refreshes += 1;
        return { entries: [], fromCache: false };
      }
    },
    getIdentityStatus: () => ({ enabled: false, active: false })
  });

  const overview = observer.overview();
  assert.equal(overview.stickers.total, 2);
  assert.equal(overview.stickers.annotated, 2);
  assert.equal(overview.stickers.used, 1);
  assert.equal(overview.slang.total, 2);
  assert.equal(overview.slang.counts.confirmed, 1);
  assert.equal(overview.slang.active, false);
  assert.equal(overview.memory.chats, 1);
  assert.equal(overview.memory.people, 1);
  assert.equal(overview.memory.impressions, 1);
  assert.equal(overview.memory.handoffs, 1);
  assert.equal(overview.identity.people, 1);
  assert.equal(overview.identity.databaseExists, true);
  const identities = observer.identitySnapshot();
  assert.equal(identities.entries[0].userId, '123456');
  assert.equal(identities.entries[0].messageCount, 9);

  const stickers = await observer.listStickers({ query: '庆祝' });
  assert.equal(stickers.matched, 1);
  assert.equal(stickers.entries[0].id, 'happy');
  assert.equal('url' in stickers.entries[0], false, '观测 API 不得泄露临时图片 URL');
  await observer.listStickers({ refresh: true });
  assert.equal(refreshes, 1);

  const slang = observer.listSlang({ status: 'confirmed', query: '庆祝' });
  assert.equal(slang.matched, 1);
  assert.equal(slang.entries[0].content, '开香槟');
  assert.equal(readSlangAssets(dir).counts.candidate, 1);
  assert.equal(readMemoryAssetSummary(dir).impressions, 1);
  assert.equal(digest(slangFile), beforeSlang);
  assert.equal(digest(memberFile), beforeMember);
});

test('reports an absent slang library without creating one', (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'missing-slang-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snapshot = readSlangAssets(dir);
  assert.equal(snapshot.exists, false);
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.total, 0);
  assert.equal(fs.existsSync(path.join(dir, 'slang.json')), false);
});

test('injects only confirmed slang visible to the current chat', (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'slang-context-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'slang.json'), JSON.stringify([
    {
      id: 'global',
      content: '开香槟',
      meaning: '提前庆祝',
      status: 'confirmed',
      scope: 'global-safe',
      count: 4
    },
    {
      id: 'private-visible',
      content: '无名剑法',
      meaning: '原群内部的说法',
      status: 'confirmed',
      scope: 'chat-private',
      scopeChatKey: 'group:100',
      count: 3
    },
    {
      id: 'private-hidden',
      content: '隔壁群暗号',
      meaning: '不能跨群',
      status: 'confirmed',
      scope: 'chat-private',
      scopeChatKey: 'group:200',
      count: 10
    },
    {
      id: 'candidate',
      content: '待确认',
      meaning: '尚未批准',
      status: 'candidate',
      count: 20
    }
  ]));
  const context = buildSlangContextForChat('group:100', { dataDir: dir, max: 8 });
  assert.match(context, /开香槟/);
  assert.match(context, /无名剑法/);
  assert.doesNotMatch(context, /隔壁群暗号/);
  assert.doesNotMatch(context, /待确认/);
});

test('creates, updates, and deletes managed AI assets', async (t) => {
  t.after(() => {
    fs.rmSync(path.join(root, 'stickers.json'), { force: true });
    fs.rmSync(path.join(root, 'sticker-assets'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'slang.json'), { force: true });
    fs.rmSync(path.join(root, 'memory'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'identity-pilot.sqlite'), { force: true });
    fs.rmSync(path.join(root, 'identity-pilot.sqlite-shm'), { force: true });
    fs.rmSync(path.join(root, 'identity-pilot.sqlite-wal'), { force: true });
  });
  const stickers = new StickerManager({ call: async () => [] });
  const memory = new MemoryStore();
  const observer = new AssetObserver({ dataDir: root, stickers, memory });

  const sticker = observer.addSticker({
    imageBuffer: Buffer.from('89504e470d0a1a0a00000000', 'hex'),
    desc: '手动图片',
    localNote: '测试备注',
    tags: ['测试'],
    usage: '需要时使用'
  });
  assert.equal(sticker.source, 'manual');
  assert.equal(sticker.hasImage, true);
  assert.equal('localFile' in sticker, false, '资产 API 不暴露本地文件路径');
  assert.equal(stickers.readImage(sticker.id).contentType, 'image/png');
  assert.match((await stickers.findForSend(sticker.id)).url, /^base64:\/\//);
  const updatedSticker = observer.updateSticker(sticker.id, {
    localNote: '已修改',
    tags: ['更新']
  });
  assert.equal(updatedSticker.localNote, '已修改');
  assert.deepEqual(updatedSticker.tags, ['更新']);
  assert.deepEqual(observer.deleteSticker(sticker.id), {
    removed: true,
    cleanupPending: false,
    warning: ''
  });
  assert.equal(observer.stickerSnapshot().total, 0);

  const slang = observer.addSlang({
    content: '开香槟',
    meaning: '提前庆祝',
    status: 'candidate'
  });
  assert.equal(slang.source, 'manual');
  const updatedSlang = observer.updateSlang(slang.id, {
    meaning: '在结果确定前庆祝',
    status: 'confirmed'
  });
  assert.equal(updatedSlang.status, 'confirmed');
  assert.equal(readSlangAssets(root).entries[0].meaning, '在结果确定前庆祝');
  const scopedSlang = observer.addSlang({
    content: '开香槟',
    meaning: '本群特有含义',
    status: 'candidate',
    scope: 'chat-private',
    scopeChatKey: 'group:100'
  });
  assert.notEqual(scopedSlang.id, slang.id);
  assert.equal(scopedSlang.scope, 'chat-private');
  assert.equal(observer.deleteSlang(slang.id), true);
  assert.equal(observer.deleteSlang(scopedSlang.id), true);
  assert.equal(readSlangAssets(root).total, 0);

  const person = observer.upsertIdentity({
    userId: '123456',
    primaryName: '测试人物',
    chatKey: 'group:100',
    profileNote: '偏好严谨讨论',
    isFriend: false
  });
  assert.equal(person.primaryName, '测试人物');
  assert.equal(person.safeProfile.note, '偏好严谨讨论');
  assert.equal(person.manuallyManaged, true);
  const preserved = new IdentityStore({ dataDir: root });
  preserved.rebuild({
    activityRows: [{
      userId: '123456',
      chatKey: 'group:100',
      name: '自动名称',
      messageCount: 3,
      firstSeenAt: 1,
      lastSeenAt: 2
    }]
  });
  preserved.close();
  assert.equal(observer.identitySnapshot().entries[0].primaryName, '测试人物');
  assert.equal(observer.identitySnapshot().entries[0].profileNote, '偏好严谨讨论');
  assert.equal(observer.deleteIdentity('123456'), true);
  const rebuilt = new IdentityStore({ dataDir: root });
  rebuilt.rebuild({
    activityRows: [{
      userId: '123456',
      chatKey: 'group:100',
      name: '自动名称',
      messageCount: 3,
      firstSeenAt: 1,
      lastSeenAt: 2
    }]
  });
  rebuilt.close();
  assert.equal(observer.identitySnapshot().entries.some((entry) =>
    entry.userId === '123456'), false, '手动删除的人物不会被重建立即恢复');

  observer.addMemory({
    chatKey: 'group:100',
    userId: '123456',
    name: '测试人物',
    content: '喜欢结构化记录'
  });
  let memories = observer.memorySummary();
  assert.equal(memories.entries[0].impressions[0].content, '喜欢结构化记录');
  observer.updateMemory({
    chatKey: 'group:100',
    userId: '123456',
    name: '测试人物',
    impressions: ['更新后的记忆']
  });
  memories = observer.memorySummary();
  assert.equal(memories.entries[0].impressions[0].content, '更新后的记忆');
  assert.equal(observer.deleteMemory({
    chatKey: 'group:100',
    userId: '123456'
  }), true);
  assert.equal(observer.memorySummary().entries.length, 0);
});
