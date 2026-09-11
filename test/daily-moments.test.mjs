import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-daily-moments-'));
process.env.QQ_AGENT_DATA_DIR = root;

const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
const { DailyMomentsManager, nextDailyMomentAt } = await import('../src/daily-moments.js');

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('calculates the next daily run from the Shanghai wall clock', () => {
  const before = Date.parse('2026-09-12T15:29:00Z');
  const afterTarget = Date.parse('2026-09-12T15:31:00Z');
  const cfg = { hour: 23, minute: 30 };
  assert.equal(nextDailyMomentAt(before, cfg), Date.parse('2026-09-12T15:30:00Z'));
  assert.equal(nextDailyMomentAt(afterTarget, cfg), Date.parse('2026-09-13T15:30:00Z'));
});

test('summarizes once, publishes an optional refreshed image, and prevents duplicate daily runs', async () => {
  const now = Date.parse('2026-09-12T14:00:00Z');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.dailyMoments = {
    ...cfg.dailyMoments,
    enabled: true,
    minMessagesPerGroup: 1,
    allowImages: true,
    maxImages: 1
  };
  setRuntimeConfig(cfg);

  const message = {
    id: 1,
    mid: '9001',
    ts: now - 60_000,
    self: false,
    senderName: '群友',
    text: '今天聊到一个值得继续研究的话题',
    media: [{ kind: 'image', url: 'https://example.com/expired.jpg' }]
  };
  const published = [];
  const toolSteps = [
    { name: 'web_search', args: { query: '测试研究问题' } },
    {
      name: 'submit_daily_moment',
      args: {
        decision: 'skip',
        reason: '今天先不发',
        content: '',
        imageIds: [],
        groupSummaries: [{ chatKey: 'group:1', summary: '讨论了一个新话题' }]
      }
    },
    { name: 'inspect_image_candidate', args: { imageId: 'image-1' } },
    {
      name: 'submit_daily_moment',
      args: {
        decision: 'publish',
        reason: '有一条值得记录',
        content: '测试群的群友说 QQ 12345678，认真追一个小问题比刷十个结论有意思。',
        imageIds: ['image-1'],
        groupSummaries: [{ chatKey: 'group:1', summary: '从闲聊延伸出一个研究问题' }]
      }
    }
  ];
  let completionCalls = 0;
  const searches = [];
  const manager = new DailyMomentsManager({
    store: {
      listChats: () => ['group:1'],
      recent: () => [message]
    },
    memory: {
      members: () => [{
        name: '群友',
        impressions: [{ content: '喜欢追问细节', createdAt: now - 10_000 }]
      }],
      getHandoff: () => null
    },
    stickers: {
      sync: async () => ({ entries: [] }),
      findForSend: async () => null
    },
    onebot: {
      getMsg: async () => ({
        message: [{ type: 'image', data: { url: 'https://example.com/fresh.jpg' } }]
      }),
      call: async (action, params) => {
        if (action === 'get_qzone_msg_list') return { msglist: [] };
        assert.equal(action, 'send_qzone_msg');
        published.push({ content: params.content, options: params });
        return { tid: 'tid-1' };
      }
    },
    resolveChatName: async () => '测试群',
    complete: async () => {
      const step = toolSteps[completionCalls++];
      return {
        model: 'test-model',
        message: {
          content: null,
          tool_calls: [{
            id: `call-${completionCalls}`,
            type: 'function',
            function: {
              name: step.name,
              arguments: JSON.stringify(step.args)
            }
          }]
        },
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
      };
    },
    search: async (query) => {
      searches.push(query);
      return {
        query,
        results: [{ title: '研究结果', url: 'https://example.com/article', snippet: '摘要' }]
      };
    },
    validateImage: async (url) => url,
    fetchBinary: async () => ({
      buffer: Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x00
      ]),
      contentType: 'image/png'
    }),
    now: () => now,
    random: () => 0
  });

  const preview = await manager.runNow({ publish: false });
  assert.equal(preview.record.status, 'preview');
  assert.equal(preview.record.decision, 'skip');
  assert.equal(preview.record.groupSummaries[0].summary, '讨论了一个新话题');
  assert.deepEqual(searches, ['测试研究问题']);
  assert.equal(preview.record.researchCalls, 1);

  const result = await manager.runNow({ publish: true });
  assert.equal(result.record.status, 'published');
  assert.equal(result.record.tid, 'tid-1');
  assert.equal(result.record.imageCount, 1);
  assert.equal(published.length, 1);
  assert.doesNotMatch(published[0].content, /测试群|群友|12345678/);
  assert.match(published[0].content, /某个群|有人/);
  assert.match(published[0].content, /号码已隐藏/);
  assert.equal(published[0].options.images.length, 1);
  assert.match(published[0].options.images[0], /^base64:\/\//);
  assert.equal(published[0].options.ugc_right, 4);

  const duplicate = await manager.runNow({ publish: true });
  assert.equal(duplicate.alreadyAttempted, true);
  assert.equal(published.length, 1);
  assert.equal(completionCalls, 4);

  const saved = JSON.parse(fs.readFileSync(path.join(root, 'daily-moments.json'), 'utf8'));
  assert.equal(saved.records[0].status, 'published');
});
