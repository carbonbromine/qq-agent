// 运行期表情库管理：同步 QQ 收藏表情 + 本地认知层（备注/笔记/使用计数）。
// 纯函数在 stickers.js；这里管缓存、TTL 和 OneBot 交互。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { OneBotClient } from './onebot.js';
import { DATA_DIR, getConfig } from './config.js';
import {
  loadStickerStore, saveStickerStore, mergeStickerLibrary,
  findSticker, formatStickerList, applyStickerNote, markStickerUsed,
  normalizeStickerEntry
} from './stickers.js';

const STICKER_ASSET_DIR = path.join(DATA_DIR, 'sticker-assets');
const MAX_STICKER_BYTES = 8 * 1024 * 1024;
const IMAGE_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
});

function imageType(buffer) {
  if (
    buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  ) return 'image/png';
  if (
    buffer.length >= 3
    && buffer[0] === 0xFF
    && buffer[1] === 0xD8
    && buffer[2] === 0xFF
  ) return 'image/jpeg';
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) {
    return 'image/gif';
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  return '';
}

function cleanMetadata(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export class StickerManager {
  constructor(onebot) {
    this.onebot = onebot;
    this.storageError = null;
    try {
      this.entries = loadStickerStore(undefined, { strict: true });
    } catch (error) {
      this.entries = [];
      this.storageError = error;
    }
    this.syncedAt = 0;
    this.syncing = null;
    this.collectTimes = [];
  }

  get enabled() {
    return getConfig().sticker?.enabled !== false;
  }

  assertStorageWritable() {
    try {
      loadStickerStore(undefined, { strict: true });
      this.storageError = null;
    } catch (error) {
      this.storageError = error;
      throw error;
    }
  }

  saveEntries(entries) {
    this.assertStorageWritable();
    saveStickerStore(entries);
    this.entries = entries;
  }

  /** 同步 QQ 收藏表情（带 TTL 缓存；force 立即刷新）。失败时退回本地缓存。 */
  async sync(force = false) {
    if (!this.enabled) return { entries: this.entries, fromCache: true, disabled: true };
    try {
      this.assertStorageWritable();
    } catch (error) {
      return {
        entries: this.entries,
        fromCache: true,
        error: String(error?.message ?? error)
      };
    }
    const ttl = 60000;
    const now = Date.now();
    if (!force && this.syncedAt && now - this.syncedAt < ttl) {
      return { entries: this.entries, fromCache: true };
    }
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const count = Math.min(500, Math.max(1, Number(getConfig().sticker?.promptMaxStickers) * 10 || 100));
        const data = await this.onebot.call('fetch_custom_face_detail', { count });
        const fetched = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
        if (!fetched) throw new Error('fetch_custom_face_detail 返回 data 不是数组');
        // 只有拿到合法数组才合并，避免异常响应清空本地库
        const nextEntries = mergeStickerLibrary(this.entries, fetched);
        this.saveEntries(nextEntries);
        this.syncedAt = Date.now();
        return { entries: this.entries, fromCache: false };
      } catch (error) {
        // 同步失败不致命：本地缓存继续用
        return { entries: this.entries, fromCache: true, error: String(error?.message ?? error) };
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  async list(query = '', limit = 48, force = false) {
    const synced = await this.sync(force);
    return formatStickerList(synced.entries, query, limit);
  }

  /** 只读查看当前本地快照，不触发 QQ 同步或刷新临时 URL。 */
  peek(ref) {
    return findSticker(this.entries, ref);
  }

  async find(ref) {
    const synced = await this.sync(false);
    return findSticker(synced.entries, ref);
  }

  /** QQ 消息图片 URL 带短期 rkey；发送 AI 收藏图前按原消息刷新。 */
  async findForSend(ref) {
    const sticker = await this.find(ref);
    if (sticker?.localFile) {
      const image = this.readImage(ref);
      if (!image) return null;
      return {
        ...sticker,
        url: `base64://${image.buffer.toString('base64')}`
      };
    }
    const messageId = /^collected_(-?\d+)$/.exec(String(sticker?.id || ''))?.[1];
    if (!sticker || sticker.source !== 'ai' || !messageId) return sticker;
    try {
      const data = await this.onebot.getMsg(Number(messageId));
      const segments = Array.isArray(data?.message) ? data.message : [];
      const image = segments.find((segment) => segment?.type === 'image');
      const freshUrl = String(image?.data?.url || image?.data?.file || '').trim();
      if (!/^https?:\/\//i.test(freshUrl)) return sticker;
      // #region debug-point C:sticker-url-refresh
      if (!String(process.argv[1]).includes('/test/')) (() => { try { const oldUrl = new URL(sticker.url); const nextUrl = new URL(freshUrl); const body = JSON.stringify({ sessionId: 'agent-time-sticker-download', runId: 'post-fix', hypothesisId: 'C', location: 'src/sticker-manager.js:findForSend', msg: '[DEBUG] Refreshed collected sticker URL', data: { stickerId: sticker.id, messageId, oldHost: oldUrl.host, freshHost: nextUrl.host, changed: freshUrl !== sticker.url, freshQueryKeys: [...nextUrl.searchParams.keys()] }, ts: Date.now() }); const req = process.getBuiltinModule('node:http').request('http://192.168.31.10:7777/event', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => res.resume()); req.on('error', () => {}); req.on('socket', (socket) => socket.unref()); req.setTimeout(500, () => req.destroy()); req.end(body); } catch {} })();
      // #endregion
      if (freshUrl === sticker.url) return sticker;
      const refreshed = { ...sticker, url: freshUrl, updatedAt: new Date().toISOString() };
      this.saveEntries(
        this.entries.map((entry) => entry.id === sticker.id ? refreshed : entry)
      );
      return refreshed;
    } catch {
      return sticker;
    }
  }

  note(id, patch) {
    const result = applyStickerNote(this.entries, id, patch);
    if (result.entry) this.saveEntries(result.entries);
    return result.entry;
  }

  addManual({
    imageBuffer,
    desc = '',
    localNote = '',
    tags = [],
    usage = ''
  }) {
    this.assertStorageWritable();
    const buffer = Buffer.isBuffer(imageBuffer)
      ? imageBuffer
      : Buffer.from(imageBuffer || []);
    if (!buffer.length) throw new Error('请选择表情图片');
    if (buffer.length > MAX_STICKER_BYTES) throw new Error('表情图片不能超过 8 MiB');
    const contentType = imageType(buffer);
    if (!contentType) throw new Error('仅支持 PNG、JPEG、GIF 或 WebP 图片');
    const id = `manual_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const relativeFile = `sticker-assets/${id}.${IMAGE_EXTENSIONS[contentType]}`;
    const file = path.join(DATA_DIR, relativeFile);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer, { mode: 0o600 });
    fs.renameSync(tmp, file);
    const now = new Date().toISOString();
    const entry = normalizeStickerEntry({
      id,
      resId: id,
      localFile: relativeFile,
      desc: cleanMetadata(desc, 80),
      localNote: cleanMetadata(localNote, 300),
      tags: Array.isArray(tags)
        ? tags.map((tag) => cleanMetadata(tag, 40)).filter(Boolean).slice(0, 20)
        : [],
      usage: cleanMetadata(usage, 300),
      source: 'manual',
      metadataEdited: true,
      createdAt: now,
      updatedAt: now
    });
    const nextEntries = [...this.entries, entry];
    try {
      this.saveEntries(nextEntries);
    } catch (error) {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
      throw error;
    }
    return entry;
  }

  update(id, patch = {}) {
    const target = findSticker(this.entries, id);
    if (!target) return null;
    const index = this.entries.findIndex((entry) => entry.id === target.id);
    const next = normalizeStickerEntry({
      ...target,
      desc: patch.desc !== undefined ? cleanMetadata(patch.desc, 80) : target.desc,
      localNote: patch.localNote !== undefined
        ? cleanMetadata(patch.localNote, 300)
        : target.localNote,
      tags: patch.tags !== undefined
        ? (Array.isArray(patch.tags) ? patch.tags : [])
        : target.tags,
      usage: patch.usage !== undefined ? cleanMetadata(patch.usage, 300) : target.usage,
      metadataEdited: true,
      updatedAt: new Date().toISOString()
    });
    const nextEntries = [...this.entries];
    nextEntries[index] = next;
    this.saveEntries(nextEntries);
    return next;
  }

  remove(id) {
    const target = findSticker(this.entries, id);
    if (!target) return null;
    const nextEntries = target.source === 'qq'
      ? this.entries.map((entry) =>
        entry.id === target.id
          ? normalizeStickerEntry({ ...entry, hidden: true, updatedAt: new Date().toISOString() })
          : entry)
      : this.entries.filter((entry) => entry.id !== target.id);
    this.saveEntries(nextEntries);
    let cleanupPending = false;
    let warning = '';
    if (target.localFile) {
      try {
        fs.rmSync(path.join(DATA_DIR, target.localFile), { force: true });
      } catch (error) {
        cleanupPending = true;
        warning = `表情已从资产库移除，但图片文件清理失败：${String(error?.message ?? error)}`;
      }
    }
    return { removed: true, cleanupPending, warning };
  }

  readImage(ref) {
    const sticker = findSticker(this.entries, ref);
    if (!sticker?.localFile) return null;
    const file = path.resolve(DATA_DIR, sticker.localFile);
    const root = `${path.resolve(STICKER_ASSET_DIR)}${path.sep}`;
    if (!file.startsWith(root)) return null;
    try {
      const buffer = fs.readFileSync(file);
      const contentType = imageType(buffer);
      return contentType ? { buffer, contentType } : null;
    } catch {
      return null;
    }
  }

  markUsed(id, context = '') {
    const result = markStickerUsed(this.entries, id, context);
    if (result.entry) this.saveEntries(result.entries);
    return result.entry;
  }

  /** 收藏一条消息里的图片（本地新增条目，不入 QQ 收藏）。 */
  collect(messageId, { url, note = '' } = {}) {
    if (!getConfig().sticker?.collectEnabled) throw new Error('收藏表情功能未开启');
    // 限频
    const now = Date.now();
    this.collectTimes = this.collectTimes.filter((t) => now - t < 3600000);
    if (this.collectTimes.length >= Math.max(1, Number(getConfig().sticker?.maxCollectPerHour) || 10)) {
      throw new Error('收藏太频繁了，一小时后再试');
    }
    url = String(url || '');
    if (!url) throw new Error('该消息没有可收藏的图片地址');
    const id = `collected_${messageId}`;
    const existing = this.entries.find((e) => e.id === id);
    if (existing) {
      return this.note(id, { note: String(note || '') });
    }
    const entry = {
      id,
      resId: id,
      url,
      md5: '',
      desc: String(note || '').slice(0, 20),
      localNote: String(note || ''),
      tags: [],
      usage: '',
      source: 'ai',
      useCount: 0,
      lastUsedAt: 0,
      lastContext: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.saveEntries([...this.entries, entry]);
    this.collectTimes.push(now);
    return entry;
  }
}
