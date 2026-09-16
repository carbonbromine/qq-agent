import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const PEOPLE_DIR = path.join(MEMORY_DIR, 'people');
const MIGRATION_MARKER = path.join(MEMORY_DIR, '_global_people_v1.json');
const MIGRATION_BACKUP_DIR = path.join(MEMORY_DIR, 'backups', 'global-people-v1');

const clean = (v, n = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const validChat = (v) => /^(group|private):\d+$/.test(String(v || ''));
const chatKeyFromDir = (name) => {
  const m = /^(group|private)_(\d+)$/.exec(String(name || ''));
  return m ? `${m[1]}:${m[2]}` : '';
};
const memberFileName = (userId, name = '') => {
  const id = String(userId ?? '').trim();
  if (id) return /^\d+$/.test(id) ? `${id}.json` : `u_${id.replace(/[^a-z0-9_]/gi, '_')}.json`;
  const safe = String(name || 'unknown').replace(/[^a-z0-9_\u4e00-\u9fa5]/gi, '_').slice(0, 40);
  return `_n_${safe || 'unknown'}.json`;
};
const memberKey = (userId, name = '') => String(userId || '').trim() || `_n_${memberFileName('', name)}`;
const globalMemberFile = (userId, name = '') => path.join(PEOPLE_DIR, memberFileName(userId, name));

function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : fallback;
  } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}
