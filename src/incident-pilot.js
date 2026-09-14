import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DB_NAME = 'incident-pilot.sqlite';
const INCIDENT_STATES = new Set(['open', 'acknowledged', 'resolved']);
const CHAT_MODES = new Set(['auto', 'blocked', 'continue']);
const SEVERITY_ORDER = { info: 0, warning: 1, error: 2, critical: 3 };

function cleanText(value, max = 1000) {
  return String(value ?? '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|key|secret|password|authorization)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}

function sanitizeDetails(value, depth = 0) {
  if (depth > 3) return '[truncated]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return cleanText(value, 500);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeDetails(item, depth + 1));
  if (typeof value !== 'object') return cleanText(value, 200);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    if (/token|secret|password|cookie|authorization|api.?key/i.test(key)) {
      out[key] = '[redacted]';
    } else {
      out[key] = sanitizeDetails(item, depth + 1);
    }
  }
  return out;
}

function incidentView(row) {
  if (!row) return null;
  let details = {};
  try { details = JSON.parse(row.details_json || '{}'); } catch { details = {}; }
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    code: row.code,
    category: row.category,
    severity: row.severity,
    source: row.source,
    chatKey: row.chat_key || '',
    sessionId: row.session_id || '',
    operationId: row.operation_id || '',
    state: row.state,
    count: Number(row.count) || 0,
    firstAt: Number(row.first_at) || 0,
    lastAt: Number(row.last_at) || 0,
    message: row.safe_message || '',
    details,
    stackHash: row.stack_hash || '',
    notifyState: row.notify_state || 'none',
    notifiedAt: Number(row.notified_at) || 0,
    notifyError: row.notify_error || '',
    acknowledgedAt: Number(row.acknowledged_at) || 0,
    resolvedAt: Number(row.resolved_at) || 0,
    resolution: row.resolution || '',
    version: Number(row.version) || 1
  };
}

function chatControlView(row, chatKey = '') {
  return row
    ? {
        chatKey: row.chat_key,
        mode: row.mode,
        reason: row.reason || '',
        updatedAt: Number(row.updated_at) || 0,
        updatedBy: row.updated_by || '',
        version: Number(row.version) || 1
      }
    : {
        chatKey: String(chatKey || ''),
        mode: 'auto',
        reason: '',
        updatedAt: 0,
        updatedBy: '',
        version: 0
      };
}

function normalizedSeverity(value) {
  return Object.hasOwn(SEVERITY_ORDER, value) ? value : 'error';
}

function classifyError(error, context = {}) {
  const message = cleanText(error?.message ?? error ?? '未知异常');
  const outcome = String(context.outcome || error?.outcome || '');
  let severity = normalizedSeverity(context.severity);
  let category = cleanText(context.category || 'internal', 80);
  let code = cleanText(context.code || error?.code || error?.name || 'UNEXPECTED_ERROR', 100);
  if (
    error?.code === 'TIME_CONTROL_INACTIVE'
    || error?.code === 'CHAT_BLOCKED'
    || /^(Run cancelled|Daily moments stopped)$/.test(message)
  ) {
    severity = 'info';
    category = 'lifecycle';
    code = error?.code || 'EXPECTED_CANCELLATION';
  } else if (outcome === 'unknown') {
    severity = 'critical';
    category = context.category || 'external_write';
  } else if (outcome === 'failed' && !context.severity) {
    severity = 'error';
    category = context.category || 'external_write';
  }
  return { message, outcome, severity, category, code };
}

export function incidentDatabasePath(dataDir) {
  return path.join(dataDir, DB_NAME);
}

export function inactiveIncidentPilotStatus({ enabled = false, error = '' } = {}) {
  return {
    enabled,
    active: false,
    exists: false,
    error: String(error || ''),
    counts: { open: 0, acknowledged: 0, resolved: 0, critical: 0 },
    pendingNotifications: 0,
    chatControls: 0
  };
}

export class IncidentPilotManager {
  constructor({
    dataDir,
    config,
    notify = null,
    notifyAvailable = () => true,
    emit = null,
    now = () => Date.now(),
    log = console.log
  }) {
    this.dataDir = dataDir;
    this.config = config;
    this.notify = notify;
    this.notifyAvailable = notifyAvailable;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.now = now;
    this.log = log;
    this.db = null;
    this.lastError = '';
    this.notifyChain = Promise.resolve();
  }

  get active() {
    return Boolean(this.db) && this.config()?.incidentPilot?.enabled === true;
  }

  get available() {
    return Boolean(this.db);
  }

