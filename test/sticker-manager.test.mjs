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

  const sticker = await manager.findForSend('collected_1701183958');

  assert.deepEqual(calls, [1701183958]);
  assert.match(sticker.url, /rkey=current$/);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'stickers.json'), 'utf8'));
  assert.match(saved[0].url, /rkey=current$/);
});
