import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const STATE_FILE = 'auto-update.json';
const REQUEST_FILE = 'auto-update-request.json';
const ACTIVE_STATES = new Set(['queued', 'checking', 'testing', 'deploying']);

function cleanText(value, max = 1200) {
  return String(value ?? '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|key|secret|password|authorization)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\0/g, '')
    .trim()
    .slice(0, max);
}

function readObject(file, fallback = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

function writeObject(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

function updateError(message, httpStatus = 409) {
  return Object.assign(new Error(message), { httpStatus });
}

export function autoUpdatePaths(dataDir) {
  const root = path.resolve(dataDir);
  return {
    state: path.join(root, STATE_FILE),
    request: path.join(root, REQUEST_FILE),
    lock: path.join(root, '.auto-update.lock'),
    repository: path.join(root, 'update-repository.git'),
    workRoot: path.join(root, 'update-work')
  };
}

export function readAutoUpdateState(dataDir) {
  return readObject(autoUpdatePaths(dataDir).state, {
    version: 1,
    status: 'idle',
    mode: '',
    phase: '',
    startedAt: 0,
    updatedAt: 0,
    completedAt: 0,
    lastCheckAt: 0,
    lastSuccessAt: 0,
    currentRevision: '',
    targetRevision: '',
    error: '',
    notification: {
      pending: false,
      ownerUin: '',
      sentAt: 0,
      error: ''
    }
  });
}

export function writeAutoUpdateState(dataDir, patch) {
  const current = readAutoUpdateState(dataDir);
  const next = {
    ...current,
    ...patch,
    version: 1,
    updatedAt: Date.now(),
    notification: {
      ...(current.notification || {}),
      ...(patch.notification || {})
    }
  };
  writeObject(autoUpdatePaths(dataDir).state, next);
  return next;
}

export function writeAutoUpdateRequest(dataDir, mode = 'manual') {
  const request = {
    version: 1,
    mode: mode === 'manual' ? 'manual' : 'scheduled',
    requestedAt: Date.now()
  };
  writeObject(autoUpdatePaths(dataDir).request, request);
  return request;
}

export function consumeAutoUpdateRequest(dataDir) {
  const file = autoUpdatePaths(dataDir).request;
  const request = readObject(file, null);
  try { fs.unlinkSync(file); } catch { /* no request */ }
  if (
    !request
    || !['manual', 'scheduled'].includes(request.mode)
    || Date.now() - Number(request.requestedAt || 0) > 60 * 60 * 1000
  ) {
    return null;
  }
  return request;
}

export function autoUpdateOwner(config = {}) {
  return String(
    config.autoUpdate?.ownerUin
    || config.incidentPilot?.ownerUin
    || config.identityPilot?.friendProposal?.ownerUin
    || ''
  ).trim();
}

export function sanitizeUpdateError(error) {
  return cleanText(error?.message ?? error ?? '更新失败');
}

export class AutoUpdateManager {
  constructor({
    appDir,
    dataDir,
    config,
    updateConfig,
    notify,
    notifyAvailable = () => true,
    emit = null,
    runSystemctl = null,
    log = console.log
  }) {
    this.appDir = path.resolve(appDir);
    this.dataDir = path.resolve(dataDir);
    this.config = config;
    this.updateConfig = updateConfig;
    this.notify = notify;
    this.notifyAvailable = notifyAvailable;
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.runSystemctl = runSystemctl || ((args) => spawnSync(
      'systemctl',
      ['--user', ...args],
      { encoding: 'utf8', timeout: 15_000 }
    ));
    this.log = log;
    this.notificationTimer = null;
    this.notificationKickoff = null;
    this.notificationTask = null;
  }

  deployment() {
    const value = readObject(path.join(this.appDir, '.deployment.json'), null);
    if (!value?.service || path.resolve(value.root || '') !== this.appDir) return null;
    return value;
  }

  serviceName() {
    const deployment = this.deployment();
    return deployment
      ? String(deployment.updateService || `${deployment.service}-update`)
      : '';
  }

  installed() {
    return Boolean(this.serviceName())
      && fs.existsSync(path.join(this.appDir, 'scripts', 'auto-update.mjs'));
  }

  serviceActive() {
    if (!this.installed()) return false;
    const result = this.runSystemctl([
      '--quiet',
      'is-active',
      `${this.serviceName()}.service`
    ]);
    return result?.status === 0;
  }

  status() {
    const cfg = this.config();
    const settings = cfg.autoUpdate || {};
    const state = readAutoUpdateState(this.dataDir);
    const intervalMs = Math.max(1, Number(settings.intervalHours) || 6) * 60 * 60 * 1000;
    const busy = this.serviceActive()
      || (ACTIVE_STATES.has(state.status)
        && Date.now() - Number(state.updatedAt || 0) < 30 * 60 * 1000);
    let deployedRevision = '';
    try {
      deployedRevision = fs.readFileSync(
        path.join(this.dataDir, 'deployed-revision'),
        'utf8'
      ).trim();
    } catch { /* not deployed through deploy.sh yet */ }
    return {
      installed: this.installed(),
      enabled: settings.enabled === true && state.autoDisabled !== true,
      busy,
      ownerUin: autoUpdateOwner(cfg),
      repository: String(settings.repository || ''),
      branch: String(settings.branch || 'main'),
      intervalHours: Number(settings.intervalHours) || 6,
      nextCheckAt: settings.enabled === true
        ? Math.max(Date.now(), Number(state.lastCheckAt || 0) + intervalMs)
        : 0,
      ...state,
      currentRevision: state.currentRevision || deployedRevision
    };
  }

  configure({ ownerUin = '', intervalHours = 6 } = {}) {
    const cfg = this.updateConfig({
      autoUpdate: {
        ...(this.config().autoUpdate || {}),
        ownerUin: String(ownerUin || '').trim(),
        intervalHours
      }
    });
    this.emit('auto-update', this.status());
    return cfg.autoUpdate;
  }

  resume({ ownerUin = '', intervalHours = 6 } = {}) {
    const current = this.config();
    const nextOwner = String(ownerUin || current.autoUpdate?.ownerUin || '').trim();
    const cfg = this.updateConfig({
      autoUpdate: {
        ...(current.autoUpdate || {}),
        enabled: true,
        ownerUin: nextOwner,
        intervalHours
      }
    });
    writeAutoUpdateState(this.dataDir, {
      status: 'idle',
      phase: '',
      error: '',
      autoDisabled: false,
      completedAt: Date.now(),
      lastCheckAt: 0
    });
    this.emit('auto-update', this.status());
    return cfg.autoUpdate;
  }

  pause() {
    const cfg = this.updateConfig({
      autoUpdate: {
        ...(this.config().autoUpdate || {}),
        enabled: false
      }
    });
    if (!this.serviceActive()) {
      writeAutoUpdateState(this.dataDir, {
        status: 'disabled',
        phase: '',
        completedAt: Date.now()
      });
    }
    this.emit('auto-update', this.status());
    return cfg.autoUpdate;
  }

  requestManual() {
    if (!this.installed()) {
      throw updateError('自动更新服务尚未安装，请先用 deploy.sh 部署当前版本');
    }
    const cfg = this.config();
    const ownerUin = autoUpdateOwner(cfg);
    if (!/^\d{5,15}$/.test(ownerUin)) {
      throw updateError('请先配置自动更新告警管理员 QQ', 400);
    }
    if (
      cfg.allowAllWhenEmpty !== true
      && !(cfg.allow?.private || []).map(String).includes(ownerUin)
    ) {
      throw updateError('自动更新管理员 QQ 必须同时加入私聊白名单', 400);
    }
    const current = this.status();
    if (current.busy) throw updateError('已有更新任务正在运行');

    writeAutoUpdateRequest(this.dataDir, 'manual');
    writeAutoUpdateState(this.dataDir, {
      status: 'queued',
      mode: 'manual',
      phase: 'queued',
      startedAt: Date.now(),
      completedAt: 0,
      error: ''
    });
    const result = this.runSystemctl([
      '--no-block',
      'start',
      `${this.serviceName()}.service`
    ]);
    if (result?.status !== 0) {
      const message = cleanText(result?.stderr || '无法启动自动更新服务');
      this.updateConfig({
        autoUpdate: {
          ...(this.config().autoUpdate || {}),
          enabled: false
        }
      });
      writeAutoUpdateState(this.dataDir, {
        status: 'failed',
        phase: 'launch',
        completedAt: Date.now(),
        error: message,
        autoDisabled: true,
        notification: {
          pending: true,
          ownerUin,
          sentAt: 0,
          error: ''
        }
      });
      this.resumeNotifications();
      throw updateError(message);
    }
    this.emit('auto-update', this.status());
    return this.status();
  }

  start() {
    this.stop();
    this.notificationTimer = setInterval(() => {
      this.resumeNotifications();
    }, 30_000);
    this.notificationTimer.unref?.();
    this.notificationKickoff = setTimeout(() => {
      this.notificationKickoff = null;
      this.resumeNotifications();
    }, 2_000);
    this.notificationKickoff.unref?.();
  }

  stop() {
    clearInterval(this.notificationTimer);
    clearTimeout(this.notificationKickoff);
    this.notificationTimer = null;
    this.notificationKickoff = null;
  }

  resumeNotifications() {
    if (this.notificationTask) return this.notificationTask;
    this.notificationTask = this.#notifyPending()
      .catch((error) => this.log(`[auto-update] 管理员通知失败：${error?.message ?? error}`))
      .finally(() => { this.notificationTask = null; });
    return this.notificationTask;
  }

  async handlePendingFailure() {
    const state = readAutoUpdateState(this.dataDir);
    if (state.status === 'failed' && this.config().autoUpdate?.enabled === true) {
      this.updateConfig({
        autoUpdate: {
          ...(this.config().autoUpdate || {}),
          enabled: false
        }
      });
    }
    await this.resumeNotifications();
    return this.status();
  }

  async #notifyPending() {
    const state = readAutoUpdateState(this.dataDir);
    if (!state.notification?.pending || !this.notify || !this.notifyAvailable()) return state;
    const ownerUin = String(
      state.notification.ownerUin || autoUpdateOwner(this.config())
    ).trim();
    if (!/^\d{5,15}$/.test(ownerUin)) {
      return writeAutoUpdateState(this.dataDir, {
        notification: {
          ...state.notification,
          error: '未配置有效的更新告警管理员 QQ'
        }
      });
    }
    const mode = state.mode === 'manual' ? '手动更新' : '定时更新';
    const text = [
      '【QQ Agent 更新部署失败】',
      `方式：${mode}`,
      `阶段：${state.phase || 'unknown'}`,
      ...(state.targetRevision
        ? [`目标版本：${String(state.targetRevision).slice(0, 12)}`]
        : []),
      `结果：${cleanText(state.error || '未知错误', 600)}`,
      '',
      '自动更新已停止。',
      '处理入口：控制台 → 控制 → 更新部署'
    ].join('\n');
    try {
      await this.notify(text, ownerUin);
      const updated = writeAutoUpdateState(this.dataDir, {
        notification: {
          ...state.notification,
          pending: false,
          ownerUin,
          sentAt: Date.now(),
          error: ''
        }
      });
      this.emit('auto-update', this.status());
      return updated;
    } catch (error) {
      writeAutoUpdateState(this.dataDir, {
        notification: {
          ...state.notification,
          ownerUin,
          error: cleanText(error?.message ?? error, 500)
        }
      });
      throw error;
    }
  }
}
