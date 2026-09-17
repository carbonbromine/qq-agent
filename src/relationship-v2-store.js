import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';

export const RELATIONSHIP_V2_EVALUATOR_VERSION = 'relationship-v2-evaluator-1';
export const RELATIONSHIP_V2_REDUCER_VERSION = 'relationship-v2-reducer-1';
export const RELATIONSHIP_V2_POLICY_VERSION = 'relationship-v2-policy-1';

const EVENT_TYPES = new Set([
  'pleasant_moment', 'reciprocal_interest', 'reliable_followthrough',
  'boundary_respect', 'conflict', 'boundary_cross', 'repair'
]);
const POSITIVE_DURABLE_TYPES = new Set([
  'reciprocal_interest', 'reliable_followthrough', 'boundary_respect'
]);
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value) || 0));
const clean = (value, max = 240) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const parseJson = (value, fallback) => {
  try { return JSON.parse(String(value ?? '')); } catch { return fallback; }
};
const decay = (value, updatedAt, now, halfLifeMs) => {
  const elapsed = Math.max(0, Number(now) - (Number(updatedAt) || Number(now)));
  return clamp(value) * Math.pow(0.5, elapsed / Math.max(1, halfLifeMs));
};
const saturatingRise = (current, impact) => 1 - (1 - clamp(current)) * (1 - clamp(impact));

export function relationshipV2DatabasePath(dataDir = DATA_DIR) {
  return path.join(dataDir, 'relationship-v2.sqlite');
}

export function decayRelationshipState(row = {}, settings = {}, now = Date.now()) {
  const warmth = decay(
    row.recent_warmth,
    row.warmth_updated_at,
    now,
    Math.max(1, Number(settings.warmthHalfLifeHours) || 12) * 3600000
  );
  const tension = decay(
    row.recent_tension,
    row.tension_updated_at,
    now,
    Math.max(1, Number(settings.tensionHalfLifeHours) || 48) * 3600000
  );
  const familiarityMass = decay(
    row.familiarity_mass,
    row.familiarity_updated_at,
    now,
    Math.max(1, Number(settings.familiarityHalfLifeDays) || 60) * 86400000
  );
  const familiarity = clamp(1 - Math.exp(-familiarityMass / 12));
  const lastInteractionAt = Number(row.last_interaction_at) || 0;
  const graceMs = Math.max(0, Number(settings.bondGraceDays) || 30) * 86400000;
  const inactiveMs = lastInteractionAt ? Math.max(0, now - lastInteractionAt - graceMs) : 0;
  const bondConfidence = lastInteractionAt
    ? Math.pow(0.5, inactiveMs / (Math.max(30, Number(settings.bondHalfLifeDays) || 180) * 86400000))
    : 0;
  return { warmth, tension, familiarityMass, familiarity, bondConfidence };
}

export function compileRelationshipV2Policy(state = {}) {
  const bondLevel = Math.max(-2, Math.min(3, Math.round(Number(state.bondLevel) || 0)));
  const effectiveBond = bondLevel * clamp(state.bondConfidence);
  const openBoundary = state.boundaryState === 'open';
  let mode = 'baseline';
  if (openBoundary) mode = 'boundary';
  else if (clamp(state.tension) >= 0.55) mode = 'deescalate';
  else if (effectiveBond >= 1.5) mode = 'trusted';
  else if (effectiveBond >= 0.5) mode = 'familiar-positive';
  else if (effectiveBond <= -0.5) mode = 'cool';
  const warmthStep = !openBoundary && clamp(state.tension) < 0.35 && clamp(state.warmth) >= 0.45 ? 1 : 0;
  return {
    mode,
    warmthStep,
    sharedContext: clamp(state.familiarity) >= 0.45,
    banterAllowed: !openBoundary && clamp(state.tension) < 0.4 && effectiveBond >= 0.5,
    followupAllowed: !openBoundary && clamp(state.tension) < 0.45 && effectiveBond >= 0
  };
}

