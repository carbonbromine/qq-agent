import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';

const DB_NAME = 'identity-pilot.sqlite';
const FRIEND_PROPOSAL_REASONS = new Set(['interest', 'frequent', 'banter']);
const OPEN_FRIEND_PROPOSAL_STATES = new Set(['pending', 'approved_manual']);

function normalizeUin(value) {
  const uin = String(value ?? '').trim();
  return /^\d{1,15}$/.test(uin) && Number(uin) > 0 ? uin : '';
}

function cleanName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

function cleanMemory(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function proposalView(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.uin),
    primaryName: String(row.primary_name || ''),
    sourceChatKey: String(row.source_chat_key || ''),
    reasonCode: String(row.reason_code || ''),
    reason: String(row.reason || ''),
    verificationMessage: String(row.verification_message || ''),
    status: String(row.status || ''),
    createdAt: Number(row.created_at) || 0,
    decidedAt: Number(row.decided_at) || 0,
    decidedBy: String(row.decided_by || ''),
    notifiedAt: Number(row.notified_at) || 0,
    notifyError: String(row.notify_error || ''),
    cooldownUntil: Number(row.cooldown_until) || 0,
    updatedAt: Number(row.updated_at) || 0
  };
}

function readJson(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function chatKeyFromName(name) {
  const match = /^(group|private)_(\d+)$/.exec(String(name || ''));
  return match ? `${match[1]}:${match[2]}` : '';
}

export function identityDatabasePath(dataDir = DATA_DIR) {
  return path.join(dataDir, DB_NAME);
}

/**
 * 只读扫描旧版会话内印象。不会调用 MemoryStore，因其加载过程可能执行历史迁移。
 */
export function readLegacyIdentityMemories(
  dataDir = DATA_DIR,
  { allowSource = () => true } = {}
) {
  const memoryDir = path.join(dataDir, 'memory');
  const rows = [];
  let names = [];
  try { names = fs.readdirSync(memoryDir); } catch { return rows; }

  const add = (chatKey, userId, content, createdAt, sourceFile) => {
    const uin = normalizeUin(userId);
    const text = cleanMemory(content);
    if (!uin || !text || !allowSource(chatKey, uin)) return;
    rows.push({
      userId: uin,
      chatKey,
      content: text,
      observedAt: Number(createdAt) || 0,
      sourceFile: path.relative(dataDir, sourceFile)
    });
  };

  for (const name of names) {
    const full = path.join(memoryDir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }

    if (stat.isDirectory()) {
      const chatKey = chatKeyFromName(name);
      if (!chatKey) continue;
      let files = [];
      try { files = fs.readdirSync(full); } catch { continue; }
      for (const filename of files) {
        if (!/^\d{1,15}\.json$/.test(filename)) continue;
        const file = path.join(full, filename);
        const raw = readJson(file);
        if (!raw) continue;
        const userId = normalizeUin(raw.userId) || filename.slice(0, -5);
        for (const impression of Array.isArray(raw.impressions) ? raw.impressions : []) {
          add(chatKey, userId, impression?.content, impression?.createdAt, file);
        }
      }
      continue;
    }

    const legacyMatch = /^(group|private)_(\d+)\.json$/.exec(name);
    if (!legacyMatch) continue;
    const chatKey = `${legacyMatch[1]}:${legacyMatch[2]}`;
    const raw = readJson(full);
    for (const impression of Array.isArray(raw?.memberImpression) ? raw.memberImpression : []) {
      add(
        chatKey,
        impression?.userId || (/^\d{1,15}$/.test(String(impression?.target || ''))
          ? impression.target
          : ''),
        impression?.content,
        impression?.createdAt,
        full
      );
    }
  }
  return rows;
}

export class IdentityStore {
  constructor({ dataDir = DATA_DIR, filename = identityDatabasePath(dataDir) } = {}) {
    this.filename = filename;
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    try { fs.chmodSync(filename, 0o600); } catch { /* best effort */ }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS people (
        uin TEXT PRIMARY KEY,
        primary_name TEXT NOT NULL DEFAULT '',
        first_seen_at INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        chat_count INTEGER NOT NULL DEFAULT 0,
        is_friend INTEGER NOT NULL DEFAULT 0,
        legacy_memory_count INTEGER NOT NULL DEFAULT 0,
        profile_json TEXT NOT NULL DEFAULT '{}',
        profile_updated_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS identity_sources (
        uin TEXT NOT NULL,
        chat_key TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (uin, chat_key),
        FOREIGN KEY (uin) REFERENCES people(uin) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS identity_aliases (
        uin TEXT NOT NULL,
        chat_key TEXT NOT NULL,
        alias TEXT NOT NULL,
        seen_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL DEFAULT 0,
        last_seen_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (uin, chat_key, alias),
        FOREIGN KEY (uin) REFERENCES people(uin) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS legacy_memory_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uin TEXT NOT NULL,
        chat_key TEXT NOT NULL,
        content TEXT NOT NULL,
        observed_at INTEGER NOT NULL DEFAULT 0,
        source_file TEXT NOT NULL DEFAULT '',
        UNIQUE (uin, chat_key, content),
        FOREIGN KEY (uin) REFERENCES people(uin) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS identity_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS friend_proposals (
        id TEXT PRIMARY KEY,
        uin TEXT NOT NULL,
        source_chat_key TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        reason TEXT NOT NULL,
        verification_message TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        decided_at INTEGER NOT NULL DEFAULT 0,
        decided_by TEXT NOT NULL DEFAULT '',
        notified_at INTEGER NOT NULL DEFAULT 0,
        notify_error TEXT NOT NULL DEFAULT '',
        cooldown_until INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS identity_people_recent ON people(last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS identity_sources_chat ON identity_sources(chat_key, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS identity_memories_person ON legacy_memory_refs(uin, observed_at DESC);
      CREATE INDEX IF NOT EXISTS friend_proposals_recent
        ON friend_proposals(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS friend_proposals_person
        ON friend_proposals(uin, created_at DESC);
    `);
  }

  close() {
    this.db.close();
  }

  rebuild({ activityRows = [], legacyMemories = [], friends = [], now = Date.now() } = {}) {
    const people = new Map();
    const sources = new Map();
    const aliases = new Map();
    const memories = new Map();
    const friendMap = new Map();

    const person = (uin) => {
      if (!people.has(uin)) {
        people.set(uin, {
          uin,
          primaryName: '',
          firstSeenAt: 0,
          lastSeenAt: 0,
          messageCount: 0,
          chatCount: 0,
          isFriend: false,
          legacyMemoryCount: 0
        });
      }
      return people.get(uin);
    };

    for (const friend of friends || []) {
      const uin = normalizeUin(friend?.userId ?? friend?.user_id);
      if (!uin) continue;
      const name = cleanName(friend?.remark || friend?.name || friend?.nickname);
      friendMap.set(uin, name);
      const row = person(uin);
      row.isFriend = true;
      if (name) row.primaryName = name;
    }

    for (const raw of activityRows || []) {
      const uin = normalizeUin(raw?.userId);
      const chatKey = String(raw?.chatKey || '');
      if (!uin || !/^(group|private):\d+$/.test(chatKey)) continue;
      const count = Math.max(0, Number(raw.messageCount) || 0);
      const firstSeenAt = Number(raw.firstSeenAt) || 0;
      const lastSeenAt = Number(raw.lastSeenAt) || 0;
      const sourceKey = `${uin}\u0000${chatKey}`;
      const source = sources.get(sourceKey) || {
        uin, chatKey, messageCount: 0, firstSeenAt: 0, lastSeenAt: 0
      };
      source.messageCount += count;
      source.firstSeenAt = source.firstSeenAt
        ? Math.min(source.firstSeenAt, firstSeenAt || source.firstSeenAt)
        : firstSeenAt;
      source.lastSeenAt = Math.max(source.lastSeenAt, lastSeenAt);
      sources.set(sourceKey, source);

      const name = cleanName(raw.name);
      if (name) {
        const aliasKey = `${sourceKey}\u0000${name}`;
        const alias = aliases.get(aliasKey) || {
          uin, chatKey, alias: name, seenCount: 0, firstSeenAt: 0, lastSeenAt: 0
        };
        alias.seenCount += count;
        alias.firstSeenAt = alias.firstSeenAt
          ? Math.min(alias.firstSeenAt, firstSeenAt || alias.firstSeenAt)
          : firstSeenAt;
        alias.lastSeenAt = Math.max(alias.lastSeenAt, lastSeenAt);
        aliases.set(aliasKey, alias);
      }

      const row = person(uin);
      row.messageCount += count;
      row.firstSeenAt = row.firstSeenAt
        ? Math.min(row.firstSeenAt, firstSeenAt || row.firstSeenAt)
        : firstSeenAt;
      if (lastSeenAt >= row.lastSeenAt && name && !friendMap.has(uin)) {
        row.primaryName = name;
      }
      row.lastSeenAt = Math.max(row.lastSeenAt, lastSeenAt);
    }

    for (const raw of legacyMemories || []) {
      const uin = normalizeUin(raw?.userId);
      const chatKey = String(raw?.chatKey || '');
      const content = cleanMemory(raw?.content);
      if (!uin || !/^(group|private):\d+$/.test(chatKey) || !content) continue;
      const key = `${uin}\u0000${chatKey}\u0000${content}`;
      memories.set(key, {
        uin,
        chatKey,
        content,
        observedAt: Number(raw.observedAt) || 0,
        sourceFile: String(raw.sourceFile || '').slice(0, 500)
      });
      person(uin);
    }

    for (const source of sources.values()) {
      person(source.uin).chatCount += 1;
    }
    for (const memory of memories.values()) {
      person(memory.uin).legacyMemoryCount += 1;
    }

    const previous = new Map(this.db.prepare(
      'SELECT uin, profile_json, profile_updated_at, created_at FROM people'
    ).all().map((row) => [String(row.uin), row]));

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM identity_aliases; DELETE FROM identity_sources; DELETE FROM legacy_memory_refs; DELETE FROM people;');
      const insertPerson = this.db.prepare(`
        INSERT INTO people (
          uin, primary_name, first_seen_at, last_seen_at, message_count, chat_count,
          is_friend, legacy_memory_count, profile_json, profile_updated_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of people.values()) {
        const old = previous.get(row.uin);
        insertPerson.run(
          row.uin,
          friendMap.get(row.uin) || row.primaryName,
          row.firstSeenAt,
          row.lastSeenAt,
          row.messageCount,
          row.chatCount,
          row.isFriend ? 1 : 0,
          row.legacyMemoryCount,
          old?.profile_json || '{}',
          Number(old?.profile_updated_at) || 0,
          Number(old?.created_at) || now,
          now
        );
      }
      for (const uin of friendMap.keys()) {
        this.db.prepare(`
          UPDATE friend_proposals
          SET status='accepted', decided_at=CASE WHEN decided_at=0 THEN ? ELSE decided_at END,
            updated_at=?
          WHERE uin=? AND status IN ('pending','approved_manual')
        `).run(now, now, uin);
      }

      const insertSource = this.db.prepare(`
        INSERT INTO identity_sources
          (uin, chat_key, message_count, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of sources.values()) {
        insertSource.run(
          row.uin, row.chatKey, row.messageCount, row.firstSeenAt, row.lastSeenAt
        );
      }

      const insertAlias = this.db.prepare(`
        INSERT INTO identity_aliases
          (uin, chat_key, alias, seen_count, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const row of aliases.values()) {
        insertAlias.run(
          row.uin, row.chatKey, row.alias, row.seenCount, row.firstSeenAt, row.lastSeenAt
        );
      }

      const insertMemory = this.db.prepare(`
        INSERT INTO legacy_memory_refs
          (uin, chat_key, content, observed_at, source_file)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of memories.values()) {
        insertMemory.run(
          row.uin, row.chatKey, row.content, row.observedAt, row.sourceFile
        );
      }
      this.db.prepare(`
        INSERT INTO identity_meta(key, value) VALUES ('last_indexed_at', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `).run(String(now));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.status();
  }

  observe(chatKey, message) {
    const uin = normalizeUin(message?.senderId);
    const source = String(chatKey || '');
    if (!uin || !/^(group|private):\d+$/.test(source) || message?.self) return false;
    const name = cleanName(message?.senderName);
    const at = Number(message?.ts) || Date.now();
    const now = Date.now();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO people (
          uin, primary_name, first_seen_at, last_seen_at, message_count, chat_count,
          is_friend, legacy_memory_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, 1, 0, 0, ?, ?)
        ON CONFLICT(uin) DO UPDATE SET
          primary_name=CASE WHEN excluded.primary_name!='' THEN excluded.primary_name ELSE people.primary_name END,
          first_seen_at=CASE WHEN people.first_seen_at=0 THEN excluded.first_seen_at ELSE MIN(people.first_seen_at, excluded.first_seen_at) END,
          last_seen_at=MAX(people.last_seen_at, excluded.last_seen_at),
          message_count=people.message_count+1,
          updated_at=excluded.updated_at
      `).run(uin, name, at, at, now, now);
      this.db.prepare(`
        INSERT INTO identity_sources
          (uin, chat_key, message_count, first_seen_at, last_seen_at)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT(uin, chat_key) DO UPDATE SET
          message_count=identity_sources.message_count+1,
          first_seen_at=CASE WHEN identity_sources.first_seen_at=0 THEN excluded.first_seen_at ELSE MIN(identity_sources.first_seen_at, excluded.first_seen_at) END,
          last_seen_at=MAX(identity_sources.last_seen_at, excluded.last_seen_at)
      `).run(uin, source, at, at);
      if (name) {
        this.db.prepare(`
          INSERT INTO identity_aliases
            (uin, chat_key, alias, seen_count, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, 1, ?, ?)
          ON CONFLICT(uin, chat_key, alias) DO UPDATE SET
            seen_count=identity_aliases.seen_count+1,
            first_seen_at=CASE WHEN identity_aliases.first_seen_at=0 THEN excluded.first_seen_at ELSE MIN(identity_aliases.first_seen_at, excluded.first_seen_at) END,
            last_seen_at=MAX(identity_aliases.last_seen_at, excluded.last_seen_at)
        `).run(uin, source, name, at, at);
      }
      this.db.prepare(`
        UPDATE people SET chat_count=(
          SELECT COUNT(*) FROM identity_sources WHERE identity_sources.uin=people.uin
        ) WHERE uin=?
      `).run(uin);
      this.db.prepare(`
        INSERT INTO identity_meta(key, value) VALUES ('last_observed_at', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
      `).run(String(now));
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  status() {
    const totals = this.db.prepare(`
      SELECT COUNT(*) AS people,
        COALESCE(SUM(message_count),0) AS messages,
        COALESCE(SUM(is_friend),0) AS friends,
        COALESCE(SUM(legacy_memory_count),0) AS legacyMemories
      FROM people
    `).get();
    const aliases = this.db.prepare('SELECT COUNT(*) AS count FROM identity_aliases').get();
    const sources = this.db.prepare('SELECT COUNT(*) AS count FROM identity_sources').get();
    const indexed = this.db.prepare(
      "SELECT value FROM identity_meta WHERE key='last_indexed_at'"
    ).get();
    return {
      people: Number(totals.people) || 0,
      messages: Number(totals.messages) || 0,
      friends: Number(totals.friends) || 0,
      legacyMemories: Number(totals.legacyMemories) || 0,
      aliases: Number(aliases.count) || 0,
      sources: Number(sources.count) || 0,
      lastIndexedAt: Number(indexed?.value) || 0
    };
  }

  listPeople(limit = 100) {
    const rows = this.db.prepare(`
      SELECT * FROM people
      ORDER BY last_seen_at DESC, message_count DESC, uin
      LIMIT ?
    `).all(Math.min(500, Math.max(1, Number(limit) || 100)));
    const aliasStmt = this.db.prepare(`
      SELECT alias, chat_key AS chatKey, seen_count AS seenCount,
        first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
      FROM identity_aliases WHERE uin=?
      ORDER BY last_seen_at DESC, seen_count DESC
    `);
    return rows.map((row) => ({
      userId: String(row.uin),
      primaryName: String(row.primary_name || ''),
      firstSeenAt: Number(row.first_seen_at) || 0,
      lastSeenAt: Number(row.last_seen_at) || 0,
      messageCount: Number(row.message_count) || 0,
      chatCount: Number(row.chat_count) || 0,
      isFriend: Boolean(row.is_friend),
      legacyMemoryCount: Number(row.legacy_memory_count) || 0,
      aliases: aliasStmt.all(row.uin).map((alias) => ({
        ...alias,
        seenCount: Number(alias.seenCount) || 0,
        firstSeenAt: Number(alias.firstSeenAt) || 0,
        lastSeenAt: Number(alias.lastSeenAt) || 0
      }))
    }));
  }

  listFriendProposals({ status = '', limit = 100 } = {}) {
    const normalizedStatus = String(status || '').trim();
    const size = Math.min(500, Math.max(1, Number(limit) || 100));
    const rows = normalizedStatus
      ? this.db.prepare(`
          SELECT fp.*, p.primary_name
          FROM friend_proposals fp
          LEFT JOIN people p ON p.uin=fp.uin
          WHERE fp.status=?
          ORDER BY fp.created_at DESC
          LIMIT ?
        `).all(normalizedStatus, size)
      : this.db.prepare(`
          SELECT fp.*, p.primary_name
          FROM friend_proposals fp
          LEFT JOIN people p ON p.uin=fp.uin
          ORDER BY fp.created_at DESC
          LIMIT ?
        `).all(size);
    return rows.map(proposalView);
  }

  getFriendProposal(id) {
    return proposalView(this.db.prepare(`
      SELECT fp.*, p.primary_name
      FROM friend_proposals fp
      LEFT JOIN people p ON p.uin=fp.uin
      WHERE fp.id=?
    `).get(String(id || '').trim()));
  }

  createFriendProposal({
    userId,
    sourceChatKey,
    reasonCode,
    reason,
    verificationMessage = '',
    minMessageCount = 50,
    cooldownDays = 30,
    maxPending = 10,
    now = Date.now()
  }) {
    const uin = normalizeUin(userId);
    const source = String(sourceChatKey || '');
    const code = FRIEND_PROPOSAL_REASONS.has(reasonCode) ? reasonCode : '';
    const reasonText = cleanMemory(reason).slice(0, 240);
    const verification = cleanMemory(verificationMessage).slice(0, 50);
    if (!uin) throw new Error('好友候选必须使用数字 QQ 号');
    if (!/^(group|private):\d+$/.test(source)) throw new Error('好友候选来源会话无效');
    if (!code) throw new Error('好友候选原因必须是 interest、frequent 或 banter');
    if (!reasonText) throw new Error('好友候选必须说明具体原因');

    const person = this.db.prepare('SELECT * FROM people WHERE uin=?').get(uin);
    if (!person || !this.hasSource(uin, source)) {
      throw new Error('只能提议当前会话中已经出现过的人');
    }
    if (Number(person.is_friend)) throw new Error('对方已经是好友');
    const threshold = Math.min(10000, Math.max(1, Number(minMessageCount) || 50));
    if ((Number(person.message_count) || 0) < threshold) {
      throw new Error(`互动消息不足：当前 ${Number(person.message_count) || 0}，至少需要 ${threshold}`);
    }

    const latest = this.db.prepare(`
      SELECT fp.*, p.primary_name
      FROM friend_proposals fp
      LEFT JOIN people p ON p.uin=fp.uin
      WHERE fp.uin=?
      ORDER BY fp.created_at DESC
      LIMIT 1
    `).get(uin);
    if (latest && OPEN_FRIEND_PROPOSAL_STATES.has(String(latest.status))) {
      return { created: false, proposal: proposalView(latest), reason: 'already-open' };
    }
    if (latest && Number(latest.cooldown_until) > now) {
      throw new Error(`该用户仍在好友提议冷却期，${new Date(Number(latest.cooldown_until)).toLocaleString('zh-CN', { hour12: false })} 后可再次提议`);
    }
    const pending = Number(this.db.prepare(
      "SELECT COUNT(*) AS n FROM friend_proposals WHERE status='pending'"
    ).get().n) || 0;
    const pendingLimit = Math.min(100, Math.max(1, Number(maxPending) || 10));
    if (pending >= pendingLimit) throw new Error(`待审批好友候选已达上限 ${pendingLimit}`);

    const id = `fp_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const cooldownUntil = now + Math.min(365, Math.max(1, Number(cooldownDays) || 30))
      * 86400000;
    this.db.prepare(`
      INSERT INTO friend_proposals (
        id, uin, source_chat_key, reason_code, reason, verification_message,
        status, created_at, cooldown_until, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      id,
      uin,
      source,
      code,
      reasonText,
      verification,
      now,
      cooldownUntil,
      now
    );
    return { created: true, proposal: this.getFriendProposal(id), reason: '' };
  }

  markFriendProposalNotification(id, { notified = false, error = '', now = Date.now() } = {}) {
    this.db.prepare(`
      UPDATE friend_proposals
      SET notified_at=?, notify_error=?, updated_at=?
      WHERE id=?
    `).run(notified ? now : 0, String(error || '').slice(0, 500), now, String(id || ''));
    return this.getFriendProposal(id);
  }

  decideFriendProposal(id, decision, {
    decidedBy = '',
    now = Date.now()
  } = {}) {
    const proposal = this.getFriendProposal(id);
    if (!proposal) throw new Error('好友候选不存在');
    if (proposal.status === 'accepted') return proposal;
    if (decision === 'approve' && proposal.status === 'approved_manual') return proposal;
    if (proposal.status !== 'pending') throw new Error(`好友候选已处理：${proposal.status}`);
    const status = decision === 'approve'
      ? 'approved_manual'
      : decision === 'reject'
        ? 'rejected'
        : '';
    if (!status) throw new Error('审批决定必须是 approve 或 reject');
    this.db.prepare(`
      UPDATE friend_proposals
      SET status=?, decided_at=?, decided_by=?, updated_at=?
      WHERE id=? AND status='pending'
    `).run(status, now, String(decidedBy || ''), now, proposal.id);
    return this.getFriendProposal(proposal.id);
  }

  markFriendAdded(userId, now = Date.now()) {
    const uin = normalizeUin(userId);
    if (!uin) return 0;
    this.db.prepare('UPDATE people SET is_friend=1, updated_at=? WHERE uin=?').run(now, uin);
    return this.db.prepare(`
      UPDATE friend_proposals
      SET status='accepted', decided_at=CASE WHEN decided_at=0 THEN ? ELSE decided_at END,
        updated_at=?
      WHERE uin=? AND status IN ('pending','approved_manual')
    `).run(now, now, uin).changes;
  }

  friendProposalStats() {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status='approved_manual' THEN 1 ELSE 0 END) AS approvedManual,
        SUM(CASE WHEN status='accepted' THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected
      FROM friend_proposals
    `).get();
    return {
      total: Number(row.total) || 0,
      pending: Number(row.pending) || 0,
      approvedManual: Number(row.approvedManual) || 0,
      accepted: Number(row.accepted) || 0,
      rejected: Number(row.rejected) || 0
    };
  }

  hasSource(userId, chatKey) {
    const uin = normalizeUin(userId);
    const source = String(chatKey || '');
    if (!uin || !source) return false;
    return Boolean(this.db.prepare(
      'SELECT 1 FROM identity_sources WHERE uin=? AND chat_key=?'
    ).get(uin, source));
  }

  /**
   * 返回适合模型使用的受限人物视图。
   * 原始跨会话记忆不会返回；模型只能看到当前会话的旧印象和聚合计数。
   */
  getPerson(userId, { chatKey, maxAliases = 8, maxMemories = 6 } = {}) {
    const uin = normalizeUin(userId);
    const source = String(chatKey || '');
    if (!uin || !source) return null;
    const row = this.db.prepare('SELECT * FROM people WHERE uin=?').get(uin);
    if (!row) return null;
    const sourceRow = this.db.prepare(`
      SELECT message_count AS messageCount, first_seen_at AS firstSeenAt,
        last_seen_at AS lastSeenAt
      FROM identity_sources WHERE uin=? AND chat_key=?
    `).get(uin, source);
    if (!sourceRow) return null;
    const aliases = this.db.prepare(`
      SELECT alias, chat_key AS chatKey, seen_count AS seenCount, last_seen_at AS lastSeenAt
      FROM identity_aliases WHERE uin=?
      ORDER BY last_seen_at DESC, seen_count DESC
    `).all(uin);
    const currentMemories = this.db.prepare(`
      SELECT content, observed_at AS observedAt
      FROM legacy_memory_refs
      WHERE uin=? AND chat_key=?
      ORDER BY observed_at DESC, id DESC
      LIMIT ?
    `).all(uin, source, Math.min(12, Math.max(1, Number(maxMemories) || 6)));
    let profile = {};
    try { profile = JSON.parse(row.profile_json || '{}'); } catch { profile = {}; }
    const uniqueAliases = [];
    const seenAliases = new Set();
    for (const alias of aliases) {
      const name = cleanName(alias.alias);
      if (!name || seenAliases.has(name)) continue;
      seenAliases.add(name);
      uniqueAliases.push(name);
      if (uniqueAliases.length >= Math.min(20, Math.max(1, Number(maxAliases) || 8))) break;
    }
    const currentMemoryCount = this.db.prepare(`
      SELECT COUNT(*) AS count FROM legacy_memory_refs WHERE uin=? AND chat_key=?
    `).get(uin, source);
    return {
      userId: uin,
      primaryName: String(row.primary_name || ''),
      aliases: uniqueAliases,
      isFriend: Boolean(row.is_friend),
      firstSeenAt: Number(row.first_seen_at) || 0,
      lastSeenAt: Number(row.last_seen_at) || 0,
      messageCount: Number(row.message_count) || 0,
      chatCount: Number(row.chat_count) || 0,
      currentChatMessageCount: Number(sourceRow.messageCount) || 0,
      currentContextMemories: currentMemories.map((memory) => ({
        content: cleanMemory(memory.content).slice(0, 160),
        observedAt: Number(memory.observedAt) || 0
      })),
      otherContextMemoryCount: Math.max(
        0,
        (Number(row.legacy_memory_count) || 0) - (Number(currentMemoryCount.count) || 0)
      ),
      safeProfile: profile && typeof profile === 'object' ? profile : {}
    };
  }
}
