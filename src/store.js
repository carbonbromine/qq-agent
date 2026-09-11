import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';

function entry(row) {
  if (!row) return null;
  return {
    ...row, senderId: row.sender_id, senderName: row.sender_name,
    self: !!row.self, read: row.state === 'acked',
    reply: row.reply ? JSON.parse(row.reply) : null,
    media: JSON.parse(row.media || '[]')
  };
}

export class ChatStore {
  constructor(maxPerChat = 0, { dataDir = DATA_DIR, filename } = {}) {
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename || path.join(dataDir, 'messages.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS chats (chat_key TEXT PRIMARY KEY, next_id INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS messages (
        chat_key TEXT NOT NULL, id INTEGER NOT NULL, mid TEXT, ts INTEGER NOT NULL,
        sender_id TEXT, sender_name TEXT, text TEXT NOT NULL, self INTEGER NOT NULL DEFAULT 0,
        reply TEXT, media TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'pending', lease_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL DEFAULT 0, error TEXT,
        PRIMARY KEY (chat_key, id), UNIQUE (chat_key, mid)
      );
      CREATE INDEX IF NOT EXISTS messages_pending ON messages(chat_key, state, available_at, id);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, chat_key TEXT NOT NULL, state TEXT NOT NULL,
        expires_at INTEGER NOT NULL, error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_lease_per_chat ON runs(chat_key) WHERE state='leased';
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, run_id TEXT, chat_key TEXT NOT NULL,
        state TEXT NOT NULL, payload TEXT NOT NULL, message_id TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
    `);
    this.#importJson(dataDir);
  }

  #transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  #importJson(dataDir) {
    const dir = path.join(dataDir, 'messages');
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).filter((s) => /^(group|private)_\d+\.json$/.test(s))) {
      if (this.db.prepare('SELECT 1 FROM migrations WHERE name=?').get(name)) continue;
      // Fail closed on corrupt legacy files; never replace them with an empty database.
      const state = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\uFEFF/, ''));
      const key = state.chatKey || name.replace(/^(group|private)_/, '$1:').replace(/\.json$/, '');
      if (!Array.isArray(state.messages)) throw new Error(`Invalid legacy message archive: ${name}`);
      this.#transaction(() => {
        for (const m of state.messages) {
          this.#append(key, m, m.self ? 'acked' : m.read ? 'acked' : 'pending');
        }
        this.db.prepare('INSERT INTO migrations(name) VALUES (?)').run(name);
      });
    }
  }

  #append(chatKey, m, state) {
    const mid = m.mid == null ? null : String(m.mid);
    if (mid !== null) {
      const existing = this.db.prepare('SELECT * FROM messages WHERE chat_key=? AND mid=?').get(chatKey, mid);
      if (existing) return { ...entry(existing), duplicate: true };
    }
    this.db.prepare('INSERT OR IGNORE INTO chats(chat_key) VALUES (?)').run(chatKey);
    const id = this.db.prepare('SELECT next_id FROM chats WHERE chat_key=?').get(chatKey).next_id;
    this.db.prepare(`INSERT INTO messages
      (chat_key,id,mid,ts,sender_id,sender_name,text,self,reply,media,state)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      chatKey, id, mid, Number(m.ts) || Date.now(), String(m.senderId || ''),
      String(m.senderName || ''), String(m.text || ''), m.self ? 1 : 0,
      m.reply ? JSON.stringify(m.reply) : null, JSON.stringify(m.media || []), state
    );
    this.db.prepare('UPDATE chats SET next_id=next_id+1 WHERE chat_key=?').run(chatKey);
    if (this.maxPerChat > 0) {
      // Retention must never evict unprocessed or uncertain messages.
      this.db.prepare(`DELETE FROM messages WHERE chat_key=? AND state='acked' AND id <
        COALESCE((SELECT id FROM messages WHERE chat_key=? ORDER BY id DESC LIMIT 1 OFFSET ?),0)`)
        .run(chatKey, chatKey, this.maxPerChat - 1);
    }
    return entry(this.db.prepare('SELECT * FROM messages WHERE chat_key=? AND id=?').get(chatKey, id));
  }

  appendIncoming(chatKey, message) {
    return this.#transaction(() => this.#append(chatKey, { ...message, self: false }, 'pending'));
  }

  appendSelf(chatKey, message) {
    return this.#transaction(() => this.#append(chatKey, {
      ...message, self: true, senderId: 'self', senderName: '我'
    }, 'acked'));
  }

  setMaxPerChat(cap) { this.maxPerChat = Math.max(0, Number(cap) || 0); }
  listChats() { return this.db.prepare('SELECT chat_key FROM chats ORDER BY chat_key').all().map((r) => r.chat_key); }
  close() { this.db.close(); }

  getChatMeta(chatKey) {
    const counts = this.db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(state IN ('pending','leased')),0) AS unread,
      COALESCE(SUM(state='failed'),0) AS failed,
      COALESCE(SUM(state='held'),0) AS heldMessages FROM messages WHERE chat_key=?`).get(chatKey);
    const uncertain = this.db.prepare(`SELECT COUNT(DISTINCT COALESCE(run_id,id)) AS held
      FROM outbox WHERE chat_key=? AND state IN ('sending','unknown')`).get(chatKey).held;
    const last = this.db.prepare('SELECT ts,text FROM messages WHERE chat_key=? ORDER BY id DESC LIMIT 1').get(chatKey);
    const { heldMessages, ...rest } = counts;
    return {
      chatKey, ...rest, held: Math.max(Number(heldMessages) || 0, Number(uncertain) || 0),
      lastTs: last?.ts || 0, lastText: last?.text || ''
    };
  }

  unreadCount(chatKey) {
    return this.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE chat_key=? AND self=0
      AND state='pending' AND available_at<=?`).get(chatKey, Date.now()).n;
  }

  peekUnread(chatKey, limit = 3) {
    return this.db.prepare(`SELECT * FROM messages WHERE chat_key=? AND self=0
      AND state='pending' AND available_at<=? ORDER BY id LIMIT ?`)
      .all(chatKey, Date.now(), Math.max(1, Number(limit) || 3)).map(entry);
  }

  markRead(chatKey, ids) {
    return this.#transaction(() => {
      let n = 0;
      const stmt = this.db.prepare(`UPDATE messages SET state='acked' WHERE chat_key=? AND id=? AND state='pending'`);
      for (const id of ids) n += stmt.run(chatKey, id).changes;
      return n;
    });
  }

  markAllRead(chatKey) {
    return this.db.prepare(`UPDATE messages SET state='acked' WHERE chat_key=? AND state='pending'`).run(chatKey).changes;
  }

  // Administrative compatibility API. Agent execution uses claimUnread/ackLease instead.
  drainUnread(chatKey) {
    const messages = this.peekUnread(chatKey, 1000000);
    this.markRead(chatKey, messages.map((m) => m.id));
    return messages;
  }

  claimUnread(chatKey, { limit = 100, maxChars = 32000, leaseMs = 240000 } = {}) {
    return this.#transaction(() => {
      if (this.db.prepare("SELECT 1 FROM runs WHERE chat_key=? AND state='leased'").get(chatKey)) return null;
      const pending = this.peekUnread(chatKey, Math.min(100, Math.max(1, limit)));
      const messages = [];
      let chars = 0;
      for (const m of pending) {
        const length = Math.min(m.text.length, 2000) + 100;
        if (messages.length && chars + length > maxChars) break;
        messages.push({ ...m, text: m.text.length > 2000 ? `${m.text.slice(0, 2000)} [truncated; use get_message_detail]` : m.text });
        chars += length;
      }
      if (!messages.length) return null;
      const id = crypto.randomUUID();
      this.db.prepare("INSERT INTO runs(id,chat_key,state,expires_at) VALUES (?,?,'leased',?)")
        .run(id, chatKey, Date.now() + leaseMs);
      const update = this.db.prepare("UPDATE messages SET state='leased',lease_id=?,attempts=attempts+1 WHERE chat_key=? AND id=?");
      for (const m of messages) update.run(id, chatKey, m.id);
      return { id, messages };
    });
  }

  ackLease(id) {
    return this.#transaction(() => {
      const changed = this.db.prepare("UPDATE messages SET state='acked',lease_id=NULL WHERE lease_id=? AND state='leased'").run(id).changes;
      this.db.prepare("UPDATE runs SET state='acked' WHERE id=? AND state='leased'").run(id);
      this.db.prepare("DELETE FROM outbox WHERE run_id=? AND state='sent'").run(id);
      return changed;
    });
  }

  completeRun(id) {
    return this.db.prepare("DELETE FROM outbox WHERE run_id=? AND state='sent'").run(id).changes;
  }

  hasEffects(id) {
    return !!this.db.prepare("SELECT 1 FROM outbox WHERE run_id=? AND state IN ('sending','sent','unknown') LIMIT 1").get(id);
  }

  hasUncertainEffects(id) {
    return !!this.db.prepare("SELECT 1 FROM outbox WHERE run_id=? AND state IN ('sending','unknown') LIMIT 1").get(id);
  }

  failLease(id, error, { retryable = true, delayMs = 5000, maxAttempts = 3 } = {}) {
    return this.#transaction(() => {
      const held = this.hasEffects(id);
      this.db.prepare(`UPDATE messages SET state=CASE WHEN ? THEN 'held'
        WHEN attempts>=? OR ? THEN 'failed' ELSE 'pending' END,
        lease_id=NULL,available_at=?,error=? WHERE lease_id=? AND state='leased'`)
        .run(held ? 1 : 0, maxAttempts, retryable ? 0 : 1, Date.now() + delayMs, String(error).slice(0, 1000), id);
      this.db.prepare("UPDATE runs SET state=?,error=? WHERE id=? AND state='leased'")
        .run(held ? 'held' : 'failed', String(error).slice(0, 1000), id);
      return held;
    });
  }

  recoverExpired(now = Date.now()) {
    const runs = this.db.prepare("SELECT id FROM runs WHERE state='leased' AND expires_at<=?").all(now);
    for (const run of runs) this.failLease(run.id, 'Lease expired or process interrupted', { delayMs: 0 });
    return runs.length;
  }

  retryFailed(chatKey) {
    // Unknown/partially sent batches require operator review and are deliberately excluded.
    return this.db.prepare(`UPDATE messages SET state='pending',attempts=0,available_at=0
      WHERE chat_key=? AND state='failed'`).run(chatKey).changes;
  }

  resolveHeld(chatKey) {
    return this.#transaction(() => {
      const messages = this.db.prepare("UPDATE messages SET state='acked' WHERE chat_key=? AND state='held'").run(chatKey).changes;
      const outbox = this.db.prepare(`DELETE FROM outbox
        WHERE chat_key=? AND state IN ('sending','unknown')`).run(chatKey).changes;
      this.db.prepare("UPDATE runs SET state='acked' WHERE chat_key=? AND state='held'").run(chatKey);
      return Math.max(messages, outbox);
    });
  }

  beginSend(chatKey, runId, payload) {
    const id = crypto.randomUUID();
    this.db.prepare("INSERT INTO outbox(id,run_id,chat_key,state,payload) VALUES (?,?,?,'sending',?)")
      .run(id, runId || null, chatKey, JSON.stringify(payload));
    return id;
  }

  finishSend(id, { messageId, error } = {}) {
    this.db.prepare('UPDATE outbox SET state=?,message_id=?,error=? WHERE id=?')
      .run(error ? 'unknown' : 'sent', messageId == null ? null : String(messageId),
        error ? String(error).slice(0, 1000) : null, id);
  }

  recent(chatKey, { limit = 80, offset = 0, includeSelf = true, readOnly = false } = {}) {
    return this.db.prepare(`SELECT * FROM messages WHERE chat_key=? ${includeSelf ? '' : 'AND self=0'}
      ${readOnly ? "AND state='acked'" : ''} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(chatKey, Math.max(1, Number(limit) || 1), Math.max(0, Number(offset) || 0)).reverse().map(entry);
  }

  findByMid(chatKey, mid) {
    return entry(this.db.prepare('SELECT * FROM messages WHERE chat_key=? AND mid=?').get(chatKey, String(mid)));
  }

  findByLocalId(chatKey, localId) {
    return entry(this.db.prepare('SELECT * FROM messages WHERE chat_key=? AND id=?').get(chatKey, Number(localId)));
  }

  updateByMid(chatKey, mid, { text, appendMedia = [] } = {}) {
    const m = this.findByMid(chatKey, mid);
    if (!m) return false;
    const media = [...m.media];
    const seen = new Set(media.map((v) => v.url));
    for (const v of appendMedia) {
      if (v?.url && !seen.has(v.url)) { media.push(v); seen.add(v.url); }
    }
    this.db.prepare('UPDATE messages SET text=?,media=? WHERE chat_key=? AND mid=?')
      .run(text == null ? m.text : String(text), JSON.stringify(media), chatKey, String(mid));
    return true;
  }

  activeMembers(chatKey, limit = 10) {
    return this.db.prepare(`SELECT sender_id AS userId, sender_name AS name, MAX(ts) AS lastTs,
      COUNT(*) AS count FROM messages WHERE chat_key=? AND self=0
      GROUP BY sender_id ORDER BY lastTs DESC LIMIT ?`).all(chatKey, Math.max(1, limit));
  }
}