  start() {
    if (this.config()?.incidentPilot?.enabled !== true) return this.status();
    if (this.db) return this.status();
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(incidentDatabasePath(this.dataDir));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        code TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        source TEXT NOT NULL,
        chat_key TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        operation_id TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'open',
        count INTEGER NOT NULL DEFAULT 1,
        first_at INTEGER NOT NULL,
        last_at INTEGER NOT NULL,
        safe_message TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        stack_hash TEXT NOT NULL DEFAULT '',
        notify_state TEXT NOT NULL DEFAULT 'none',
        notified_at INTEGER NOT NULL DEFAULT 0,
        notify_error TEXT NOT NULL DEFAULT '',
        acknowledged_at INTEGER NOT NULL DEFAULT 0,
        resolved_at INTEGER NOT NULL DEFAULT 0,
        resolution TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS incidents_recent
        ON incidents(state, severity, last_at DESC);
      CREATE INDEX IF NOT EXISTS incidents_fingerprint
        ON incidents(fingerprint, last_at DESC);
      CREATE TABLE IF NOT EXISTS chat_runtime_controls (
        chat_key TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'auto',
        reason TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL DEFAULT '',
        version INTEGER NOT NULL DEFAULT 1
      );
    `);
    this.db.prepare(`
      UPDATE incidents SET notify_state='unknown',
        notify_error='服务在告警发送期间重启，结果未知，不会自动重试',
        version=version+1
      WHERE notify_state='sending'
    `).run();
    const retentionDays = Math.min(
      3650,
      Math.max(1, Number(this.config()?.incidentPilot?.retentionDays) || 90)
    );
    this.db.prepare(`
      DELETE FROM incidents WHERE state='resolved' AND resolved_at>0 AND resolved_at<?
    `).run(this.now() - retentionDays * 86400000);
    this.lastError = '';
    this.resumeNotifications();
    return this.status();
  }

  openExisting() {
    if (this.db) return this.status();
    const file = incidentDatabasePath(this.dataDir);
    if (!fs.existsSync(file)) return this.status();
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout=5000;');
    return this.status();
  }

  async stop() {
    const db = this.db;
    this.db = null;
    await this.notifyChain.catch(() => {});
    try { db?.close(); } catch { /* ignore */ }
  }

  status() {
    const enabled = this.config()?.incidentPilot?.enabled === true;
    if (!this.db) return inactiveIncidentPilotStatus({ enabled, error: this.lastError });
    const rows = this.db.prepare(`
      SELECT state, severity, COUNT(*) AS count FROM incidents GROUP BY state, severity
    `).all();
    const counts = { open: 0, acknowledged: 0, resolved: 0, critical: 0 };
    for (const row of rows) {
      counts[row.state] = (counts[row.state] || 0) + Number(row.count || 0);
      if (row.severity === 'critical' && row.state !== 'resolved') {
        counts.critical += Number(row.count || 0);
      }
    }
    return {
      enabled,
      active: enabled,
      exists: true,
      error: this.lastError,
      counts,
      pendingNotifications: Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM incidents WHERE notify_state='pending'
      `).get().count) || 0,
      chatControls: Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM chat_runtime_controls WHERE mode!='auto'
      `).get().count) || 0
    };
  }

  capture(error, context = {}) {
    if (!this.active) return null;
    const normalized = classifyError(error, context);
    const source = cleanText(context.source || 'application', 100);
    const chatKey = /^(group|private):\d+$/.test(String(context.chatKey || ''))
      ? String(context.chatKey)
      : '';
    const sessionId = cleanText(context.sessionId, 100);
    const operationId = cleanText(context.operationId, 100);
    const details = sanitizeDetails(context.details || {});
    const stackHash = error?.stack
      ? crypto.createHash('sha256').update(String(error.stack)).digest('hex').slice(0, 16)
      : '';
    const fingerprint = crypto.createHash('sha256').update([
      normalized.code,
      normalized.category,
      source,
      chatKey,
      normalized.message
    ].join('\0')).digest('hex');
    const now = this.now();
    const windowMs = Math.min(
      24 * 60,
      Math.max(1, Number(this.config()?.incidentPilot?.duplicateWindowMinutes) || 10)
    ) * 60000;
    let incident;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare(`
        SELECT * FROM incidents
        WHERE fingerprint=? AND state!='resolved' AND last_at>=?
        ORDER BY last_at DESC LIMIT 1
      `).get(fingerprint, now - windowMs);
      if (existing) {
        const severity = SEVERITY_ORDER[normalized.severity] > SEVERITY_ORDER[existing.severity]
          ? normalized.severity
          : existing.severity;
        this.db.prepare(`
          UPDATE incidents SET severity=?, count=count+1, last_at=?,
            safe_message=?, details_json=?, version=version+1
          WHERE id=?
        `).run(
          severity,
          now,
          normalized.message,
          JSON.stringify(details),
          existing.id
        );
        incident = this.get(existing.id);
      } else {
        const id = `inc_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
        const shouldNotify = this.#shouldNotify(normalized.severity);
        this.db.prepare(`
          INSERT INTO incidents (
            id, fingerprint, code, category, severity, source,
            chat_key, session_id, operation_id, state, count,
            first_at, last_at, safe_message, details_json, stack_hash,
            notify_state, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?, ?, ?, ?, 1)
        `).run(
          id,
          fingerprint,
          normalized.code,
          normalized.category,
          normalized.severity,
          source,
          chatKey,
          sessionId,
          operationId,
          now,
          now,
          normalized.message,
          JSON.stringify(details),
          stackHash,
          shouldNotify ? 'pending' : 'none'
        );
        incident = this.get(id);
      }
      this.db.exec('COMMIT');
    } catch (captureError) {
      this.db.exec('ROLLBACK');
      this.lastError = String(captureError?.message ?? captureError);
      this.log(`[incident-pilot] 异常记录失败：${this.lastError}`);
      return null;
    }
    this.emit('incident-pilot-update', { id: incident.id, chatKey, state: incident.state });
    if (incident.notifyState === 'pending') this.#queueNotification(incident.id);
    return incident;
  }

  list({ state = '', severity = '', chatKey = '', limit = 100 } = {}) {
    if (!this.db) return [];
    const clauses = [];
    const params = [];
    if (INCIDENT_STATES.has(state)) {
      clauses.push('state=?');
      params.push(state);
    }
    if (Object.hasOwn(SEVERITY_ORDER, severity)) {
      clauses.push('severity=?');
      params.push(severity);
    }
    if (/^(group|private):\d+$/.test(chatKey)) {
      clauses.push('chat_key=?');
      params.push(chatKey);
    }
    params.push(Math.min(500, Math.max(1, Number(limit) || 100)));
    return this.db.prepare(`
      SELECT * FROM incidents
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY last_at DESC LIMIT ?
    `).all(...params).map(incidentView);
  }

  get(id) {
    if (!this.db) return null;
    return incidentView(this.db.prepare('SELECT * FROM incidents WHERE id=?').get(String(id || '')));
  }

  acknowledge(id) {
    return this.#transition(id, 'acknowledged');
  }

  resolve(id, resolution = '') {
    const note = cleanText(resolution, 500);
    if (!note) throw Object.assign(new Error('解决异常必须填写处理结果'), { httpStatus: 400 });
    return this.#transition(id, 'resolved', note);
  }

  delete(id) {
    if (!this.active) throw Object.assign(new Error('异常处理实验未启用'), { httpStatus: 409 });
    const incident = this.get(id);
    if (!incident) return false;
    if (incident.state !== 'resolved') {
      throw Object.assign(new Error('只能删除已解决的异常日志'), { httpStatus: 409 });
    }
    this.db.prepare('DELETE FROM incidents WHERE id=?').run(incident.id);
    this.emit('incident-pilot-update', { id: incident.id, deleted: true, chatKey: incident.chatKey });
    return true;
  }

  getChatControl(chatKey) {
    if (!this.db) return chatControlView(null, chatKey);
    return chatControlView(this.db.prepare(
      'SELECT * FROM chat_runtime_controls WHERE chat_key=?'
    ).get(String(chatKey || '')), chatKey);
  }

  setChatControl(chatKey, {
    mode,
    reason = '',
    expectedVersion = null,
    updatedBy = 'console'
  } = {}) {
    if (!this.active) throw Object.assign(new Error('异常处理实验未启用'), { httpStatus: 409 });
    const key = String(chatKey || '');
    if (!/^(group|private):\d+$/.test(key)) {
      throw Object.assign(new Error('会话标识无效'), { httpStatus: 400 });
    }
    if (!CHAT_MODES.has(mode)) {
      throw Object.assign(new Error('会话模式必须是 auto、blocked 或 continue'), { httpStatus: 400 });
    }
    const current = this.getChatControl(key);
    if (expectedVersion != null && Number(expectedVersion) !== current.version) {
      throw Object.assign(new Error('会话控制状态已被其他操作更新，请刷新后重试'), {
        code: 'INCIDENT_CONTROL_VERSION_CONFLICT',
        httpStatus: 409
      });
    }
    const now = this.now();
    const version = current.version + 1;
    this.db.prepare(`
      INSERT INTO chat_runtime_controls(chat_key, mode, reason, updated_at, updated_by, version)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_key) DO UPDATE SET
        mode=excluded.mode, reason=excluded.reason, updated_at=excluded.updated_at,
        updated_by=excluded.updated_by, version=excluded.version
    `).run(
      key,
      mode,
      cleanText(reason, 300),
      now,
      cleanText(updatedBy, 80),
      version
    );
    const control = this.getChatControl(key);
    this.emit('incident-pilot-update', { chatKey: key, control });
    return control;
  }

  chatDecision(chatKey, { held = 0 } = {}) {
    const control = this.getChatControl(chatKey);
    if (!this.active) {
      return {
        allowed: Number(held) === 0,
        mode: 'legacy',
        effectiveState: Number(held) > 0 ? 'blocked' : 'normal',
        reason: Number(held) > 0 ? '存在发送结果待确认' : '',
        control
      };
    }
    if (control.mode === 'blocked') {
      return {
        allowed: false,
        mode: control.mode,
        effectiveState: 'blocked',
        reason: control.reason || '管理员已阻塞该会话',
        control
      };
    }
    const unknownBlocks = this.config()?.incidentPilot?.unknownWritesBlockChat === true;
    if (Number(held) > 0 && unknownBlocks && control.mode !== 'continue') {
      return {
        allowed: false,
        mode: control.mode,
        effectiveState: 'blocked',
        reason: '存在发送结果待确认',
        control
      };
    }
    return {
      allowed: true,
      mode: control.mode,
      effectiveState: Number(held) > 0 ? 'degraded' : 'normal',
      reason: Number(held) > 0 ? '旧写入待核对；不会自动重试，可继续处理新消息' : '',
      control
    };
  }

  contextForChat(chatKey, meta = {}) {
    const decision = this.chatDecision(chatKey, meta);
    if (decision.effectiveState !== 'degraded') return '';
    return [
      '【异常隔离】此前存在结果待核对的外部操作。',
      '不要重试、复述或补发旧操作；只处理本次新消息。管理员会单独核对旧结果。'
    ].join('\n');
  }

  resumeNotifications() {
    if (!this.active || !this.notifyAvailable()) return;
    const pending = this.db.prepare(`
      SELECT id FROM incidents WHERE notify_state='pending' ORDER BY first_at LIMIT 50
    `).all();
    for (const row of pending) this.#queueNotification(row.id);
  }

  async waitForIdle() {
    await this.notifyChain.catch(() => {});
  }

  #transition(id, state, resolution = '') {
    if (!this.active) throw Object.assign(new Error('异常处理实验未启用'), { httpStatus: 409 });
    if (!INCIDENT_STATES.has(state)) throw new Error(`无效异常状态：${state}`);
    const incident = this.get(id);
    if (!incident) return null;
    const now = this.now();
    this.db.prepare(`
      UPDATE incidents SET state=?, acknowledged_at=CASE
        WHEN ?='acknowledged' AND acknowledged_at=0 THEN ? ELSE acknowledged_at END,
        resolved_at=CASE WHEN ?='resolved' THEN ? ELSE resolved_at END,
        resolution=CASE WHEN ?='resolved' THEN ? ELSE resolution END,
        version=version+1
      WHERE id=?
    `).run(state, state, now, state, now, state, resolution, incident.id);
    const updated = this.get(incident.id);
    this.emit('incident-pilot-update', {
      id: updated.id,
      chatKey: updated.chatKey,
      state: updated.state
    });
    return updated;
  }

  #shouldNotify(severity) {
    if (severity === 'critical' || severity === 'error') return true;
    return severity === 'warning'
      && this.config()?.incidentPilot?.notifyWarnings === true;
  }

  #queueNotification(id) {
    this.notifyChain = this.notifyChain
      .then(() => this.#notifyIncident(id))
      .catch((error) => {
        this.lastError = String(error?.message ?? error);
        this.log(`[incident-pilot] 管理员告警失败：${this.lastError}`);
      });
  }

  async #notifyIncident(id) {
    if (!this.active || !this.notify || !this.notifyAvailable()) return;
    const incident = this.get(id);
    if (!incident || incident.notifyState !== 'pending') return;
    const ownerUin = String(this.config()?.incidentPilot?.ownerUin || '').trim();
    if (!/^\d{5,15}$/.test(ownerUin)) return;
    this.db.prepare(`
      UPDATE incidents SET notify_state='sending', notify_error='', version=version+1
      WHERE id=? AND notify_state='pending'
    `).run(incident.id);
    try {
      await this.notify(incident, ownerUin);
      if (!this.db) return;
      this.db.prepare(`
        UPDATE incidents SET notify_state='sent', notified_at=?, notify_error='',
          version=version+1 WHERE id=? AND notify_state='sending'
      `).run(this.now(), incident.id);
    } catch (error) {
      if (!this.db) return;
      const state = error?.beforeWrite === true
        ? 'pending'
        : error?.outcome === 'failed'
          ? 'failed'
          : 'unknown';
      this.db.prepare(`
        UPDATE incidents SET notify_state=?, notify_error=?, version=version+1
        WHERE id=? AND notify_state='sending'
      `).run(state, cleanText(error?.message ?? error, 1000), incident.id);
    }
    this.emit('incident-pilot-update', { id: incident.id });
  }
}