function sourceKeys(value, fallback = '') {
  const out = [];
  const seen = new Set();
  const add = (v) => {
    const s = String(v || '').trim();
    if (!validChat(s) || seen.has(s)) return;
    seen.add(s); out.push(s);
  };
  if (Array.isArray(value)) value.forEach(add);
  add(fallback);
  return out;
}
function emptyMember(userId = '', name = '') {
  return { version: 2, userId: String(userId || ''), name: String(name || ''), impressions: [], sourceChatKeys: [], updatedAt: 0, lastConsolidatedAt: 0 };
}
function normalizeEntry(raw, fallbackChatKey = '') {
  const content = clean(raw?.content ?? raw);
  if (!content) return null;
  const createdAt = Number(raw?.createdAt) || Date.now();
  return {
    content,
    createdAt,
    lastObservedAt: Math.max(createdAt, Number(raw?.lastObservedAt) || 0),
    sourceChatKeys: sourceKeys(raw?.sourceChatKeys, raw?.sourceChatKey || fallbackChatKey)
  };
}
function mergeEntry(member, entry) {
  const old = member.impressions.find((x) => x.content === entry.content);
  if (!old) {
    member.impressions.push({ ...entry, sourceChatKeys: [...entry.sourceChatKeys] });
    return;
  }
  old.createdAt = Math.min(Number(old.createdAt) || entry.createdAt, entry.createdAt);
  old.lastObservedAt = Math.max(Number(old.lastObservedAt) || old.createdAt, entry.lastObservedAt || entry.createdAt);
  old.sourceChatKeys = sourceKeys([...(old.sourceChatKeys || []), ...(entry.sourceChatKeys || [])]);
}
function normalizeMember(raw = {}, userId = '', name = '', fallbackChatKey = '') {
  const member = emptyMember(raw.userId ?? userId, raw.name ?? name);
  member.updatedAt = Number(raw.updatedAt) || 0;
  member.lastConsolidatedAt = Number(raw.lastConsolidatedAt) || 0;
  member.sourceChatKeys = sourceKeys(raw.sourceChatKeys, fallbackChatKey);
  for (const item of Array.isArray(raw.impressions) ? raw.impressions : []) {
    const entry = normalizeEntry(item, fallbackChatKey);
    if (entry) mergeEntry(member, entry);
  }
  member.sourceChatKeys = sourceKeys([...member.sourceChatKeys, ...member.impressions.flatMap((x) => x.sourceChatKeys || [])]);
  member.impressions.sort((a, b) => (a.lastObservedAt || a.createdAt) - (b.lastObservedAt || b.createdAt));
  return member;
}
function mergeMember(target, incoming) {
  if (!target.userId && incoming.userId) target.userId = incoming.userId;
  if (incoming.name && (!target.name || incoming.updatedAt >= target.updatedAt)) target.name = incoming.name;
  for (const entry of incoming.impressions) mergeEntry(target, entry);
  target.sourceChatKeys = sourceKeys([...target.sourceChatKeys, ...incoming.sourceChatKeys]);
  target.updatedAt = Math.max(target.updatedAt || 0, incoming.updatedAt || 0);
  target.lastConsolidatedAt = Math.max(target.lastConsolidatedAt || 0, incoming.lastConsolidatedAt || 0);
}
function archive(src, rel) {
  try {
    if (!fs.existsSync(src)) return;
    const dst = path.join(MIGRATION_BACKUP_DIR, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
    fs.renameSync(src, dst);
  } catch (error) { console.warn('[memory] 归档旧人物记忆失败:', error?.message ?? error); }
}

export class GlobalPersonMemoryStore {
  constructor({ onLegacyState = null } = {}) {
    this.people = null;
    this.onLegacyState = typeof onLegacyState === 'function' ? onLegacyState : null;
  }
  #persist(member) {
    member.version = 2;
    member.sourceChatKeys = sourceKeys([...member.sourceChatKeys, ...member.impressions.flatMap((x) => x.sourceChatKeys || [])]);
    writeJson(globalMemberFile(member.userId, member.name), member);
  }
  #load() {
    const map = new Map();
    try {
      for (const file of fs.readdirSync(PEOPLE_DIR)) {
        if (!file.endsWith('.json')) continue;
        const raw = readJson(path.join(PEOPLE_DIR, file));
        if (!raw) continue;
        const member = normalizeMember(raw, raw.userId, raw.name);
        map.set(memberKey(member.userId, member.name), member);
      }
    } catch { /* no global dir yet */ }
    return map;
  }
  #merge(map, incoming) {
    const key = memberKey(incoming.userId, incoming.name);
    const member = map.get(key) || emptyMember(incoming.userId, incoming.name);
    mergeMember(member, incoming);
    map.set(key, member);
  }
  #migrateSingle(chatKey, file, map) {
    const old = readJson(file);
    if (!old) return;
    this.onLegacyState?.(chatKey, old);
    const notes = getConfig().memberNotes || {};
    const byName = Object.fromEntries(Object.entries(notes).filter(([, name]) => name).map(([qq, name]) => [String(name), String(qq)]));
    for (const item of Array.isArray(old.memberImpression) ? old.memberImpression : []) {
      const content = clean(item?.content);
      if (!content) continue;
      const target = String(item?.target || '').trim();
      const userId = String(item?.userId || '').trim() || (/^\d{5,15}$/.test(target) ? target : (byName[target] || ''));
      this.#merge(map, normalizeMember({
        userId, name: target || userId, sourceChatKeys: [chatKey], updatedAt: Number(item?.createdAt) || Date.now(),
        impressions: [{ content, createdAt: Number(item?.createdAt) || Date.now(), sourceChatKeys: [chatKey] }]
      }, userId, target, chatKey));
    }
  }
  #ensure() {
    if (this.people) return this.people;
    const map = this.#load();
    const marker = readJson(MIGRATION_MARKER);
    if (!marker?.completed) {
      const archives = [];
      let names = [];
      try { names = fs.readdirSync(MEMORY_DIR); } catch { names = []; }
      for (const name of names) {
        const full = path.join(MEMORY_DIR, name);
        let stat; try { stat = fs.statSync(full); } catch { continue; }
        if (stat.isFile()) {
          const m = /^(group|private)_(\d+)\.json$/.exec(name);
          if (!m) continue;
          const chatKey = `${m[1]}:${m[2]}`;
          this.#migrateSingle(chatKey, full, map);
          archives.push([full, path.join('legacy-single', name)]);
          continue;
        }
        if (!stat.isDirectory()) continue;
        const chatKey = chatKeyFromDir(name);
        if (!chatKey) continue;
        let files = []; try { files = fs.readdirSync(full); } catch { continue; }
        for (const file of files) {
          if (!file.endsWith('.json') || file.startsWith('_')) continue;
          const src = path.join(full, file);
          const raw = readJson(src);
          if (!raw) continue;
          this.#merge(map, normalizeMember(raw, raw.userId, raw.name, chatKey));
          archives.push([src, path.join(name, file)]);
        }
      }
      for (const member of map.values()) this.#persist(member);
      writeJson(MIGRATION_MARKER, { version: 1, completed: true, migratedAt: Date.now(), people: map.size });
      for (const [src, rel] of archives) archive(src, rel);
    }
    this.people = map;
    return map;
  }
  listSourceChats() {
    const out = new Set();
    for (const member of this.#ensure().values()) for (const key of member.sourceChatKeys) out.add(key);
    return [...out];
  }
  members(sourceChatKey = '') {
    const source = String(sourceChatKey || '').trim();
    return [...this.#ensure().values()]
      .filter((m) => m.impressions.length && (!source || m.sourceChatKeys.includes(source)))
      .map((m) => structuredClone(m))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(userId) {
    const uid = String(userId || '').trim();
    return structuredClone(this.#ensure().get(uid) || emptyMember(uid));
  }
  append(chatKey, userId, name, content, createdAt = Date.now()) {
    const map = this.#ensure();
    const key = memberKey(userId, name);
    const member = map.get(key) || emptyMember(userId, name);
    const now = Date.now();
    const entry = normalizeEntry({ content, createdAt, lastObservedAt: now, sourceChatKeys: [chatKey] }, chatKey);
    if (!entry) return null;
    mergeEntry(member, entry);
    member.userId = String(userId || member.userId || '');
    member.name = String(name || member.name || member.userId || '');
    member.sourceChatKeys = sourceKeys([...member.sourceChatKeys, chatKey]);
    member.updatedAt = now;
    this.#persist(member); map.set(memberKey(member.userId, member.name), member);
    return structuredClone(entry);
  }
  replace(chatKey, userId, name, contents) {
    const uid = String(userId || '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    const map = this.#ensure();
    const old = map.get(uid) || emptyMember(uid, name);
    const finalName = clean(name, 60) || old.name || uid;
    const now = Date.now();
    const sources = sourceKeys([...old.sourceChatKeys, ...old.impressions.flatMap((x) => x.sourceChatKeys || []), chatKey]);
    const member = {
      version: 2, userId: uid, name: finalName, sourceChatKeys: sources,
      updatedAt: now, lastConsolidatedAt: old.lastConsolidatedAt || 0,
      impressions: (Array.isArray(contents) ? contents : [contents]).map((x) => clean(x)).filter(Boolean).slice(0, 20)
        .map((content) => ({ content, createdAt: now, lastObservedAt: now, sourceChatKeys: [...sources] }))
    };
    for (const [key, candidate] of [...map.entries()]) {
      if (key === uid || candidate.userId || candidate.name !== finalName) continue;
      member.sourceChatKeys = sourceKeys([...member.sourceChatKeys, ...candidate.sourceChatKeys]);
      try { fs.rmSync(globalMemberFile(candidate.userId, candidate.name), { force: true }); } catch {}
      map.delete(key);
    }
    this.#persist(member); map.set(uid, member);
    return structuredClone(member);
  }
  removeMember(userId) {
    const uid = String(userId || '').trim();
    const map = this.#ensure(); const member = map.get(uid);
    if (!member) return false;
    map.delete(uid); try { fs.rmSync(globalMemberFile(member.userId, member.name), { force: true }); } catch {}
    return true;
  }
  remove({ userId = '', target = '', content = '' } = {}) {
    const map = this.#ensure(); let removed = false;
    for (const [key, member] of [...map.entries()]) {
      const match = userId ? member.userId === String(userId) : target ? (member.name || member.userId) === String(target).trim() : true;
      if (!match) continue;
      if (content) {
        const n = member.impressions.length;
        member.impressions = member.impressions.filter((x) => x.content !== content);
        removed ||= member.impressions.length !== n;
      } else { member.impressions = []; removed = true; }
      if (!member.impressions.length) {
        map.delete(key); try { fs.rmSync(globalMemberFile(member.userId, member.name), { force: true }); } catch {}
      } else { member.updatedAt = Date.now(); this.#persist(member); }
      if (userId || target) break;
    }
    return removed;
  }
  clearSource(chatKey) {
    const source = String(chatKey || '').trim(); const map = this.#ensure();
    for (const [key, member] of [...map.entries()]) {
      if (!member.sourceChatKeys.includes(source)) continue;
      for (const entry of member.impressions) entry.sourceChatKeys = entry.sourceChatKeys.filter((x) => x !== source);
      member.impressions = member.impressions.filter((x) => x.sourceChatKeys.length);
      member.sourceChatKeys = sourceKeys(member.impressions.flatMap((x) => x.sourceChatKeys));
      member.updatedAt = Date.now();
      if (!member.impressions.length) {
        map.delete(key); try { fs.rmSync(globalMemberFile(member.userId, member.name), { force: true }); } catch {}
      } else this.#persist(member);
    }
  }
  markConsolidated(userIds, at = Date.now()) {
    const map = this.#ensure();
    for (const uid of userIds || []) {
      const member = map.get(String(uid || '').trim());
      if (!member) continue;
      member.lastConsolidatedAt = Number(at) || Date.now(); this.#persist(member);
    }
  }
}
