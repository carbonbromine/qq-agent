import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.js';
import { shanghaiDayStart } from './util.js';

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function cleanText(value, max = 500) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function view(row) {
  if (!row) return null;
  const speakerIds = parseJson(row.speaker_ids_json, []).map(String);
  return {
    id: row.id,
    normalizedTerm: row.normalized_term,
    displayTerm: row.display_term,
    scopeChatKey: row.scope_chat_key,
    state: row.state,
    score: Number(row.score) || 0,
    occurrenceCount: Number(row.occurrence_count) || 0,
    speakerCount: speakerIds.length,
    speakerIds,
    evidence: parseJson(row.evidence_json, []),
    detectionReasons: parseJson(row.detection_reasons_json, []),
    research: parseJson(row.research_json, null),
    researchSources: parseJson(row.research_sources_json, []),
    researchUsage: parseJson(row.research_usage_json, null),
    researchError: row.research_error || '',
    admittedSlangId: row.admitted_slang_id || '',
    pendingAt: Number(row.pending_at) || 0,
    researchApprovedAt: Number(row.research_approved_at) || 0,
    researchStartedAt: Number(row.research_started_at) || 0,
    researchedAt: Number(row.researched_at) || 0,
    admissionDecidedAt: Number(row.admission_decided_at) || 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    version: Number(row.version) || 1
  };
}

export function slangPilotDatabasePath(dataDir = DATA_DIR) {
  return path.join(dataDir, 'slang-pilot.sqlite');
}

