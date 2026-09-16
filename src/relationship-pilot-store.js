import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';

export const RELATIONSHIP_EVALUATOR_VERSION = 'relationship-evaluator-v1';
export const RELATIONSHIP_REDUCER_VERSION = 'relationship-reducer-v1';
export const RELATIONSHIP_POLICY_VERSION = 'relationship-policy-v1';

const EVENT_TYPES = new Set([
  'warm_exchange',
  'trust_signal',
  'reciprocal_interest',
  'conflict',
  'boundary_cross',
  'repair'
]);

const AFFINITY_BASE = {
  warm_exchange: 0.045,
  trust_signal: 0.055,
  reciprocal_interest: 0.04,
  conflict: -0.05,
  boundary_cross: -0.08,
  repair: 0.03
};

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value) || 0));
const clean = (value, max = 240) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const jsonArray = (value) => {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export function relationshipDatabasePath(dataDir = DATA_DIR) {
  return path.join(dataDir, 'relationship-pilot.sqlite');
}

export function decayFriction(value, updatedAt, now = Date.now(), halfLifeHours = 48) {
  const friction = clamp(value);
  const at = Number(updatedAt) || Number(now) || Date.now();
  const elapsed = Math.max(0, Number(now) - at);
  if (!elapsed || friction <= 0) return friction;
  const halfLifeMs = Math.max(1, Number(halfLifeHours) || 48) * 3600000;
  return clamp(friction * Math.pow(0.5, elapsed / halfLifeMs));
}

export function familiarityFromStats({
  messageCount = 0,
  activeDays = 0,
  directInteractions = 0,
  chatCount = 0
} = {}) {
  const sat = (value, scale) => 1 - Math.exp(-Math.max(0, Number(value) || 0) / scale);
  return clamp(
    0.35 * sat(messageCount, 80)
    + 0.25 * sat(activeDays, 12)
    + 0.30 * sat(directInteractions, 20)
    + 0.10 * sat(chatCount, 3)
  );
}

export function compileRelationshipPolicy(state = {}, {
  now = Date.now(),
  halfLifeHours = 48
} = {}) {
  const familiarity = clamp(state.familiarity);
  const affinity = clamp(state.affinity, -1, 1);
  const friction = decayFriction(state.friction, state.frictionUpdatedAt, now, halfLifeHours);
  const policy = {
    shared_context_use: familiarity >= 0.55 ? 1 : familiarity <= 0.12 ? -1 : 0,
    banter_permission: friction >= 0.5 || affinity <= -0.25 ? -1 : affinity >= 0.3 && friction < 0.3 ? 1 : 0,
    directness: friction >= 0.55 ? -1 : familiarity >= 0.6 ? 1 : 0,
    followup_initiative: friction >= 0.45 || affinity <= -0.2 ? -1 : affinity >= 0.35 && friction < 0.3 ? 1 : 0,
    formality: familiarity >= 0.6 ? -1 : familiarity <= 0.12 ? 1 : 0,
    proactive_priority: affinity >= 0.45 && familiarity >= 0.55 && friction < 0.25 ? 1 : 0
  };
  return { familiarity, affinity, friction, policy };
}

function stateView(row, options = {}) {
  if (!row) return null;
  const compiled = compileRelationshipPolicy({
    familiarity: row.familiarity,
    affinity: row.affinity,
    friction: row.friction,
    frictionUpdatedAt: row.friction_updated_at
  }, options);
  return {
    userId: String(row.uin),
    familiarity: compiled.familiarity,
    affinity: compiled.affinity,
    friction: compiled.friction,
    policy: compiled.policy,
    messageCount: Number(row.message_count) || 0,
    activeDays: Number(row.active_days) || 0,
    directInteractions: Number(row.direct_interactions) || 0,
    chatCount: Number(row.chat_count) || 0,
    lastInteractionAt: Number(row.last_interaction_at) || 0,
    lastEvaluatedAt: Number(row.last_evaluated_at) || 0,
    evaluatorVersion: String(row.evaluator_version || RELATIONSHIP_EVALUATOR_VERSION),
    reducerVersion: String(row.reducer_version || RELATIONSHIP_REDUCER_VERSION),
    policyVersion: String(row.policy_version || RELATIONSHIP_POLICY_VERSION),
    updatedAt: Number(row.updated_at) || 0
  };
}

function eventView(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.uin),
    type: String(row.event_type),
    polarity: Number(row.polarity) || 0,
    strength: Number(row.strength) || 0,
    confidence: Number(row.confidence) || 0,
    summary: String(row.summary || ''),
    evidenceIds: jsonArray(row.evidence_ids).map(String),
    sourceChatKeys: jsonArray(row.source_chat_keys).map(String),
    dedupeKey: String(row.dedupe_key || ''),
    evaluatorVersion: String(row.evaluator_version || ''),
    deltaAffinity: Number(row.delta_affinity) || 0,
    deltaFriction: Number(row.delta_friction) || 0,
    createdAt: Number(row.created_at) || 0,
    appliedAt: Number(row.applied_at) || 0
  };
}

