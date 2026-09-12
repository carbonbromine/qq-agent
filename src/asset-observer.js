import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';
import { identityDatabasePath } from './identity-store.js';
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

export function readIdentityAssets(dataDir = DATA_DIR, limit = 500) {
  const file = identityDatabasePath(dataDir);
  if (!fs.existsSync(file)) {
    return { exists: false, people: 0, sources: 0, aliases: 0, entries: [] };
  }
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const totals = {
      people: Number(db.prepare('SELECT COUNT(*) AS n FROM people').get().n) || 0,
      sources: Number(db.prepare('SELECT COUNT(*) AS n FROM identity_sources').get().n) || 0,
      aliases: Number(db.prepare('SELECT COUNT(*) AS n FROM identity_aliases').get().n) || 0
    };
    const rows = db.prepare(`
      SELECT uin, primary_name, message_count, chat_count, is_friend, legacy_memory_count,
        first_seen_at, last_seen_at
      FROM people ORDER BY last_seen_at DESC, message_count DESC, uin LIMIT ?
    `).all(Math.min(500, Math.max(1, Number(limit) || 500)));
    const aliasStmt = db.prepare(`
      SELECT alias FROM identity_aliases WHERE uin=?
      ORDER BY last_seen_at DESC, seen_count DESC LIMIT 8
    `);
    return {
      exists: true,
      ...totals,
      entries: rows.map((row) => ({
        userId: String(row.uin),
        primaryName: String(row.primary_name || ''),
        messageCount: Number(row.message_count) || 0,
        chatCount: Number(row.chat_count) || 0,
        isFriend: Boolean(row.is_friend),
        legacyMemoryCount: Number(row.legacy_memory_count) || 0,
        firstSeenAt: Number(row.first_seen_at) || 0,
        lastSeenAt: Number(row.last_seen_at) || 0,
        aliases: [...new Set(aliasStmt.all(row.uin)
          .map((entry) => cleanText(entry.alias, 60))
          .filter(Boolean))]
      }))
    };
  } catch (error) {
    return {
      exists: true,
      people: 0,
      sources: 0,
      aliases: 0,
      entries: [],
      error: String(error?.message ?? error)
    };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
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
    const identityRuntime = this.getIdentityStatus?.() || {
      enabled: false,
      active: false,
      people: 0,
      databaseExists: false
    };
    const identityStored = readIdentityAssets(this.dataDir, 1);
    const identity = {
      ...identityRuntime,
      databaseExists: identityStored.exists,
      people: identityRuntime.active ? identityRuntime.people : identityStored.people,
      sources: identityRuntime.active ? identityRuntime.sources : identityStored.sources,
      aliases: identityRuntime.active ? identityRuntime.aliases : identityStored.aliases
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

  identitySnapshot(limit = 500) {
    return readIdentityAssets(this.dataDir, limit);
  }
}
