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
  readMemoryAssetSummary,
  readSlangAssets
} = await import('../src/asset-observer.js');

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('builds a read-only inventory for stickers, slang, memory, and identities', async (t) => {
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
    getIdentityStatus: () => ({
      enabled: true,
      active: true,
      people: 4,
      sources: 6
    })
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
  assert.equal(overview.identity.people, 4);

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