function eventDedupeKey(uin, event) {
  const evidence = [...new Set((event.evidenceIds || []).map(String))].sort();
  return crypto.createHash('sha256')
    .update(String(uin))
    .update('\0')
    .update(String(event.type))
    .update('\0')
    .update(evidence.join('|'))
    .digest('hex');
}

function affinityDelta(current, type, strength, confidence) {
  const base = Number(AFFINITY_BASE[type]) || 0;
  const raw = base * clamp(strength) * clamp(confidence);
  if (raw >= 0) return raw * (1 - clamp(current, -1, 1));
  return raw * (1 + clamp(current, -1, 1));
}

function frictionAfterEvent(current, type, strength, confidence) {
  const pressure = clamp(strength) * clamp(confidence);
  if (type === 'conflict') return clamp(current + 0.30 * pressure * (1 - current));
  if (type === 'boundary_cross') return clamp(current + 0.50 * pressure * (1 - current));
  if (type === 'repair') return clamp(current * (1 - 0.75 * pressure));
  return current;
}

export class RelationshipPilotStore {
  constructor({ dataDir = DATA_DIR, filename = relationshipDatabasePath(dataDir) } = {}) {
    this.filename = filename;
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    try { fs.chmodSync(filename, 0o600); } catch { /* best effort */ }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS relationship_states (
        uin TEXT PRIMARY KEY,
        familiarity REAL NOT NULL DEFAULT 0,
        affinity REAL NOT NULL DEFAULT 0,
        friction REAL NOT NULL DEFAULT 0,
        friction_updated_at INTEGER NOT NULL DEFAULT 0,
        message_count INTEGER NOT NULL DEFAULT 0,
        active_days INTEGER NOT NULL DEFAULT 0,
        direct_interactions INTEGER NOT NULL DEFAULT 0,
        chat_count INTEGER NOT NULL DEFAULT 0,
        last_interaction_at INTEGER NOT NULL DEFAULT 0,
        last_evaluated_at INTEGER NOT NULL DEFAULT 0,
        evaluator_version TEXT NOT NULL DEFAULT '',
        reducer_version TEXT NOT NULL DEFAULT '',
        policy_version TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relationship_events (
        id TEXT PRIMARY KEY,
        uin TEXT NOT NULL,
        event_type TEXT NOT NULL,
        polarity INTEGER NOT NULL,
        strength REAL NOT NULL,
        confidence REAL NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        evidence_ids TEXT NOT NULL DEFAULT '[]',
        source_chat_keys TEXT NOT NULL DEFAULT '[]',
        dedupe_key TEXT NOT NULL UNIQUE,
        evaluator_version TEXT NOT NULL,
        delta_affinity REAL NOT NULL DEFAULT 0,
        delta_friction REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        applied_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS relationship_events_person
        ON relationship_events(uin, applied_at DESC);
      CREATE TABLE IF NOT EXISTS relationship_cursors (
        uin TEXT NOT NULL,
        chat_key TEXT NOT NULL,
        last_message_id INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (uin, chat_key)
      );
      CREATE TABLE IF NOT EXISTS relationship_flags (
        id TEXT PRIMARY KEY,
        uin TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        source_event_id TEXT NOT NULL DEFAULT '',
        resolved_by_event_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        resolved_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS relationship_flags_person
        ON relationship_flags(uin, status, created_at DESC);
      CREATE TABLE IF NOT EXISTS relationship_evaluations (
        id TEXT PRIMARY KEY,
        uin TEXT NOT NULL,
        status TEXT NOT NULL,
        evidence_count INTEGER NOT NULL DEFAULT 0,
        source_chat_keys TEXT NOT NULL DEFAULT '[]',
        model TEXT NOT NULL DEFAULT '',
        usage_json TEXT NOT NULL DEFAULT '{}',
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS relationship_evaluations_person
        ON relationship_evaluations(uin, created_at DESC);
    `);
  }

  close() {
    this.db.close();
  }

  counts() {
    const states = Number(this.db.prepare('SELECT COUNT(*) AS n FROM relationship_states').get()?.n) || 0;
    const events = Number(this.db.prepare('SELECT COUNT(*) AS n FROM relationship_events').get()?.n) || 0;
    const openFlags = Number(this.db.prepare("SELECT COUNT(*) AS n FROM relationship_flags WHERE status='open'").get()?.n) || 0;
    return { states, events, openFlags };
  }

  ensureState(uin, now = Date.now()) {
    const id = String(uin || '').trim();
    if (!/^\d{1,15}$/.test(id)) throw new Error('relationship uin 必须是数字 QQ 号');
    this.db.prepare(`INSERT OR IGNORE INTO relationship_states
      (uin,evaluator_version,reducer_version,policy_version,created_at,updated_at,friction_updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(
      id,
      RELATIONSHIP_EVALUATOR_VERSION,
      RELATIONSHIP_REDUCER_VERSION,
      RELATIONSHIP_POLICY_VERSION,
      now,
      now,
      now
    );
    return this.db.prepare('SELECT * FROM relationship_states WHERE uin=?').get(id);
  }

  refreshFamiliarity(uin, stats = {}, now = Date.now()) {
    const row = this.ensureState(uin, now);
    const normalized = {
      messageCount: Math.max(0, Number(stats.messageCount) || 0),
      activeDays: Math.max(0, Number(stats.activeDays) || 0),
      directInteractions: Math.max(0, Number(stats.directInteractions) || 0),
      chatCount: Math.max(0, Number(stats.chatCount) || 0),
      lastInteractionAt: Math.max(0, Number(stats.lastInteractionAt) || 0)
    };
    const familiarity = familiarityFromStats(normalized);
    this.db.prepare(`UPDATE relationship_states SET
      familiarity=?,message_count=?,active_days=?,direct_interactions=?,chat_count=?,
      last_interaction_at=?,updated_at=? WHERE uin=?`).run(
      familiarity,
      normalized.messageCount,
      normalized.activeDays,
      normalized.directInteractions,
      normalized.chatCount,
      normalized.lastInteractionAt,
      now,
      String(uin)
    );
    return this.getState(uin, { now });
  }

  getState(uin, { now = Date.now(), halfLifeHours = 48 } = {}) {
    const row = this.db.prepare('SELECT * FROM relationship_states WHERE uin=?').get(String(uin || ''));
    return stateView(row, { now, halfLifeHours });
  }

  listStates(limit = 200, options = {}) {
    return this.db.prepare('SELECT * FROM relationship_states ORDER BY updated_at DESC LIMIT ?')
      .all(Math.min(1000, Math.max(1, Number(limit) || 200)))
      .map((row) => stateView(row, options));
  }

  cursors(uin) {
    return Object.fromEntries(this.db.prepare(`SELECT chat_key,last_message_id FROM relationship_cursors
      WHERE uin=?`).all(String(uin || '')).map((row) => [String(row.chat_key), Number(row.last_message_id) || 0]));
  }

  openFlags(uin) {
    return this.db.prepare(`SELECT * FROM relationship_flags WHERE uin=? AND status='open'
      ORDER BY created_at DESC`).all(String(uin || '')).map((row) => ({
      id: String(row.id), type: String(row.type), sourceEventId: String(row.source_event_id || ''),
      createdAt: Number(row.created_at) || 0
    }));
  }

  recentEvents(uin, limit = 20) {
    return this.db.prepare(`SELECT * FROM relationship_events WHERE uin=?
      ORDER BY applied_at DESC LIMIT ?`).all(
      String(uin || ''), Math.min(100, Math.max(1, Number(limit) || 20))
    ).map(eventView);
  }

  beginEvaluation(uin, { evidenceCount = 0, sourceChatKeys = [], model = '' } = {}) {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.ensureState(uin, now);
    this.db.prepare(`INSERT INTO relationship_evaluations
      (id,uin,status,evidence_count,source_chat_keys,model,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(
      id,
      String(uin),
      'running',
      Math.max(0, Number(evidenceCount) || 0),
      JSON.stringify([...new Set((sourceChatKeys || []).map(String))]),
      String(model || ''),
      now
    );
    return id;
  }

  finishEvaluation(id, { status = 'done', usage = {}, error = '' } = {}) {
    this.db.prepare(`UPDATE relationship_evaluations SET status=?,usage_json=?,error=?,completed_at=?
      WHERE id=?`).run(
      String(status || 'done'), JSON.stringify(usage || {}), clean(error, 1000), Date.now(), String(id)
    );
  }

  applyEvaluation(uin, events = [], {
    cursorUpdates = {},
    now = Date.now(),
    halfLifeHours = 48,
    evaluatorVersion = RELATIONSHIP_EVALUATOR_VERSION
  } = {}) {
    const id = String(uin || '').trim();
    const applied = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      let row = this.ensureState(id, now);
      let affinity = clamp(row.affinity, -1, 1);
      let friction = decayFriction(row.friction, row.friction_updated_at, now, halfLifeHours);
      const insert = this.db.prepare(`INSERT OR IGNORE INTO relationship_events
        (id,uin,event_type,polarity,strength,confidence,summary,evidence_ids,source_chat_keys,
         dedupe_key,evaluator_version,delta_affinity,delta_friction,created_at,applied_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

      for (const raw of Array.isArray(events) ? events : []) {
        const type = String(raw?.type || '');
        if (!EVENT_TYPES.has(type)) continue;
        const strength = clamp(raw?.strength);
        const confidence = clamp(raw?.confidence);
        if (strength <= 0 || confidence < 0.5) continue;
        const evidenceIds = [...new Set((raw?.evidenceIds || []).map(String).filter(Boolean))].slice(0, 8);
        if (!evidenceIds.length) continue;
        const sourceChatKeys = [...new Set((raw?.sourceChatKeys || []).map(String).filter((key) => /^(group|private):\d+$/.test(key)))];
        const dedupeKey = eventDedupeKey(id, { type, evidenceIds });
        const eventId = crypto.randomUUID();
        const beforeAffinity = affinity;
        const beforeFriction = friction;
        const deltaAffinity = affinityDelta(affinity, type, strength, confidence);
        affinity = clamp(affinity + deltaAffinity, -1, 1);
        friction = frictionAfterEvent(friction, type, strength, confidence);
        const deltaFriction = friction - beforeFriction;
        const polarity = Math.sign(Number(AFFINITY_BASE[type]) || 0);
        const result = insert.run(
          eventId, id, type, polarity, strength, confidence, clean(raw?.summary, 240),
          JSON.stringify(evidenceIds), JSON.stringify(sourceChatKeys), dedupeKey,
          String(evaluatorVersion || RELATIONSHIP_EVALUATOR_VERSION),
          affinity - beforeAffinity, deltaFriction, now, now
        );
        if (!result.changes) {
          affinity = beforeAffinity;
          friction = beforeFriction;
          continue;
        }
        applied.push(eventId);
        if (type === 'boundary_cross') {
          this.db.prepare(`INSERT INTO relationship_flags
            (id,uin,type,status,source_event_id,created_at) VALUES (?,?,?,'open',?,?)`)
            .run(crypto.randomUUID(), id, 'boundary_violation', eventId, now);
        }
        if (type === 'repair' && strength * confidence >= 0.45) {
          const flag = this.db.prepare(`SELECT id FROM relationship_flags
            WHERE uin=? AND type='boundary_violation' AND status='open'
            ORDER BY created_at LIMIT 1`).get(id);
          if (flag) {
            this.db.prepare(`UPDATE relationship_flags SET status='resolved',resolved_by_event_id=?,resolved_at=?
              WHERE id=?`).run(eventId, now, flag.id);
          }
        }
      }

      this.db.prepare(`UPDATE relationship_states SET affinity=?,friction=?,friction_updated_at=?,
        last_evaluated_at=?,evaluator_version=?,reducer_version=?,policy_version=?,updated_at=?
        WHERE uin=?`).run(
        affinity, friction, now, now,
        String(evaluatorVersion || RELATIONSHIP_EVALUATOR_VERSION),
        RELATIONSHIP_REDUCER_VERSION,
        RELATIONSHIP_POLICY_VERSION,
        now,
        id
      );
      const cursor = this.db.prepare(`INSERT INTO relationship_cursors
        (uin,chat_key,last_message_id,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(uin,chat_key) DO UPDATE SET
          last_message_id=MAX(relationship_cursors.last_message_id,excluded.last_message_id),
          updated_at=excluded.updated_at`);
      for (const [chatKey, lastMessageId] of Object.entries(cursorUpdates || {})) {
        if (!/^(group|private):\d+$/.test(chatKey)) continue;
        cursor.run(id, chatKey, Math.max(0, Number(lastMessageId) || 0), now);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      state: this.getState(id, { now, halfLifeHours }),
      appliedEvents: applied,
      openFlags: this.openFlags(id)
    };
  }

  replay(uin, { now = Date.now(), halfLifeHours = 48 } = {}) {
    const id = String(uin || '').trim();
    const existing = this.ensureState(id, now);
    let affinity = 0;
    let friction = 0;
    let frictionAt = Number(existing.created_at) || now;
    const rows = this.db.prepare(`SELECT * FROM relationship_events WHERE uin=?
      ORDER BY applied_at,id`).all(id);
    for (const row of rows) {
      const at = Number(row.applied_at) || now;
      friction = decayFriction(friction, frictionAt, at, halfLifeHours);
      affinity = clamp(affinity + affinityDelta(affinity, row.event_type, row.strength, row.confidence), -1, 1);
      friction = frictionAfterEvent(friction, row.event_type, row.strength, row.confidence);
      frictionAt = at;
    }
    this.db.prepare(`UPDATE relationship_states SET affinity=?,friction=?,friction_updated_at=?,
      reducer_version=?,policy_version=?,updated_at=? WHERE uin=?`).run(
      affinity, friction, frictionAt,
      RELATIONSHIP_REDUCER_VERSION, RELATIONSHIP_POLICY_VERSION, now, id
    );
    return this.getState(id, { now, halfLifeHours });
  }
}
