import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-manager-'));
process.env.QQ_AGENT_DATA_DIR = root;
fs.writeFileSync(path.join(root, 'stickers.json'), JSON.stringify([{
  id: 'collected_1701183958',
  resId: 'collected_1701183958',
  url: 'https://multimedia.nt.qq.com.cn/download?fileid=old&rkey=expired',
  source: 'ai',
  desc: 'test sticker'
}]));

const { StickerManager } = await import('../src/sticker-manager.js');
const { buildToolDefs } = await import('../src/tools.js');
const { buildStickerContext, findSticker } = await import('../src/stickers.js');

test('refreshes a collected QQ image URL from its source message before sending', async (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const manager = new StickerManager({
    async call(action) {
      assert.equal(action, 'fetch_custom_face_detail');
      return [];
    },
    async getMsg(messageId) {
      calls.push(messageId);
      return {
        message: [{
          type: 'image',
          data: {
            url: 'https://multimedia.nt.qq.com.cn/download?fileid=fresh&rkey=current'
          }
        }]
      };
    }
  });

  const cached = manager.peek('collected_1701183958');
  assert.equal(cached.id, 'collected_1701183958');
  assert.deepEqual(calls, [], '只读观测本地快照不应触发 OneBot');

  const sticker = await manager.findForSend('collected_1701183958');

  assert.deepEqual(calls, [1701183958]);
  assert.match(sticker.url, /rkey=current$/);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'stickers.json'), 'utf8'));
  assert.match(saved[0].url, /rkey=current$/);
});

test('manual uploaded stickers can be viewed and sent by agent tools', async (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = new StickerManager({ call: async () => [] });
  const sticker = manager.addManual({
    imageBuffer: Buffer.from('89504e470d0a1a0a00000000', 'hex'),
    desc: '本地测试'
  });
  const sent = [];
  const context = {
    chatKey: 'group:1',
    stickers: manager,
    sender: {
      sendSticker: async (_chatKey, value) => {
        sent.push(value);
        return { message_id: 7 };
      }
    },
    session: { leaseId: 'lease', triggerText: '测试', sent: [] },
    emit: () => {}
  };
  const tools = buildToolDefs();
  const send = tools.find((tool) => tool.name === 'send_sticker');
  const view = tools.find((tool) => tool.name === 'get_sticker_image');
  const sendResult = await send.execute(context, { stickerId: sticker.id });
  assert.equal(sendResult.isError, undefined);
  assert.match(sent[0].url, /^base64:\/\//);
  const viewResult = await view.execute(context, { stickerId: sticker.id });
  assert.equal(viewResult.isError, undefined);
  assert.equal(viewResult.content[1].type, 'image_url');
  assert.match(viewResult.content[1].image_url.url, /^data:image\/png;base64,/);

  const webp = manager.addManual({
    imageBuffer: Buffer.from('524946460400000057454250', 'hex'),
    desc: 'WebP 测试'
  });
  const webpSendResult = await send.execute(context, { stickerId: webp.id });
  assert.equal(webpSendResult.isError, undefined);
  assert.match(sent[1].url, /^base64:\/\//);
  const webpViewResult = await view.execute(context, { stickerId: webp.id });
  assert.equal(webpViewResult.isError, undefined);
  assert.match(webpViewResult.content[1].image_url.url, /^data:image\/webp;base64,/);
});

test('refuses to overwrite a corrupted sticker metadata file', (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  const metadataFile = path.join(root, 'stickers.json');
  const corrupted = '{"id":';
  fs.writeFileSync(metadataFile, corrupted);
  const manager = new StickerManager({ call: async () => [] });

  assert.throws(() => manager.addManual({
    imageBuffer: Buffer.from('89504e470d0a1a0a00000000', 'hex'),
    desc: '不应写入'
  }), /表情库读取失败，已停止写入/);
  assert.equal(fs.readFileSync(metadataFile, 'utf8'), corrupted);
  assert.equal(fs.existsSync(path.join(root, 'sticker-assets')), false);
});

test('reports pending cleanup when a deleted sticker image cannot be removed', (t) => {
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true });
  const manager = new StickerManager({ call: async () => [] });
  const sticker = manager.addManual({
    imageBuffer: Buffer.from('89504e470d0a1a0a00000000', 'hex'),
    desc: '待删除'
  });
  const imageFile = path.join(root, manager.entries.find((entry) =>
    entry.id === sticker.id).localFile);
  const originalRmSync = fs.rmSync;
  t.mock.method(fs, 'rmSync', (target, options) => {
    if (path.resolve(target) === path.resolve(imageFile)) {
      throw new Error('simulated cleanup failure');
    }
    return originalRmSync(target, options);
  });

  const result = manager.remove(sticker.id);
  t.mock.restoreAll();

  assert.equal(result.removed, true);
  assert.equal(result.cleanupPending, true);
  assert.match(result.warning, /simulated cleanup failure/);
  assert.equal(manager.peek(sticker.id), null);
  assert.equal(fs.existsSync(imageFile), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'stickers.json'), 'utf8')), []);
});

test('prompt exposes sticker IDs and exact unique labels remain compatible', () => {
  const entries = [
    { id: 'sticker-1', desc: '无语团子', localNote: '', url: 'https://example.com/1.png' },
    { id: 'sticker-2', desc: '开心团子', localNote: '庆祝', url: 'https://example.com/2.png' }
  ];
  const prompt = buildStickerContext(entries, 10);
  assert.match(prompt, /无语团子.*stickerId：sticker-1/);
  assert.equal(findSticker(entries, '无语团子')?.id, 'sticker-1');
  assert.equal(findSticker(entries, '庆祝')?.id, 'sticker-2');
  assert.equal(findSticker([
    ...entries,
    { id: 'sticker-3', desc: '无语团子', url: 'https://example.com/3.png' }
  ], '无语团子'), null);
});