export class SlangPilotStore {
  constructor({ dataDir = DATA_DIR, filename } = {}) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename || slangPilotDatabasePath(dataDir));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS slang_discoveries (
        id TEXT PRIMARY KEY,
        normalized_term TEXT NOT NULL,
        display_term TEXT NOT NULL,
        scope_chat_key TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'observing',
        score REAL NOT NULL DEFAULT 0,
        occurrence_count INTEGER NOT NULL DEFAULT 0,
        speaker_ids_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        detection_reasons_json TEXT NOT NULL DEFAULT '[]',
        research_json TEXT NOT NULL DEFAULT 'null',
        research_sources_json TEXT NOT NULL DEFAULT '[]',
        research_usage_json TEXT NOT NULL DEFAULT 'null',
        research_error TEXT NOT NULL DEFAULT '',
        admitted_slang_id TEXT NOT NULL DEFAULT '',
        pending_at INTEGER NOT NULL DEFAULT 0,
        research_approved_at INTEGER NOT NULL DEFAULT 0,
        research_started_at INTEGER NOT NULL DEFAULT 0,
        researched_at INTEGER NOT NULL DEFAULT 0,
        admission_decided_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        UNIQUE(normalized_term, scope_chat_key)
      );
      CREATE INDEX IF NOT EXISTS slang_discoveries_state
        ON slang_discoveries(state, updated_at DESC);
      CREATE TABLE IF NOT EXISTS slang_approval_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discovery_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        decision TEXT NOT NULL,
        decided_by TEXT NOT NULL DEFAULT '',
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS slang_approval_events_discovery
        ON slang_approval_events(discovery_id, created_at DESC);
    `);
    this.db.prepare(`
      UPDATE slang_discoveries
      SET state='research_interrupted',
          research_error='服务在研究完成前重启，需管理员手动重试',
          updated_at=?,
          version=version+1
      WHERE state='researching'
    `).run(Date.now());
    try { fs.chmodSync(filename || slangPilotDatabasePath(dataDir), 0o600); } catch { /* best effort */ }
  }

  close() {
    this.db.close();
  }

  pruneObservations(before) {
    return this.db.prepare(`
      DELETE FROM slang_discoveries
      WHERE state='observing' AND updated_at<?
    `).run(Number(before) || 0).changes;
  }

  observeCandidate({
    normalizedTerm,
    displayTerm,
    chatKey,
    speakerId,
    senderName,
    messageId,
    text,
    at = Date.now(),
    score = 0,
    reason = '',
    settings
  }) {
    const normalized = cleanText(normalizedTerm, 40).toLowerCase();
    const display = cleanText(displayTerm, 40);
    const scope = String(chatKey || '');
    if (!normalized || !display || !/^group:\d+$/.test(scope)) return null;
    const current = this.db.prepare(`
      SELECT * FROM slang_discoveries
      WHERE normalized_term=? AND scope_chat_key=?
    `).get(normalized, scope);
    const cooldownMs = Math.max(1, Number(settings.rejectCooldownDays) || 14) * 86400000;
    if (
      current
      && ['research_rejected', 'admission_rejected'].includes(current.state)
      && at - Number(current.updated_at) < cooldownMs
    ) return null;
    if (current?.state === 'admitted_candidate') return null;

    const windowMs = Math.max(1, Number(settings.windowHours) || 72) * 3600000;
    const staleObservation = current
      && ['observing', 'research_rejected', 'admission_rejected'].includes(current.state)
      && at - Number(current.updated_at) > windowMs;
    const speakerIds = new Set(
      staleObservation ? [] : parseJson(current?.speaker_ids_json, []).map(String)
    );
    if (speakerId) speakerIds.add(String(speakerId));
    const evidence = staleObservation ? [] : parseJson(current?.evidence_json, []);
    const evidenceKey = `${scope}:${messageId ?? ''}:${String(speakerId || '')}`;
    if (!evidence.some((item) => item.key === evidenceKey)) {
      evidence.push({
        key: evidenceKey,
        chatKey: scope,
        messageId: messageId == null ? '' : String(messageId),
        senderId: String(speakerId || ''),
        senderName: cleanText(senderName, 60),
        text: cleanText(text, 240),
        at
      });
    }
    const maxEvidence = Math.min(30, Math.max(3, Number(settings.maxEvidence) || 12));
    const trimmedEvidence = evidence.slice(-maxEvidence);
    const reasons = new Set(
      staleObservation ? [] : parseJson(current?.detection_reasons_json, [])
    );
    if (reason) reasons.add(cleanText(reason, 60));
    const occurrences = (
      staleObservation ? 0 : Math.max(0, Number(current?.occurrence_count) || 0)
    ) + 1;
    const baseScore = Math.max(
      staleObservation ? 0 : Number(current?.score) || 0,
      Number(score) || 0
    );
    const computedScore = Math.min(
      1,
      baseScore
        + Math.min(0.24, Math.log2(Math.max(1, occurrences)) * 0.08)
        + Math.min(0.16, speakerIds.size * 0.04)
    );
    let state = current?.state || 'observing';
    if (['research_rejected', 'admission_rejected'].includes(state)) state = 'observing';
    let pendingAt = Number(current?.pending_at) || 0;
    let promoted = false;
    const qualifies = (
      occurrences >= Math.max(2, Number(settings.minOccurrences) || 3)
      && speakerIds.size >= Math.max(1, Number(settings.minSpeakers) || 2)
      && computedScore >= 0.62
    ) || (baseScore >= 0.95 && occurrences >= 2);
    if (state === 'observing' && qualifies && this.#canPromote(scope, settings, at)) {
      state = 'pending_research';
      pendingAt = at;
      promoted = true;
    }

    const id = current?.id || `sr_${crypto.randomBytes(6).toString('hex')}`;
    this.db.prepare(`
      INSERT INTO slang_discoveries (
        id, normalized_term, display_term, scope_chat_key, state, score,
        occurrence_count, speaker_ids_json, evidence_json, detection_reasons_json,
        pending_at, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(normalized_term, scope_chat_key) DO UPDATE SET
        display_term=excluded.display_term,
        state=excluded.state,
        score=excluded.score,
        occurrence_count=excluded.occurrence_count,
        speaker_ids_json=excluded.speaker_ids_json,
        evidence_json=excluded.evidence_json,
        detection_reasons_json=excluded.detection_reasons_json,
        pending_at=excluded.pending_at,
        updated_at=excluded.updated_at,
        version=slang_discoveries.version+1
    `).run(
      id,
      normalized,
      display,
      scope,
      state,
      computedScore,
      occurrences,
      JSON.stringify([...speakerIds].slice(-50)),
      JSON.stringify(trimmedEvidence),
      JSON.stringify([...reasons].slice(-20)),
      pendingAt,
      Number(current?.created_at) || at,
      at
    );
    return { discovery: this.get(id), promoted };
  }

  #canPromote(chatKey, settings, now) {
    const maxPending = Math.max(1, Number(settings.maxPending) || 100);
    const open = this.db.prepare(`
      SELECT COUNT(*) AS n FROM slang_discoveries
      WHERE state IN ('pending_research','research_queued','researching',
        'research_interrupted','research_failed','pending_admission')
    `).get().n;
    if (Number(open) >= maxPending) return false;
    const dailyLimit = Math.max(1, Number(settings.perChatDailyLimit) || 5);
    const daily = this.db.prepare(`
      SELECT COUNT(*) AS n FROM slang_discoveries
      WHERE scope_chat_key=? AND pending_at>=?
    `).get(chatKey, shanghaiDayStart(now)).n;
    return Number(daily) < dailyLimit;
  }

  get(id) {
    return view(this.db.prepare('SELECT * FROM slang_discoveries WHERE id=?').get(String(id || '')));
  }

  list({ state = '', query = '', limit = 100, includeObserving = false } = {}) {
    const stateFilter = String(state || '').split(',')
      .map((item) => item.trim()).filter(Boolean).join(',');
    const q = cleanText(query, 80).toLowerCase();
    const rows = this.db.prepare(`
      SELECT * FROM slang_discoveries
      WHERE (?=1 OR state!='observing')
        AND (?='' OR instr(',' || ? || ',', ',' || state || ',')>0)
        AND (?='' OR lower(display_term) LIKE ? OR lower(normalized_term) LIKE ?)
      ORDER BY
        CASE state
          WHEN 'pending_research' THEN 0
          WHEN 'pending_admission' THEN 1
          WHEN 'researching' THEN 2
          WHEN 'research_queued' THEN 3
          ELSE 4
        END,
        updated_at DESC
      LIMIT ?
    `).all(
      includeObserving ? 1 : 0,
      stateFilter,
      stateFilter,
      q,
      `%${q}%`,
      `%${q}%`,
      Math.min(500, Math.max(1, Number(limit) || 100))
    ).map(view);
    return rows;
  }

  decideResearch(id, decision, { decidedBy = '', expectedVersion, now = Date.now() } = {}) {
    const current = this.get(id);
    if (!current) throw new Error('黑话发现不存在');
    if (current.state !== 'pending_research') throw new Error('该词条当前不处于待研究审批状态');
    if (expectedVersion != null && Number(expectedVersion) !== current.version) {
      throw new Error('词条已被其他操作更新，请刷新后重试');
    }
    const approved = decision === 'approve';
    if (!approved && decision !== 'reject') throw new Error('审批决定必须是 approve 或 reject');
    const nextState = approved ? 'research_queued' : 'research_rejected';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE slang_discoveries
        SET state=?, research_approved_at=?, research_error='', updated_at=?, version=version+1
        WHERE id=? AND state='pending_research'
      `).run(nextState, approved ? now : 0, now, current.id);
      this.#recordApproval(current.id, 'research', decision, decidedBy, current.state, nextState, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.get(current.id);
  }

  claimResearch(id, now = Date.now()) {
    const result = this.db.prepare(`
      UPDATE slang_discoveries
      SET state='researching', research_started_at=?, research_error='',
        updated_at=?, version=version+1
      WHERE id=? AND state='research_queued'
    `).run(now, now, String(id || ''));
    return result.changes ? this.get(id) : null;
  }

  completeResearch(id, { research, sources = [], usage = null, now = Date.now() } = {}) {
    const result = this.db.prepare(`
      UPDATE slang_discoveries
      SET state='pending_admission', research_json=?, research_sources_json=?,
        research_usage_json=?, research_error='', researched_at=?, updated_at=?,
        version=version+1
      WHERE id=? AND state='researching'
    `).run(
      JSON.stringify(research || null),
      JSON.stringify(Array.isArray(sources) ? sources : []),
      JSON.stringify(usage || null),
      now,
      now,
      String(id || '')
    );
    if (!result.changes) throw new Error('研究任务状态已改变，结果未写入');
    return this.get(id);
  }

  failResearch(id, error, { interrupted = false, now = Date.now() } = {}) {
    const nextState = interrupted ? 'research_interrupted' : 'research_failed';
    const result = this.db.prepare(`
      UPDATE slang_discoveries
      SET state=?, research_error=?, updated_at=?, version=version+1
      WHERE id=? AND state='researching'
    `).run(nextState, cleanText(error, 1000), now, String(id || ''));
    return result.changes ? this.get(id) : this.get(id);
  }

  retryResearch(id, { decidedBy = '', now = Date.now() } = {}) {
    const current = this.get(id);
    if (!current) throw new Error('黑话发现不存在');
    if (!['research_failed', 'research_interrupted'].includes(current.state)) {
      throw new Error('该词条当前不能重试研究');
    }
    this.db.prepare(`
      UPDATE slang_discoveries
      SET state='research_queued', research_error='', updated_at=?, version=version+1
      WHERE id=?
    `).run(now, current.id);
    this.#recordApproval(current.id, 'research-retry', 'approve', decidedBy, current.state, 'research_queued', now);
    return this.get(current.id);
  }

  decideAdmission(id, decision, { decidedBy = '', expectedVersion, slangId = '', now = Date.now() } = {}) {
    const current = this.get(id);
    if (!current) throw new Error('黑话发现不存在');
    if (current.state !== 'pending_admission') throw new Error('该词条当前不处于待入库审批状态');
    if (expectedVersion != null && Number(expectedVersion) !== current.version) {
      throw new Error('词条已被其他操作更新，请刷新后重试');
    }
    if (!['approve', 'reject'].includes(decision)) throw new Error('审批决定必须是 approve 或 reject');
    const nextState = decision === 'approve' ? 'admitted_candidate' : 'admission_rejected';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE slang_discoveries
        SET state=?, admitted_slang_id=?, admission_decided_at=?, updated_at=?,
          version=version+1
        WHERE id=? AND state='pending_admission'
      `).run(nextState, decision === 'approve' ? String(slangId || '') : '', now, now, current.id);
      this.#recordApproval(current.id, 'admission', decision, decidedBy, current.state, nextState, now);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.get(current.id);
  }

  events(id) {
    return this.db.prepare(`
      SELECT stage, decision, decided_by AS decidedBy, from_state AS fromState,
        to_state AS toState, created_at AS createdAt
      FROM slang_approval_events
      WHERE discovery_id=? ORDER BY id
    `).all(String(id || ''));
  }

  status() {
    const rows = this.db.prepare(`
      SELECT state, COUNT(*) AS n FROM slang_discoveries
      WHERE state!='observing' GROUP BY state
    `).all();
    const counts = Object.fromEntries(rows.map((row) => [row.state, Number(row.n) || 0]));
    return {
      databaseExists: true,
      total: rows.reduce((sum, row) => sum + Number(row.n || 0), 0),
      pendingResearch: counts.pending_research || 0,
      researching: (counts.research_queued || 0) + (counts.researching || 0),
      pendingAdmission: counts.pending_admission || 0,
      admitted: counts.admitted_candidate || 0,
      rejected: (counts.research_rejected || 0) + (counts.admission_rejected || 0),
      failed: (counts.research_failed || 0) + (counts.research_interrupted || 0),
      counts
    };
  }

  #recordApproval(discoveryId, stage, decision, decidedBy, fromState, toState, now) {
    this.db.prepare(`
      INSERT INTO slang_approval_events (
        discovery_id, stage, decision, decided_by, from_state, to_state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      discoveryId,
      stage,
      decision,
      cleanText(decidedBy, 80),
      fromState,
      toState,
      now
    );
  }
}

export function inactiveSlangPilotStatus({ enabled = false, error = '' } = {}) {
  return {
    enabled,
    active: false,
    databaseExists: false,
    error: String(error || ''),
    pendingResearch: 0,
    researching: 0,
    pendingAdmission: 0,
    admitted: 0,
    rejected: 0,
    failed: 0,
    counts: {}
  };
}
