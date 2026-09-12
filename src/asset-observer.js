import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { normalizeStickerEntry } from './stickers.js';

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function cleanText(value, max = 300) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function readSlangAssets(dataDir = DATA_DIR) {
  const file = path.join(dataDir, 'slang.json');
  const raw = readJson(file, []);
  const entries = (Array.isArray(raw) ? raw : []).map((entry, index) => {
    const status = ['candidate', 'confirmed', 'rejected'].includes(entry?.status)
      ? entry.status
      : 'candidate';
    return {
      id: cleanText(entry?.id || `slang-${index + 1}`, 100),
      content: cleanText(entry?.content, 80),
      meaning: cleanText(entry?.meaning, 500),
      usage: cleanText(entry?.usage, 300),
      example: cleanText(entry?.example, 300),
      risk: cleanText(entry?.risk, 300),
      status,
      source: entry?.source === 'manual' ? 'manual' : 'ai',
      count: Math.max(0, Number(entry?.count) || 0),
      evidenceCount: Array.isArray(entry?.evidence) ? entry.evidence.length : 0,
      updatedAt: String(entry?.updatedAt || '')
    };
  }).filter((entry) => entry.content);
  const counts = { candidate: 0, confirmed: 0, rejected: 0 };
  for (const entry of entries) counts[entry.status] += 1;
  return {
    exists: fs.existsSync(file),
    active: false,
    source: 'local',
    total: entries.length,
    counts,
    entries
  };
}

export function readMemoryAssetSummary(dataDir = DATA_DIR) {
  const memoryDir = path.join(dataDir, 'memory');
  const chats = [];
  let names = [];
  try { names = fs.readdirSync(memoryDir); } catch {
    return { chats: 0, people: 0, impressions: 0, handoffs: 0, items: [] };
  }
  for (const name of names) {
    const full = path.join(memoryDir, name);
    const match = /^(group|private)_(\d+)$/.exec(name);
    if (!match) continue;
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;
    let files = [];
    try { files = fs.readdirSync(full); } catch { continue; }
    let people = 0;
    let impressions = 0;
    let updatedAt = 0;
    for (const file of files) {
      if (!/^\d{1,15}\.json$/.test(file)) continue;
      const target = path.join(full, file);
      const value = readJson(target, null);
      if (!value) continue;
      people += 1;
      impressions += Array.isArray(value.impressions) ? value.impressions.length : 0;
      try { updatedAt = Math.max(updatedAt, fs.statSync(target).mtimeMs); } catch { /* ignore */ }
    }
    const hasHandoff = files.includes('_handoff.json');
    chats.push({
      chatKey: `${match[1]}:${match[2]}`,
      people,
      impressions,
      hasHandoff,
      updatedAt
    });
  }
  chats.sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    chats: chats.length,
    people: chats.reduce((sum, chat) => sum + chat.people, 0),
    impressions: chats.reduce((sum, chat) => sum + chat.impressions, 0),
    handoffs: chats.filter((chat) => chat.hasHandoff).length,
    items: chats
  };
}

function stickerView(entry) {
  const normalized = normalizeStickerEntry(entry);
  if (!normalized) return null;
  return {
    id: normalized.id,
    desc: normalized.desc,
    localNote: normalized.localNote,
    tags: normalized.tags,
    usage: normalized.usage,
    source: normalized.source,
    useCount: normalized.useCount,
    lastUsedAt: normalized.lastUsedAt,
    lastContext: normalized.lastContext,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    hasImage: Boolean(normalized.url)
  };
}

export class AssetObserver {
  constructor({
    stickers,
    getIdentityStatus = () => null,
    dataDir = DATA_DIR
  }) {
    this.stickers = stickers;
    this.getIdentityStatus = getIdentityStatus;
    this.dataDir = dataDir;
  }

  stickerSnapshot() {
    const entries = (this.stickers?.entries || []).map(stickerView).filter(Boolean);
    return {
      enabled: this.stickers?.enabled !== false,
      syncedAt: Number(this.stickers?.syncedAt) || 0,
      total: entries.length,
      annotated: entries.filter((entry) =>
        entry.desc || entry.localNote || entry.tags.length || entry.usage).length,
      used: entries.filter((entry) => entry.useCount > 0).length,
      sources: {
        qq: entries.filter((entry) => entry.source === 'qq').length,
        ai: entries.filter((entry) => entry.source === 'ai').length,
        manual: entries.filter((entry) => entry.source === 'manual').length
      },
      entries
    };
  }

  async listStickers({ query = '', offset = 0, limit = 100, refresh = false } = {}) {
    let sync = null;
    if (refresh) sync = await this.stickers.sync(true);
    const snapshot = this.stickerSnapshot();
    const q = cleanText(query, 100).toLowerCase();
    const filtered = q
      ? snapshot.entries.filter((entry) =>
          [
            entry.id,
            entry.desc,
            entry.localNote,
            entry.usage,
            ...entry.tags
          ].join(' ').toLowerCase().includes(q))
      : snapshot.entries;
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.min(200, Math.max(1, Number(limit) || 100));
    return {
      ...snapshot,
      matched: filtered.length,
      offset: start,
      limit: size,
      entries: filtered.slice(start, start + size),
      refreshError: String(sync?.error || '')
    };
  }

  listSlang({ query = '', status = '', offset = 0, limit = 200 } = {}) {
    const snapshot = readSlangAssets(this.dataDir);
    const q = cleanText(query, 100).toLowerCase();
    const wantedStatus = ['candidate', 'confirmed', 'rejected'].includes(status)
      ? status
      : '';
    const filtered = snapshot.entries.filter((entry) =>
      (!wantedStatus || entry.status === wantedStatus)
      && (!q || [
        entry.content,
        entry.meaning,
        entry.usage,
        entry.example,
        entry.risk
      ].join(' ').toLowerCase().includes(q)));
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.min(500, Math.max(1, Number(limit) || 200));
    return {
      ...snapshot,
      matched: filtered.length,
      offset: start,
      limit: size,
      entries: filtered.slice(start, start + size)
    };
  }

  overview() {
    const stickers = this.stickerSnapshot();
    const slang = readSlangAssets(this.dataDir);
    const memory = readMemoryAssetSummary(this.dataDir);
    const identity = this.getIdentityStatus?.() || {
      enabled: false,
      active: false,
      people: 0,
      databaseExists: false
    };
    return {
      generatedAt: Date.now(),
      stickers: {
        enabled: stickers.enabled,
        syncedAt: stickers.syncedAt,
        total: stickers.total,
        annotated: stickers.annotated,
        used: stickers.used,
        sources: stickers.sources
      },
      slang: {
        exists: slang.exists,
        active: slang.active,
        total: slang.total,
        counts: slang.counts
      },
      memory: {
        chats: memory.chats,
        people: memory.people,
        impressions: memory.impressions,
        handoffs: memory.handoffs
      },
      identity
    };
  }

  memorySummary() {
    return readMemoryAssetSummary(this.dataDir);
  }
}
