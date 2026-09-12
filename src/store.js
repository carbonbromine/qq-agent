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

function threadEntry(row) {
  if (!row) return null;
  let participantIds = [];
  try {
    participantIds = JSON.parse(row.participant_ids || '[]').map(String);
  } catch { /* keep empty */ }
  return {
    chatKey: row.chat_key,
    threadId: row.thread_id,
    mode: row.mode || 'threaded',
    state: row.state,
    disposition: row.disposition || 'active',
    topic: row.topic || '',
    participantIds,
    openedAt: Number(row.opened_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    lastHumanAt: Number(row.last_human_at) || 0,
    lastAgentAt: Number(row.last_agent_at) || 0,
    engagedUntil: Number(row.engaged_until) || 0,
    idleDeadline: Number(row.idle_deadline) || 0,
    hardDeadline: Number(row.hard_deadline) || 0,
    resumeArmedUntil: Number(row.resume_armed_until) || 0,
    expiresAt: Number(row.expires_at) || 0,
    lastMessageId: Number(row.last_message_id) || 0,
    promptHash: row.prompt_hash || '',
    transcriptChars: Number(row.transcript_chars) || 0,
    promptTokens: Number(row.prompt_tokens) || 0,
    version: Number(row.version) || 1,
    closeReason: row.close_reason || ''
  };
}

function ensureColumn(db, table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((column) => column.name === name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

export class ChatStore {
  constructor(maxPerChat = 0, { dataDir = DATA_DIR, filename } = {}) {
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
    this.transactionDepth = 0;
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
      CREATE TABLE IF NOT EXISTS conversation_threads (
        chat_key TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'threaded', state TEXT NOT NULL,
        disposition TEXT NOT NULL DEFAULT 'active',
        topic TEXT NOT NULL DEFAULT '', participant_ids TEXT NOT NULL DEFAULT '[]',
        opened_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        last_human_at INTEGER NOT NULL DEFAULT 0, last_agent_at INTEGER NOT NULL DEFAULT 0,
        engaged_until INTEGER NOT NULL DEFAULT 0, idle_deadline INTEGER NOT NULL DEFAULT 0,
        hard_deadline INTEGER NOT NULL DEFAULT 0, resume_armed_until INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL DEFAULT 0,
        last_message_id INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
        prompt_hash TEXT NOT NULL DEFAULT '', transcript_chars INTEGER NOT NULL DEFAULT 0,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        close_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS conversation_threads_expiry
        ON conversation_threads(state, expires_at);
      CREATE TABLE IF NOT EXISTS thread_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
        chat_key TEXT NOT NULL, run_id TEXT, version INTEGER NOT NULL,
        state_json TEXT NOT NULL, source_message_ids TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS thread_checkpoints_lookup
        ON thread_checkpoints(chat_key, thread_id, version DESC);
      CREATE TABLE IF NOT EXISTS thread_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
        chat_key TEXT NOT NULL, run_id TEXT, sequence INTEGER NOT NULL,
        message_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(thread_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS thread_turns_lookup
        ON thread_turns(thread_id, sequence);
      CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY);
    `);
    ensureColumn(this.db, 'conversation_threads', 'mode', "TEXT NOT NULL DEFAULT 'threaded'");
    ensureColumn(this.db, 'conversation_threads', 'disposition', "TEXT NOT NULL DEFAULT 'active'");
    ensureColumn(this.db, 'conversation_threads', 'idle_deadline', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(this.db, 'conversation_threads', 'hard_deadline', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(this.db, 'conversation_threads', 'resume_armed_until', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(this.db, 'conversation_threads', 'prompt_hash', "TEXT NOT NULL DEFAULT ''");
    ensureColumn(this.db, 'conversation_threads', 'transcript_chars', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(this.db, 'conversation_threads', 'prompt_tokens', 'INTEGER NOT NULL DEFAULT 0');
    this.#importJson(dataDir);
  }

  #transaction(fn) {
    if (this.transactionDepth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth += 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth = 0;
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

  appendIncoming(chatKey, message, { recordOnly = false } = {}) {
    return this.#transaction(() => this.#append(
      chatKey, { ...message, self: false }, recordOnly ? 'acked' : 'pending'
    ));
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
    const thread = this.getConversationThread(chatKey);
    const { heldMessages, ...rest } = counts;
    return {
      chatKey, ...rest, held: Math.max(Number(heldMessages) || 0, Number(uncertain) || 0),
      lastTs: last?.ts || 0, lastText: last?.text || '',
      thread: thread ? {
        threadId: thread.threadId,
        mode: thread.mode,
        state: thread.state,
        disposition: thread.disposition,
        topic: thread.topic,
        participantCount: thread.participantIds.length,
        engagedUntil: thread.engagedUntil,
        idleDeadline: thread.idleDeadline,
        hardDeadline: thread.hardDeadline,
        resumeArmedUntil: thread.resumeArmedUntil,
        expiresAt: thread.expiresAt,
        transcriptChars: thread.transcriptChars,
        version: thread.version
      } : null
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

  expireConversationThreads(now = Date.now(), chatKey = '') {
    const rows = chatKey
      ? this.db.prepare(`SELECT * FROM conversation_threads
        WHERE chat_key=? AND state!='closed'`).all(chatKey)
      : this.db.prepare(`SELECT * FROM conversation_threads WHERE state!='closed'`).all();
    const transitions = [];
    for (const row of rows) {
      let nextState = '';
      let reason = '';
      if ((row.mode || 'threaded') === 'lifecycle') {
        if (row.state === 'rollover_armed') {
          if (Number(row.resume_armed_until) > 0 && Number(row.resume_armed_until) <= now) {
            nextState = 'closed';
            reason = 'rollover-expired';
          }
          } else {
            const idleDeadline = Number(row.idle_deadline) || 0;
            const hardDeadline = Number(row.hard_deadline) || 0;
            const idleDue = idleDeadline > 0 && idleDeadline <= now;
            const hardDue = hardDeadline > 0 && hardDeadline <= now;
            if (idleDue && (!hardDue || idleDeadline < hardDeadline)) {
              nextState = 'closed';
              reason = row.disposition === 'listening' ? 'silent-idle' : 'active-idle';
            } else if (hardDue) {
              nextState = row.disposition === 'active' && Number(row.resume_armed_until) > now
                ? 'rollover_armed'
                : 'closed';
              reason = nextState === 'rollover_armed' ? 'hard-lifetime' : 'hard-lifetime-silent';
            }
        }
      } else if (Number(row.expires_at) > 0 && Number(row.expires_at) <= now) {
        nextState = 'closed';
        reason = 'expired';
      }
      if (nextState) transitions.push({ row, nextState, reason });
    }
    if (!transitions.length) return 0;
    // #region debug-point C:thread-expiry-transition
    for (const { row, nextState, reason } of transitions) (() => { const body = JSON.stringify({ sessionId: process.env.DEBUG_SESSION_ID || 'lifecycle-instant-close', runId: process.env.DEBUG_RUN_ID || 'pre-fix', hypothesisId: 'C', location: 'src/store.js:expireConversationThreads', msg: '[DEBUG] Conversation thread expired or rolled over', data: { chatKey: row.chat_key, threadId: row.thread_id, previousState: row.state, disposition: row.disposition, nextState, reason, now, idleDeadline: Number(row.idle_deadline) || 0, hardDeadline: Number(row.hard_deadline) || 0, resumeArmedUntil: Number(row.resume_armed_until) || 0 }, ts: Date.now() }); const req = process.getBuiltinModule('node:http').request(process.env.DEBUG_SERVER_URL || 'http://192.168.31.10:7777/event', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => res.resume()); req.on('error', () => {}); req.end(body); })();
    // #endregion
    this.#transaction(() => {
      for (const { row, nextState, reason } of transitions) {
        this.db.prepare(`UPDATE conversation_threads SET state=?,close_reason=?,
          transcript_chars=0,prompt_tokens=0,updated_at=?,version=version+1 WHERE chat_key=?`)
          .run(nextState, reason, now, row.chat_key);
        this.db.prepare('DELETE FROM thread_turns WHERE thread_id=?').run(row.thread_id);
      }
    });
    return transitions.length;
  }

  getConversationThread(chatKey, now = Date.now()) {
    this.expireConversationThreads(now, chatKey);
    const row = this.db.prepare('SELECT * FROM conversation_threads WHERE chat_key=?').get(chatKey);
    return !row || row.state === 'closed' ? null : threadEntry(row);
  }

  upsertConversationThread(chatKey, {
    participantIds = [],
    topic = '',
    lastMessageId = 0,
    lastHumanAt = 0,
    lastAgentAt = Date.now(),
    continuationWindowMs = 180000,
    ttlMs = 1800000
  } = {}) {
    const now = Date.now();
    this.expireConversationThreads(now, chatKey);
    return this.#transaction(() => {
      const row = this.db.prepare('SELECT * FROM conversation_threads WHERE chat_key=?').get(chatKey);
      const current = row && row.state !== 'closed' ? threadEntry(row) : null;
      const existing = current?.mode === 'threaded' ? current : null;
      if (!existing && current?.threadId) {
        this.db.prepare('DELETE FROM thread_turns WHERE thread_id=?').run(current.threadId);
      }
      const participants = [...new Set([
        ...(existing?.participantIds || []),
        ...(Array.isArray(participantIds) ? participantIds : [])
      ].map((id) => String(id).trim()).filter(Boolean))].slice(0, 32);
      const thread = {
        chatKey,
        threadId: existing?.threadId || crypto.randomUUID(),
        mode: 'threaded',
        state: 'engaged',
        disposition: 'active',
        topic: String(topic || existing?.topic || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        participantIds: participants,
        openedAt: existing?.openedAt || now,
        updatedAt: now,
        lastHumanAt: Math.max(Number(lastHumanAt) || 0, existing?.lastHumanAt || 0),
        lastAgentAt: Number(lastAgentAt) || now,
        engagedUntil: now + Math.max(1000, Number(continuationWindowMs) || 180000),
        idleDeadline: 0,
        hardDeadline: 0,
        resumeArmedUntil: 0,
        expiresAt: now + Math.max(60000, Number(ttlMs) || 1800000),
        lastMessageId: Math.max(Number(lastMessageId) || 0, existing?.lastMessageId || 0),
        promptHash: '',
        transcriptChars: 0,
        promptTokens: 0,
        version: (existing?.version || 0) + 1,
        closeReason: ''
      };
      this.db.prepare(`INSERT INTO conversation_threads
        (chat_key,thread_id,mode,state,disposition,topic,participant_ids,opened_at,updated_at,
         last_human_at,last_agent_at,engaged_until,idle_deadline,hard_deadline,
         resume_armed_until,expires_at,last_message_id,prompt_hash,transcript_chars,version,
         close_reason,prompt_tokens)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(chat_key) DO UPDATE SET
          thread_id=excluded.thread_id,mode=excluded.mode,state=excluded.state,
          disposition=excluded.disposition,topic=excluded.topic,
          participant_ids=excluded.participant_ids,opened_at=excluded.opened_at,
          updated_at=excluded.updated_at,last_human_at=excluded.last_human_at,
          last_agent_at=excluded.last_agent_at,engaged_until=excluded.engaged_until,
          idle_deadline=excluded.idle_deadline,hard_deadline=excluded.hard_deadline,
          resume_armed_until=excluded.resume_armed_until,expires_at=excluded.expires_at,
          last_message_id=excluded.last_message_id,prompt_hash=excluded.prompt_hash,
          transcript_chars=excluded.transcript_chars,version=excluded.version,
          close_reason=excluded.close_reason,prompt_tokens=excluded.prompt_tokens`)
        .run(
          thread.chatKey, thread.threadId, thread.mode, thread.state, thread.disposition,
          thread.topic, JSON.stringify(thread.participantIds), thread.openedAt,
          thread.updatedAt, thread.lastHumanAt, thread.lastAgentAt, thread.engagedUntil,
          thread.idleDeadline, thread.hardDeadline, thread.resumeArmedUntil,
          thread.expiresAt, thread.lastMessageId, thread.promptHash,
          thread.transcriptChars, thread.version, thread.closeReason, thread.promptTokens
        );
      return thread;
    });
  }

  updateLifecycleThread(chatKey, {
    disposition = 'listening',
    participantIds = [],
    topic = '',
    lastMessageId = 0,
    lastHumanAt = 0,
    lastAgentAt = 0,
    promptHash = '',
    promptTokens = null,
    silentIdleMs = 300000,
    activeIdleMs = 1200000,
    hardLifetimeMs = 1800000,
    rolloverArmedMs = 600000,
    acceptedAt = null,
    now = Date.now()
  } = {}) {
    const acceptedTime = Number(acceptedAt) || now;
    this.expireConversationThreads(Math.min(now, acceptedTime), chatKey);
    return this.#transaction(() => {
      const row = this.db.prepare('SELECT * FROM conversation_threads WHERE chat_key=?').get(chatKey);
      const current = row && row.state !== 'closed' ? threadEntry(row) : null;
      const reusable = current?.mode === 'lifecycle' && current.state !== 'rollover_armed';
      const openedAt = reusable ? current.openedAt : now;
      const hardDeadline = reusable
        ? current.hardDeadline
        : now + Math.max(60000, Number(hardLifetimeMs) || 1800000);
      const resumeArmedUntil = hardDeadline + Math.max(60000, Number(rolloverArmedMs) || 600000);
      const normalizedDisposition = disposition === 'active' ? 'active' : 'listening';
      const idleMs = normalizedDisposition === 'active'
        ? Math.max(60000, Number(activeIdleMs) || 1200000)
        : Math.max(10000, Number(silentIdleMs) || 300000);
      const idleDeadline = now + idleMs;
      const activeAtHardDeadline = normalizedDisposition === 'active'
        || (reusable && current.disposition === 'active' && acceptedTime <= hardDeadline);
      const state = now >= hardDeadline
        ? (activeAtHardDeadline ? 'rollover_armed' : 'closed')
        : normalizedDisposition;
      // #region debug-point C:lifecycle-deadline-calculation
      (() => { const body = JSON.stringify({ sessionId: process.env.DEBUG_SESSION_ID || 'lifecycle-instant-close', runId: process.env.DEBUG_RUN_ID || 'pre-fix', hypothesisId: 'C', location: 'src/store.js:updateLifecycleThread', msg: '[DEBUG] Lifecycle deadlines calculated', data: { chatKey, currentThreadId: current?.threadId || null, currentState: current?.state || null, currentDisposition: current?.disposition || null, reusable, acceptedTime, now, normalizedDisposition, idleDeadline, hardDeadline, resumeArmedUntil, activeAtHardDeadline, nextState: state }, ts: Date.now() }); const req = process.getBuiltinModule('node:http').request(process.env.DEBUG_SERVER_URL || 'http://192.168.31.10:7777/event', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => res.resume()); req.on('error', () => {}); req.end(body); })();
      // #endregion
      const participants = [...new Set([
        ...(reusable ? current.participantIds : []),
        ...(Array.isArray(participantIds) ? participantIds : [])
      ].map((id) => String(id).trim()).filter(Boolean))].slice(0, 32);
      const thread = {
        chatKey,
        threadId: reusable ? current.threadId : crypto.randomUUID(),
        mode: 'lifecycle',
        state,
        disposition: state === 'rollover_armed' ? 'active' : normalizedDisposition,
        topic: String(topic || (reusable ? current.topic : '') || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        participantIds: participants,
        openedAt,
        updatedAt: now,
        lastHumanAt: Math.max(Number(lastHumanAt) || 0, reusable ? current.lastHumanAt : 0),
        lastAgentAt: Math.max(Number(lastAgentAt) || 0, reusable ? current.lastAgentAt : 0),
        engagedUntil: 0,
        idleDeadline,
        hardDeadline,
        resumeArmedUntil,
        expiresAt: state === 'rollover_armed' ? resumeArmedUntil : Math.min(idleDeadline, hardDeadline),
        lastMessageId: Math.max(Number(lastMessageId) || 0, reusable ? current.lastMessageId : 0),
        promptHash: String(promptHash || (reusable ? current.promptHash : '') || '').slice(0, 100),
        transcriptChars: reusable ? current.transcriptChars : 0,
        promptTokens: promptTokens !== null && promptTokens !== undefined
          && Number.isFinite(Number(promptTokens))
          ? Math.max(0, Math.round(Number(promptTokens)))
          : (reusable ? current.promptTokens : 0),
        version: (reusable ? current.version : 0) + 1,
        closeReason: state === 'rollover_armed' ? 'hard-lifetime' : (state === 'closed' ? 'hard-lifetime-silent' : '')
      };
      if (!reusable && current?.threadId) {
        this.db.prepare('DELETE FROM thread_turns WHERE thread_id=?').run(current.threadId);
      }
      this.db.prepare(`INSERT INTO conversation_threads
        (chat_key,thread_id,mode,state,disposition,topic,participant_ids,opened_at,updated_at,
         last_human_at,last_agent_at,engaged_until,idle_deadline,hard_deadline,
         resume_armed_until,expires_at,last_message_id,prompt_hash,transcript_chars,version,
         close_reason,prompt_tokens)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(chat_key) DO UPDATE SET
          thread_id=excluded.thread_id,mode=excluded.mode,state=excluded.state,
          disposition=excluded.disposition,topic=excluded.topic,
          participant_ids=excluded.participant_ids,opened_at=excluded.opened_at,
          updated_at=excluded.updated_at,last_human_at=excluded.last_human_at,
          last_agent_at=excluded.last_agent_at,engaged_until=excluded.engaged_until,
          idle_deadline=excluded.idle_deadline,hard_deadline=excluded.hard_deadline,
          resume_armed_until=excluded.resume_armed_until,expires_at=excluded.expires_at,
          last_message_id=excluded.last_message_id,prompt_hash=excluded.prompt_hash,
          transcript_chars=excluded.transcript_chars,version=excluded.version,
          close_reason=excluded.close_reason,prompt_tokens=excluded.prompt_tokens`)
        .run(
          thread.chatKey, thread.threadId, thread.mode, thread.state, thread.disposition,
          thread.topic, JSON.stringify(thread.participantIds), thread.openedAt,
          thread.updatedAt, thread.lastHumanAt, thread.lastAgentAt, thread.engagedUntil,
          thread.idleDeadline, thread.hardDeadline, thread.resumeArmedUntil,
          thread.expiresAt, thread.lastMessageId, thread.promptHash,
          thread.transcriptChars, thread.version, thread.closeReason, thread.promptTokens
        );
      if (state === 'rollover_armed' || state === 'closed') {
        this.db.prepare('DELETE FROM thread_turns WHERE thread_id=?').run(thread.threadId);
        thread.transcriptChars = 0;
        thread.promptTokens = 0;
      }
      return state === 'closed' ? null : thread;
    });
  }

  armLifecycleRollover(chatKey, reason = 'context-budget', armedMs = 600000) {
    return this.#transaction(() => {
      const row = this.db.prepare(`SELECT thread_id FROM conversation_threads
        WHERE chat_key=? AND mode='lifecycle' AND state!='closed'`).get(chatKey);
      if (!row) return false;
      const now = Date.now();
      const until = now + Math.max(60000, Number(armedMs) || 600000);
      const changed = this.db.prepare(`UPDATE conversation_threads
        SET state='rollover_armed',disposition='active',resume_armed_until=?,
            expires_at=?,updated_at=?,close_reason=?,transcript_chars=0,
            prompt_tokens=0,version=version+1
        WHERE chat_key=?`).run(
          until, until, now, String(reason).slice(0, 100), chatKey
        ).changes;
      this.db.prepare('DELETE FROM thread_turns WHERE thread_id=?').run(row.thread_id);
      return changed > 0;
    });
  }

  closeConversationThread(chatKey, reason = 'closed') {
    return this.#transaction(() => {
      const row = this.db.prepare(`SELECT thread_id FROM conversation_threads
        WHERE chat_key=? AND state!='closed'`).get(chatKey);
      if (!row) return false;
      const changed = this.db.prepare(`UPDATE conversation_threads SET state='closed',
        close_reason=?,transcript_chars=0,prompt_tokens=0,updated_at=?,version=version+1
        WHERE chat_key=? AND state!='closed'`)
        .run(String(reason).slice(0, 100), Date.now(), chatKey).changes > 0;
      this.db.prepare('DELETE FROM thread_turns WHERE thread_id=?').run(row.thread_id);
      return changed;
    });
  }

  appendThreadTurns(chatKey, threadId, runId, messages = []) {
    if (!Array.isArray(messages) || !messages.length) return { added: 0, chars: 0 };
    return this.#transaction(() => {
      const row = this.db.prepare(`SELECT transcript_chars FROM conversation_threads
        WHERE chat_key=? AND thread_id=? AND mode='lifecycle'
        AND state IN ('active','listening')`).get(chatKey, threadId);
      if (!row) return { added: 0, chars: 0 };
      let sequence = Number(this.db.prepare(`SELECT COALESCE(MAX(sequence),0) AS n
        FROM thread_turns WHERE thread_id=?`).get(threadId).n) || 0;
      const insert = this.db.prepare(`INSERT INTO thread_turns
        (thread_id,chat_key,run_id,sequence,message_json,created_at)
        VALUES (?,?,?,?,?,?)`);
      let chars = 0;
      for (const message of messages) {
        const json = JSON.stringify(message);
        chars += json.length;
        insert.run(threadId, chatKey, runId || null, ++sequence, json, Date.now());
      }
      const total = (Number(row.transcript_chars) || 0) + chars;
      this.db.prepare(`UPDATE conversation_threads SET transcript_chars=?,
        updated_at=? WHERE chat_key=? AND thread_id=?`)
        .run(total, Date.now(), chatKey, threadId);
      return { added: messages.length, chars: total };
    });
  }

  getThreadTurns(threadId) {
    const rows = this.db.prepare(`SELECT message_json FROM thread_turns
      WHERE thread_id=? ORDER BY sequence`).all(threadId);
    const messages = [];
    for (const row of rows) {
      try {
        const message = JSON.parse(row.message_json);
        if (['user', 'assistant', 'tool'].includes(message?.role)) messages.push(message);
      } catch { /* skip corrupt turn */ }
    }
    return messages;
  }

  commitLifecycleRun({
    chatKey,
    leaseId = '',
    runId = '',
    persistThread = true,
    closeReason = '',
    threadOptions = {},
    checkpointState = {},
    sourceMessageIds = [],
    messages = [],
    maxTranscriptChars = 240000,
    forceRollover = '',
    rolloverArmedMs = 600000
  } = {}) {
    return this.#transaction(() => {
      const acknowledged = leaseId
        ? this.ackLease(leaseId)
        : this.completeRun(runId);
      if (closeReason) {
        this.closeConversationThread(chatKey, closeReason);
        return { acknowledged, thread: null, checkpoint: null, transcriptChars: 0 };
      }
      if (!persistThread) {
        return { acknowledged, thread: this.getConversationThread(chatKey), checkpoint: null, transcriptChars: 0 };
      }

      let thread = this.updateLifecycleThread(chatKey, threadOptions);
      if (!thread) return { acknowledged, thread: null, checkpoint: null, transcriptChars: 0 };
      const checkpoint = this.appendThreadCheckpoint(
        chatKey,
        thread.threadId,
        runId,
        checkpointState,
        sourceMessageIds
      );
      let transcriptChars = thread.transcriptChars;
      if (messages.length) {
        transcriptChars = this.appendThreadTurns(
          chatKey,
          thread.threadId,
          runId,
          messages
        ).chars;
      }
      const maxChars = Math.min(1000000, Math.max(20000, Number(maxTranscriptChars) || 240000));
      if (forceRollover || transcriptChars > maxChars) {
        this.armLifecycleRollover(
          chatKey,
          forceRollover || 'context-budget',
          rolloverArmedMs
        );
        thread = this.getConversationThread(chatKey);
        transcriptChars = 0;
      }
      return { acknowledged, thread, checkpoint, transcriptChars };
    });
  }

  appendThreadCheckpoint(chatKey, threadId, runId, state, sourceMessageIds = []) {
    const thread = this.db.prepare(`SELECT version FROM conversation_threads
      WHERE chat_key=? AND thread_id=? AND state!='closed'`).get(chatKey, threadId);
    if (!thread) return null;
    const createdAt = Date.now();
    const result = this.db.prepare(`INSERT INTO thread_checkpoints
      (thread_id,chat_key,run_id,version,state_json,source_message_ids,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(
        threadId, chatKey, runId || null, Number(thread.version) || 1,
        JSON.stringify(state || {}),
        JSON.stringify((sourceMessageIds || []).map(Number).filter(Number.isFinite)),
        createdAt
      );
    this.db.prepare(`DELETE FROM thread_checkpoints WHERE chat_key=? AND id NOT IN (
      SELECT id FROM thread_checkpoints WHERE chat_key=? ORDER BY id DESC LIMIT 200
    )`).run(chatKey, chatKey);
    return {
      id: Number(result.lastInsertRowid),
      threadId,
      chatKey,
      runId: runId || null,
      version: Number(thread.version) || 1,
      state: structuredClone(state || {}),
      sourceMessageIds: (sourceMessageIds || []).map(Number).filter(Number.isFinite),
      createdAt
    };
  }

  latestThreadCheckpoint(chatKey) {
    const row = this.db.prepare(`SELECT * FROM thread_checkpoints
      WHERE chat_key=? ORDER BY id DESC LIMIT 1`).get(chatKey);
    if (!row) return null;
    let state = {};
    let sourceMessageIds = [];
    try { state = JSON.parse(row.state_json || '{}'); } catch { /* keep empty */ }
    try { sourceMessageIds = JSON.parse(row.source_message_ids || '[]'); } catch { /* keep empty */ }
    return {
      id: Number(row.id),
      threadId: row.thread_id,
      chatKey: row.chat_key,
      runId: row.run_id,
      version: Number(row.version) || 1,
      state,
      sourceMessageIds,
      createdAt: Number(row.created_at) || 0
    };
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

  /** 实验身份库启用时才调用：为跨会话 QQ 查询创建索引。 */
  ensureIdentityLookupIndex() {
    this.db.exec(`CREATE INDEX IF NOT EXISTS messages_sender_time
      ON messages(sender_id, ts DESC) WHERE self=0`);
  }

  /**
   * 返回按 QQ / 会话 / 昵称聚合的只读活动快照。
   * 不在构造阶段自动执行，确保实验开关关闭时数据库结构和查询成本均不变化。
   */
  identityActivityRows() {
    return this.db.prepare(`
      SELECT sender_id AS userId, chat_key AS chatKey, sender_name AS name,
        COUNT(*) AS messageCount, MIN(ts) AS firstSeenAt, MAX(ts) AS lastSeenAt
      FROM messages
      WHERE self=0 AND sender_id!=''
      GROUP BY sender_id, chat_key, sender_name
      ORDER BY lastSeenAt DESC
    `).all().map((row) => ({
      userId: String(row.userId || ''),
      chatKey: String(row.chatKey || ''),
      name: String(row.name || ''),
      messageCount: Number(row.messageCount) || 0,
      firstSeenAt: Number(row.firstSeenAt) || 0,
      lastSeenAt: Number(row.lastSeenAt) || 0
    }));
  }
}
