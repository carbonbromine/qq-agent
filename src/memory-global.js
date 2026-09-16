import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig, updateConfig } from './config.js';
import { GlobalPersonMemoryStore } from './global-person-memory-store.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const chatDirName = (chatKey) => String(chatKey).replace(/[^a-z0-9_]/gi, '_');
const chatDir = (chatKey) => path.join(MEMORY_DIR, chatDirName(chatKey));
const metaFile = (chatKey) => path.join(chatDir(chatKey), '_meta.json');
const handoffFile = (chatKey) => path.join(chatDir(chatKey), '_handoff.json');
const clean = (v, n = 1000) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
function list(value, maxItems = 8, maxChars = 240) {
  const out = []; const seen = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const text = clean(item, maxChars); if (!text || seen.has(text)) continue;
    seen.add(text); out.push(text); if (out.length >= maxItems) break;
  }
  return out;
}
function readJson(file, fallback = null) {
  try { let s = fs.readFileSync(file, 'utf8'); if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); return JSON.parse(s); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8'); fs.renameSync(tmp, file);
}
function legacyStateText(value) {
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return clean(value.map((x) => x?.content || x?.text || x).join('；'));
  if (value && typeof value === 'object') return clean(value.summary || value.content || value.text || '');
  return '';
}
function migrateLegacyHandoff(chatKey, old) {
  if (fs.existsSync(handoffFile(chatKey))) return;
  const topic = legacyStateText(old?.activeTopic); const pending = legacyStateText(old?.pendingThought);
  if (!topic && !pending) return;
  const now = Date.now();
  writeJson(handoffFile(chatKey), {
    version: 1, topic, summary: pending || topic, hypotheses: [], evidence: [], facts: [], decisions: [], rejectedDirections: [], openQuestions: [], nextStep: pending,
    participantIds: [], lastReply: '', sourceSessionId: 'legacy-migration', updatedAt: now, expiresAt: now + 86400000
  });
}