function stateView(row, settings = {}, now = Date.now()) {
  if (!row) return null;
  const decayed = decayRelationshipState(row, settings, now);
  const state = {
    userId: String(row.uin),
    name: clean(row.display_name, 120),
    familiarity: decayed.familiarity,
    familiarityMass: decayed.familiarityMass,
    bondLevel: Number(row.bond_level) || 0,
    bondProgress: Number(row.bond_progress) || 0,
    bondConfidence: decayed.bondConfidence,
    recentWarmth: decayed.warmth,
    recentTension: decayed.tension,
    boundaryState: String(row.boundary_state || 'clear'),
    lastInteractionAt: Number(row.last_interaction_at) || 0,
    lastEvaluatedAt: Number(row.last_evaluated_at) || 0,
    lastBondChangeAt: Number(row.last_bond_change_at) || 0,
    updatedAt: Number(row.updated_at) || 0
  };
  state.policy = compileRelationshipV2Policy({
    ...state,
    warmth: state.recentWarmth,
    tension: state.recentTension
  });
  return state;
}

function eventView(row) {
  return {
    id: String(row.id),
    userId: String(row.uin),
    type: String(row.event_type),
    strength: Number(row.strength) || 0,
    confidence: Number(row.confidence) || 0,
    durableEligible: Boolean(row.durable_eligible),
    evidenceIds: parseJson(row.evidence_ids, []).map(String),
    sourceChatKeys: parseJson(row.source_chat_keys, []).map(String),
    personaBasisIds: parseJson(row.persona_basis_ids, []).map(String),
    summary: String(row.summary || ''),
    personaVersion: String(row.persona_version || ''),
    createdAt: Number(row.created_at) || 0
  };
}

function jobView(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    userId: String(row.uin),
    status: String(row.status),
    triggerKind: String(row.trigger_kind),
    fromTs: Number(row.from_ts) || 0,
    toTs: Number(row.to_ts) || 0,
    attempts: Number(row.attempts) || 0,
    evidenceCount: Number(row.evidence_count) || 0,
    eventCount: Number(row.event_count) || 0,
    personaVersion: String(row.persona_version || ''),
    model: String(row.model || ''),
    usage: parseJson(row.usage_json, {}),
    error: String(row.error || ''),
    createdAt: Number(row.created_at) || 0,
    startedAt: Number(row.started_at) || 0,
    completedAt: Number(row.completed_at) || 0
  };
}