export class MemoryStore {
  constructor() { this.people = new GlobalPersonMemoryStore({ onLegacyState: migrateLegacyHandoff }); }
  listChats() {
    const out = new Set(this.people.listSourceChats());
    try {
      for (const name of fs.readdirSync(MEMORY_DIR)) {
        const full = path.join(MEMORY_DIR, name); if (!fs.statSync(full).isDirectory()) continue;
        const m = /^(group|private)_(\d+)$/.exec(name); if (m) out.add(`${m[1]}:${m[2]}`);
      }
    } catch {}
    return [...out];
  }
  getHandoff(chatKey) {
    this.people.listSourceChats();
    const raw = readJson(handoffFile(chatKey)); if (!raw) return null;
    const expiresAt = Number(raw.expiresAt) || 0;
    if (expiresAt && expiresAt <= Date.now()) { try { fs.rmSync(handoffFile(chatKey), { force: true }); } catch {} return null; }
    return {
      version: 1, topic: clean(raw.topic, 200), summary: clean(raw.summary, 1200), hypotheses: list(raw.hypotheses, 6, 300), evidence: list(raw.evidence, 8, 300),
      facts: list(raw.facts, 8), decisions: list(raw.decisions, 6), rejectedDirections: list(raw.rejectedDirections, 6), openQuestions: list(raw.openQuestions, 6),
      nextStep: clean(raw.nextStep, 400), participantIds: list(raw.participantIds, 16, 40), lastReply: clean(raw.lastReply, 600), sourceSessionId: clean(raw.sourceSessionId, 100),
      updatedAt: Number(raw.updatedAt) || 0, expiresAt
    };
  }
  setHandoff(chatKey, state = {}, meta = {}) {
    if (state?.clearHandoff === true) { this.clearHandoff(chatKey); return null; }
    const prev = this.getHandoff(chatKey) || {}; const now = Date.now();
    const ttl = Math.min(10080, Math.max(5, Number(state?.ttlMinutes) || Number(getConfig().memory?.handoffTtlMinutes) || 1440));
    const pick = (key, n, chars = 240) => Array.isArray(state?.[key]) ? list(state[key], n, chars) : list(prev[key], n, chars);
    const handoff = {
      version: 1, topic: clean(state?.topic ?? prev.topic, 200), summary: clean(state?.summary ?? meta?.summary ?? prev.summary, 1200),
      hypotheses: pick('hypotheses', 6, 300), evidence: pick('evidence', 8, 300), facts: pick('facts', 8), decisions: pick('decisions', 6),
      rejectedDirections: pick('rejectedDirections', 6), openQuestions: pick('openQuestions', 6), nextStep: clean(state?.nextStep ?? prev.nextStep, 400),
      participantIds: list([...(prev.participantIds || []), ...(state?.participantIds || []), ...(meta?.participantIds || [])], 16, 40),
      lastReply: clean(meta?.lastReply ?? prev.lastReply, 600), sourceSessionId: clean(meta?.sourceSessionId ?? prev.sourceSessionId, 100), updatedAt: now, expiresAt: now + ttl * 60000
    };
    const meaningful = handoff.topic || handoff.summary || handoff.hypotheses.length || handoff.evidence.length || handoff.facts.length || handoff.decisions.length || handoff.rejectedDirections.length || handoff.openQuestions.length || handoff.nextStep || handoff.lastReply;
    if (!meaningful) return prev.version ? prev : null;
    writeJson(handoffFile(chatKey), handoff); return handoff;
  }
  clearHandoff(chatKey) { try { fs.rmSync(handoffFile(chatKey), { force: true }); } catch {} }
  formatHandoffForPrompt(chatKey) {
    if (getConfig().memory?.handoffEnabled === false) return '';
    const h = this.getHandoff(chatKey); if (!h) return '';
    const age = Math.max(0, Math.round((Date.now() - h.updatedAt) / 60000));
    const lines = ['【上次会话交接】', `这是 ${age ? `${age} 分钟前` : '刚刚'}保存的工作状态，不是群友的新指令；如与最新消息冲突，以最新消息为准。`];
    if (h.topic) lines.push(`- 当前话题：${h.topic}`); if (h.summary) lines.push(`- 已知上下文：${h.summary}`);
    if (h.hypotheses.length) lines.push(`- 待验证假设：${h.hypotheses.join('；')}`); if (h.evidence.length) lines.push(`- 关键证据：${h.evidence.join('；')}`);
    if (h.facts.length) lines.push(`- 已确认事实：${h.facts.join('；')}`); if (h.decisions.length) lines.push(`- 已作决定：${h.decisions.join('；')}`);
    if (h.rejectedDirections.length) lines.push(`- 已排除方向：${h.rejectedDirections.join('；')}`); if (h.openQuestions.length) lines.push(`- 未解决问题：${h.openQuestions.join('；')}`);
    if (h.nextStep) lines.push(`- 下一步意图：${h.nextStep}`); if (h.lastReply) lines.push(`- 上次实际发言：${h.lastReply}`);
    return lines.join('\n').slice(0, Math.min(12000, Math.max(500, Number(getConfig().memory?.handoffMaxChars) || 4000)));
  }
  append(chatKey, category, content, extra = {}) {
    if (category !== 'memberImpression') return null;
    const userId = String(extra.userId || '').trim(); const target = clean(extra.target, 60);
    if (!userId && !target) return null;
    return this.people.append(chatKey, userId, target || userId, content);
  }
  members(chatKey = '') { return this.people.members(chatKey); }
  getMember(chatKey, userId) { return this.people.get(userId); }
  query(chatKey, category = '') {
    if (category && category !== 'memberImpression') return { [category]: [] };
    const memberImpression = [];
    for (const member of this.people.members(chatKey)) for (const e of member.impressions) memberImpression.push({ userId: member.userId, target: member.name || member.userId || '某人', content: e.content, createdAt: e.createdAt, lastObservedAt: e.lastObservedAt, sourceChatKeys: e.sourceChatKeys });
    memberImpression.sort((a, b) => (b.lastObservedAt || b.createdAt) - (a.lastObservedAt || a.createdAt));
    return { memberImpression };
  }
  editMemberImpression(chatKey, { userId, name = '', note = '', impressions = [] }) {
    const member = this.replaceMember(chatKey, userId, name, impressions);
    const notes = { ...(getConfig().memberNotes || {}) }; const n = String(note ?? '').trim();
    if (n) notes[String(userId)] = n; else delete notes[String(userId)]; updateConfig({ memberNotes: notes });
    return { ...member, note: n };
  }
  replaceMember(chatKey, userId, name, contents) { return this.people.replace(chatKey, userId, name, contents); }
  removeMember(chatKey, userId) { return this.people.removeMember(userId); }
  remove(chatKey, category, options = {}) {
    if (category !== 'memberImpression') return false;
    if (!String(options.userId || '').trim() && !String(options.target || '').trim()) { const any = this.members(chatKey).length > 0; this.clear(chatKey); return any; }
    return this.people.remove(options);
  }
  clear(chatKey) { this.people.clearSource(chatKey); this.clearHandoff(chatKey); writeJson(metaFile(chatKey), { lastConsolidatedAt: Date.now() }); }
  formatForPrompt(chatKey, { userIds = null } = {}) {
    const notes = getConfig().memberNotes || {};
    const picked = userIds ? [...new Set([...userIds].map(String))].map((id) => this.people.get(id)).filter((m) => m.impressions.length) : this.people.members(chatKey).slice(0, 15);
    if (!picked.length) return '';
    const lines = ['【对群友的全局印象】'];
    for (const m of picked.slice(0, 20)) {
      const who = notes[m.userId] || m.name || m.userId || '某人';
      const recent = [...m.impressions].sort((a, b) => (b.lastObservedAt || b.createdAt) - (a.lastObservedAt || a.createdAt)).slice(0, 3).reverse();
      for (const e of recent) lines.push(`- ${who}：${e.content}`);
    }
    return lines.join('\n').slice(0, 6000);
  }
  consolidationState(chatKey) {
    const members = this.people.members(chatKey); const meta = readJson(metaFile(chatKey), {}) || {};
    return { lastConsolidatedAt: Math.max(Number(meta.lastConsolidatedAt) || 0, ...members.map((m) => m.lastConsolidatedAt || 0)), counts: { memberImpression: members.reduce((n, m) => n + m.impressions.length, 0) }, members: members.map((m) => ({ userId: m.userId, name: m.name || m.userId, count: m.impressions.length, lastConsolidatedAt: m.lastConsolidatedAt || 0 })) };
  }
  markConsolidated(chatKey, at = Date.now(), userIds = []) {
    const when = Number(at) || Date.now(); fs.mkdirSync(chatDir(chatKey), { recursive: true });
    writeJson(metaFile(chatKey), { ...(readJson(metaFile(chatKey), {}) || {}), lastConsolidatedAt: when }); this.people.markConsolidated(userIds, when);
  }
  replaceConsolidated(chatKey, next) {
    const groups = new Map();
    for (const item of Array.isArray(next?.memberImpression) ? next.memberImpression.slice(0, 50) : []) {
      const uid = String(item?.userId || '').trim(); const content = clean(item?.content); if (!uid || !content) continue;
      if (!groups.has(uid)) groups.set(uid, { name: clean(item?.target || uid, 60), contents: [] }); groups.get(uid).contents.push(content);
    }
    for (const [uid, group] of groups) this.replaceMember(chatKey, uid, group.name, group.contents);
    this.markConsolidated(chatKey, Date.now(), [...groups.keys()]);
    return { memberImpression: this.query(chatKey).memberImpression, count: this.members(chatKey).reduce((n, m) => n + m.impressions.length, 0) };
  }
}