export class RelationshipV2Store {
  constructor({ dataDir = DATA_DIR, filename = relationshipV2DatabasePath(dataDir) } = {}) {
    this.filename = filename;
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    try { fs.chmodSync(filename, 0o600); } catch { /* best effort */ }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS relationship_v2_states (
        uin TEXT PRIMARY KEY,
        display_name TEXT NOT NULL DEFAULT '',
        familiarity_mass REAL NOT NULL DEFAULT 0,
        familiarity_updated_at INTEGER NOT NULL DEFAULT 0,
        bond_level INTEGER NOT NULL DEFAULT 0,
        bond_progress REAL NOT NULL DEFAULT 0,
        recent_warmth REAL NOT NULL DEFAULT 0,
        warmth_updated_at INTEGER NOT NULL DEFAULT 0,
        recent_tension REAL NOT NULL DEFAULT 0,
        tension_updated_at INTEGER NOT NULL DEFAULT 0,
        boundary_state TEXT NOT NULL DEFAULT 'clear',
        last_interaction_at INTEGER NOT NULL DEFAULT 0,
        last_evaluated_at INTEGER NOT NULL DEFAULT 0,
        last_bond_change_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relationship_v2_events (
        id TEXT PRIMARY KEY,
        uin TEXT NOT NULL,
        event_type TEXT NOT NULL,
        strength REAL NOT NULL,
        confidence REAL NOT NULL,
        durable_eligible INTEGER NOT NULL DEFAULT 0,
        evidence_ids TEXT NOT NULL DEFAULT '[]',
        source_chat_keys TEXT NOT NULL DEFAULT '[]',
        persona_basis_ids TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '',
        persona_version TEXT NOT NULL DEFAULT '',
        evaluator_version TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE,
        consumed_for_bond INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS relationship_v2_events_person
        ON relationship_v2_events(uin,created_at DESC);
      CREATE TABLE IF NOT EXISTS relationship_v2_jobs (
        id TEXT PRIMARY KEY,
        uin TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger_kind TEXT NOT NULL,
        from_ts INTEGER NOT NULL,
        to_ts INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        persona_version TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        attempts INTEGER NOT NULL DEFAULT 0,
        evidence_count INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0,
        usage_json TEXT NOT NULL DEFAULT '{}',
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        started_at INTEGER NOT NULL DEFAULT 0,
        completed_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS relationship_v2_jobs_queue
        ON relationship_v2_jobs(status,created_at);
      CREATE TABLE IF NOT EXISTS relationship_v2_pending (
        uin TEXT PRIMARY KEY,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        direct_count INTEGER NOT NULL DEFAULT 0,
        chat_keys TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );
    `);
    const stateColumns = this.db.prepare('PRAGMA table_info(relationship_v2_states)').all();
    if (!stateColumns.some((column) => column.name === 'display_name')) {
      this.db.exec("ALTER TABLE relationship_v2_states ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
    }
  }

  close() { this.db.close(); }

  counts() {
    return {
      states: Number(this.db.prepare('SELECT COUNT(*) n FROM relationship_v2_states').get()?.n) || 0,
      events: Number(this.db.prepare('SELECT COUNT(*) n FROM relationship_v2_events').get()?.n) || 0,
      queuedJobs: Number(this.db.prepare("SELECT COUNT(*) n FROM relationship_v2_jobs WHERE status='queued'").get()?.n) || 0,
      failedJobs: Number(this.db.prepare("SELECT COUNT(*) n FROM relationship_v2_jobs WHERE status='failed_reviewable'").get()?.n) || 0
    };
  }

  ensureState(uin, now = Date.now()) {
    const id = String(uin || '').trim();
    if (!/^\d{1,15}$/.test(id)) throw new Error('关系对象必须是数字 QQ 号');
    this.db.prepare(`INSERT OR IGNORE INTO relationship_v2_states
      (uin,familiarity_updated_at,warmth_updated_at,tension_updated_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?)`).run(id, now, now, now, now, now);
    return this.db.prepare('SELECT * FROM relationship_v2_states WHERE uin=?').get(id);
  }

  recordDirectInteraction(uin, chatKey, at = Date.now(), settings = {}, displayName = '') {
    const id = String(uin || '').trim();
    const now = Number(at) || Date.now();
    const row = this.ensureState(id, now);
    const current = decayRelationshipState(row, settings, now);
    const mass = Math.min(200, current.familiarityMass + 1);
    const name = clean(displayName, 120);
    this.db.prepare(`UPDATE relationship_v2_states SET display_name=CASE WHEN ?<>'' THEN ? ELSE display_name END,
      familiarity_mass=?,familiarity_updated_at=?,last_interaction_at=MAX(last_interaction_at,?),updated_at=? WHERE uin=?`)
      .run(name, name, mass, now, now, now, id);
    const pending = this.db.prepare('SELECT * FROM relationship_v2_pending WHERE uin=?').get(id);
    const chats = new Set(parseJson(pending?.chat_keys, []).map(String));
    if (/^(group|private):\d+$/.test(String(chatKey || ''))) chats.add(String(chatKey));
    this.db.prepare(`INSERT INTO relationship_v2_pending
      (uin,first_at,last_at,direct_count,chat_keys,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(uin) DO UPDATE SET last_at=excluded.last_at,
        direct_count=relationship_v2_pending.direct_count+1,
        chat_keys=excluded.chat_keys,updated_at=excluded.updated_at`).run(
      id, pending ? Number(pending.first_at) : now, now, 1, JSON.stringify([...chats]), now
    );
    return this.pending(id);
  }

  pending(uin) {
    const row = this.db.prepare('SELECT * FROM relationship_v2_pending WHERE uin=?').get(String(uin));
    return row ? {
      userId: String(row.uin), firstAt: Number(row.first_at), lastAt: Number(row.last_at),
      directCount: Number(row.direct_count), chatKeys: parseJson(row.chat_keys, []).map(String)
    } : null;
  }

  clearPending(uin) {
    this.db.prepare('DELETE FROM relationship_v2_pending WHERE uin=?').run(String(uin));
  }

  getState(uin, settings = {}, now = Date.now()) {
    return stateView(
      this.db.prepare('SELECT * FROM relationship_v2_states WHERE uin=?').get(String(uin || '')),
      settings,
      now
    );
  }

  listStates(limit = 100, settings = {}, now = Date.now()) {
    return this.db.prepare('SELECT * FROM relationship_v2_states ORDER BY updated_at DESC LIMIT ?')
      .all(Math.min(500, Math.max(1, Number(limit) || 100)))
      .map((row) => stateView(row, settings, now));
  }

  recentEvents({ uin = '', limit = 100 } = {}) {
    const rows = uin
      ? this.db.prepare('SELECT * FROM relationship_v2_events WHERE uin=? ORDER BY created_at DESC LIMIT ?')
        .all(String(uin), Math.min(500, Math.max(1, Number(limit) || 100)))
      : this.db.prepare('SELECT * FROM relationship_v2_events ORDER BY created_at DESC LIMIT ?')
        .all(Math.min(500, Math.max(1, Number(limit) || 100)));
    return rows.map(eventView);
  }

  enqueueJob({ uin, triggerKind = 'manual', fromTs, toTs, personaVersion = '', model = '' }) {
    const id = String(uin || '').trim();
    this.ensureState(id);
    const from = Math.max(0, Number(fromTs) || 0);
    const to = Math.max(from, Number(toTs) || Date.now());
    const key = crypto.createHash('sha256')
      .update([id, triggerKind, from, to, personaVersion].join('\0')).digest('hex');
    const existing = this.db.prepare('SELECT * FROM relationship_v2_jobs WHERE idempotency_key=?').get(key);
    if (existing) return { ...jobView(existing), duplicate: true };
    const jobId = `rv2_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const now = Date.now();
    this.db.prepare(`INSERT INTO relationship_v2_jobs
      (id,uin,status,trigger_kind,from_ts,to_ts,idempotency_key,persona_version,model,created_at)
      VALUES (?,?,'queued',?,?,?,?,?,?,?)`).run(
      jobId, id, String(triggerKind), from, to, key, String(personaVersion), String(model), now
    );
    return jobView(this.db.prepare('SELECT * FROM relationship_v2_jobs WHERE id=?').get(jobId));
  }

  recoverInterruptedJobs() {
    return this.db.prepare(`UPDATE relationship_v2_jobs SET status='queued',started_at=0,
      error='进程重启前任务未完成，已安全重新排队' WHERE status='running'`).run().changes;
  }

  requeueJob(id, reason = '任务已安全重新排队') {
    return this.db.prepare(`UPDATE relationship_v2_jobs SET status='queued',started_at=0,
      error=? WHERE id=? AND status='running'`).run(clean(reason, 1000), String(id)).changes;
  }

  claimNextJob() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`SELECT * FROM relationship_v2_jobs WHERE status='queued'
        ORDER BY CASE trigger_kind WHEN 'manual' THEN 0 ELSE 1 END,created_at LIMIT 1`).get();
      if (!row) { this.db.exec('COMMIT'); return null; }
      const result = this.db.prepare(`UPDATE relationship_v2_jobs SET status='running',
        attempts=attempts+1,started_at=? WHERE id=? AND status='queued'`).run(Date.now(), row.id);
      this.db.exec('COMMIT');
      return result.changes
        ? jobView(this.db.prepare('SELECT * FROM relationship_v2_jobs WHERE id=?').get(row.id))
        : null;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  finishJob(id, { evidenceCount = 0, eventCount = 0, usage = {} } = {}) {
    this.db.prepare(`UPDATE relationship_v2_jobs SET status='done',evidence_count=?,event_count=?,
      usage_json=?,error='',completed_at=? WHERE id=?`).run(
      Math.max(0, Number(evidenceCount) || 0), Math.max(0, Number(eventCount) || 0),
      JSON.stringify(usage || {}), Date.now(), String(id)
    );
  }

  failJob(id, error) {
    this.db.prepare(`UPDATE relationship_v2_jobs SET status='failed_reviewable',error=?,completed_at=?
      WHERE id=?`).run(clean(error, 1000), Date.now(), String(id));
  }

  listJobs({ status = '', limit = 100 } = {}) {
    const max = Math.min(500, Math.max(1, Number(limit) || 100));
    const rows = status
      ? this.db.prepare('SELECT * FROM relationship_v2_jobs WHERE status=? ORDER BY created_at DESC LIMIT ?').all(String(status), max)
      : this.db.prepare('SELECT * FROM relationship_v2_jobs ORDER BY created_at DESC LIMIT ?').all(max);
    return rows.map(jobView);
  }

  hasActiveJob(uin) {
    return Boolean(this.db.prepare(`SELECT 1 FROM relationship_v2_jobs
      WHERE uin=? AND status IN ('queued','running') LIMIT 1`).get(String(uin || '')));
  }

  evaluationsSince(since) {
    return Number(this.db.prepare(`SELECT COUNT(*) n FROM relationship_v2_jobs
      WHERE created_at>=? AND status IN ('queued','running','done','failed_reviewable')`).get(Number(since) || 0)?.n) || 0;
  }

  applyEvaluation(uin, events = [], { settings = {}, personaVersion = '', now = Date.now() } = {}) {
    const id = String(uin || '').trim();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.ensureState(id, now);
      const decayed = decayRelationshipState(row, settings, now);
      let warmth = decayed.warmth;
      let tension = decayed.tension;
      let bondLevel = Number(row.bond_level) || 0;
      let bondProgress = clamp(row.bond_progress);
      let boundaryState = String(row.boundary_state || 'clear');
      let adverseEvent = false;
      let severeBondLoss = false;
      let positiveDurableEvent = false;
      const applied = [];
      const insert = this.db.prepare(`INSERT OR IGNORE INTO relationship_v2_events
        (id,uin,event_type,strength,confidence,durable_eligible,evidence_ids,source_chat_keys,
         persona_basis_ids,summary,persona_version,evaluator_version,dedupe_key,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const raw of Array.isArray(events) ? events : []) {
        const type = String(raw?.type || '');
        if (!EVENT_TYPES.has(type)) continue;
        const strength = clamp(raw?.strength);
        const confidence = clamp(raw?.confidence);
        if (strength <= 0 || confidence < 0.55) continue;
        const evidenceIds = [...new Set((raw.evidenceIds || []).map(String).filter(Boolean))].slice(0, 8);
        if (!evidenceIds.length) continue;
        const sourceChatKeys = [...new Set((raw.sourceChatKeys || []).map(String)
          .filter((value) => /^(group|private):\d+$/.test(value)))];
        const basis = [...new Set((raw.personaBasisIds || []).map(String).filter(Boolean))].slice(0, 6);
        const dedupe = crypto.createHash('sha256')
          .update([id, type, ...evidenceIds.sort()].join('\0')).digest('hex');
        const eventId = crypto.randomUUID();
        const result = insert.run(
          eventId, id, type, strength, confidence,
          raw.durableEligible === true && POSITIVE_DURABLE_TYPES.has(type) ? 1 : 0,
          JSON.stringify(evidenceIds), JSON.stringify(sourceChatKeys), JSON.stringify(basis),
          clean(raw.summary, 240), String(personaVersion), RELATIONSHIP_V2_EVALUATOR_VERSION,
          dedupe, now
        );
        if (!result.changes) continue;
        applied.push(eventId);
        const impact = strength * confidence;
        if (raw.durableEligible === true && POSITIVE_DURABLE_TYPES.has(type)) {
          positiveDurableEvent = true;
        }
        if (['pleasant_moment', 'reciprocal_interest', 'reliable_followthrough', 'boundary_respect'].includes(type)) {
          warmth = saturatingRise(warmth, impact * 0.45);
          tension *= 1 - impact * 0.12;
        } else if (type === 'conflict') {
          adverseEvent = true;
          tension = saturatingRise(tension, impact * 0.65);
          warmth *= 1 - impact * 0.45;
          bondProgress = 0;
          if (impact >= 0.78) {
            bondLevel = Math.max(-2, bondLevel - 1);
            severeBondLoss = true;
          }
        } else if (type === 'boundary_cross') {
          adverseEvent = true;
          tension = saturatingRise(tension, impact * 0.9);
          warmth *= 1 - impact * 0.8;
          boundaryState = 'open';
          bondProgress = 0;
          if (impact >= 0.55) {
            bondLevel = Math.max(-2, bondLevel - 1);
            severeBondLoss = true;
          }
        } else if (type === 'repair') {
          tension *= 1 - impact * 0.8;
          if (impact >= 0.6) boundaryState = 'clear';
        }
      }

      // A real conflict invalidates any not-yet-solidified positive evidence. This prevents
      // an old pile of pleasant interactions from immediately cancelling a fresh rupture.
      if (adverseEvent) {
        this.db.prepare(`UPDATE relationship_v2_events SET consumed_for_bond=1
          WHERE uin=? AND durable_eligible=1 AND consumed_for_bond=0`).run(id);
      }
      const promotion = positiveDurableEvent && !adverseEvent && boundaryState !== 'open'
        ? this.#promoteIfEligible(id, bondLevel, now)
        : { bondLevel, progress: bondProgress, changed: false };
      bondLevel = promotion.bondLevel;
      this.db.prepare(`UPDATE relationship_v2_states SET familiarity_mass=?,familiarity_updated_at=?,
        bond_level=?,bond_progress=?,recent_warmth=?,warmth_updated_at=?,recent_tension=?,
        tension_updated_at=?,boundary_state=?,last_evaluated_at=?,last_bond_change_at=?,updated_at=?
        WHERE uin=?`).run(
        decayed.familiarityMass, now, bondLevel, promotion.progress, warmth, now, tension, now,
        boundaryState, now, (promotion.changed || severeBondLoss) ? now : Number(row.last_bond_change_at) || 0, now, id
      );
      this.db.exec('COMMIT');
      return { state: this.getState(id, settings, now), appliedEvents: applied };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  #promoteIfEligible(uin, bondLevel, now) {
    if (bondLevel >= 3) return { bondLevel, progress: 1, changed: false };
    const thresholds = {
      '-2': { events: 4, days: 4, windowDays: 30 },
      '-1': { events: 3, days: 3, windowDays: 21 },
      '0': { events: 3, days: 3, windowDays: 14 },
      '1': { events: 6, days: 5, windowDays: 45 },
      '2': { events: 10, days: 8, windowDays: 90 }
    };
    const need = thresholds[String(bondLevel)] || thresholds['0'];
    const since = now - need.windowDays * 86400000;
    const row = this.db.prepare(`SELECT COUNT(*) events,
      COUNT(DISTINCT date(created_at/1000,'unixepoch','+8 hours')) days,
      COUNT(DISTINCT event_type) types FROM relationship_v2_events
      WHERE uin=? AND durable_eligible=1 AND consumed_for_bond=0 AND created_at>=?`)
      .get(String(uin), since);
    const events = Number(row?.events) || 0;
    const days = Number(row?.days) || 0;
    const types = Number(row?.types) || 0;
    const progress = Math.min(0.99, Math.min(
      events / need.events,
      days / need.days,
      types / 2
    ));
    if (events < need.events || days < need.days || types < 2) {
      return { bondLevel, progress, changed: false };
    }
    this.db.prepare(`UPDATE relationship_v2_events SET consumed_for_bond=1 WHERE uin=?
      AND durable_eligible=1 AND consumed_for_bond=0 AND created_at>=?`).run(String(uin), since);
    return { bondLevel: Math.min(3, bondLevel + 1), progress: 0, changed: true };
  }
}
