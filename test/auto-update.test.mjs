import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AutoUpdateManager,
  autoUpdatePaths,
  consumeAutoUpdateRequest,
  readAutoUpdateState,
  writeAutoUpdateState
} from '../src/auto-update.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-auto-update-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(appDir, 'scripts'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'scripts/auto-update.mjs'), '');
  fs.writeFileSync(path.join(appDir, '.deployment.json'), JSON.stringify({
    root: appDir,
    data: dataDir,
    node: process.execPath,
    service: 'qq-agent-test',
    updateService: 'qq-agent-test-update'
  }));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  let config = {
    autoUpdate: {
      enabled: false,
      ownerUin: '900001',
      repository: 'https://github.com/carbonbromine/qq-agent.git',
      branch: 'main',
      intervalHours: 6,
      networkRetries: 4,
      retryBaseMs: 1500,
      retryMaxMs: 15000,
      connectivityTimeoutSeconds: 20,
      fetchTimeoutSeconds: 300,
      forceHttp11: true,
      disableOnFailure: true
    },
    allow: { private: ['900001'] },
    allowAllWhenEmpty: false
  };
  const systemctlCalls = [];
  const notifications = [];
  const manager = new AutoUpdateManager({
    appDir,
    dataDir,
    config: () => config,
    updateConfig: (patch) => {
      config = {
        ...config,
        ...patch,
        autoUpdate: { ...config.autoUpdate, ...(patch.autoUpdate || {}) }
      };
      return config;
    },
    notifyAvailable: () => true,
    notify: async (text, ownerUin) => notifications.push({ text, ownerUin }),
    runSystemctl: (args) => {
      systemctlCalls.push(args);
      return { status: args.includes('is-active') ? 3 : 0, stdout: '', stderr: '' };
    },
    log: () => {}
  });
  return {
    appDir,
    dataDir,
    get config() { return config; },
    setAutoUpdate(patch) { config.autoUpdate = { ...config.autoUpdate, ...patch }; },
    setAllowPrivate(value) { config.allow.private = value; },
    manager,
    systemctlCalls,
    notifications
  };
}

test('updater launch failure disables automation and queues an administrator notice', async (t) => {
  const f = fixture(t);
  f.manager.runSystemctl = (args) => ({
    status: args.includes('is-active') ? 3 : 1,
    stdout: '',
    stderr: 'unit failed'
  });
  f.manager.resume({ ownerUin: '900001', intervalHours: 6 });

  assert.throws(() => f.manager.requestManual(), /unit failed/);
  await f.manager.resumeNotifications();

  const state = readAutoUpdateState(f.dataDir);
  assert.equal(f.config.autoUpdate.enabled, false);
  assert.equal(state.status, 'failed');
  assert.equal(state.autoDisabled, true);
  assert.equal(state.notification.pending, false);
  assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0].text, /自动更新已停止/);
});

test('launch failure can keep automatic updates enabled by policy', async (t) => {
  const f = fixture(t);
  f.setAutoUpdate({ enabled: true, disableOnFailure: false });
  f.manager.runSystemctl = (args) => ({
    status: args.includes('is-active') ? 3 : 1,
    stdout: '',
    stderr: 'temporary unit failure'
  });

  assert.throws(() => f.manager.requestManual(), /temporary unit failure/);
  await f.manager.resumeNotifications();

  const state = readAutoUpdateState(f.dataDir);
  assert.equal(f.config.autoUpdate.enabled, true);
  assert.equal(state.autoDisabled, false);
  assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0].text, /保持启用/);
});

test('manual update queues the independent systemd updater', (t) => {
  const f = fixture(t);
  const status = f.manager.requestManual();

  assert.equal(status.status, 'queued');
  assert.equal(status.mode, 'manual');
  const request = consumeAutoUpdateRequest(f.dataDir);
  assert.equal(request.version, 1);
  assert.equal(request.mode, 'manual');
  assert.ok(Math.abs(request.requestedAt - status.startedAt) < 1000);
  assert.ok(f.systemctlCalls.some((args) =>
    args.includes('qq-agent-test-update.service') && args.includes('--no-block')));
});

test('connectivity probe is one-shot, does not require an alert owner and never changes enable state', (t) => {
  const f = fixture(t);
  f.setAutoUpdate({ enabled: false, ownerUin: '', nextAction: 'probe' });
  f.setAllowPrivate([]);

  const status = f.manager.requestManual();
  const request = consumeAutoUpdateRequest(f.dataDir);
  assert.equal(request.mode, 'probe');
  assert.equal(status.mode, 'probe');
  assert.equal(status.phase, 'connectivity');
  assert.equal(status.connectivity.status, 'queued');
  assert.equal(f.config.autoUpdate.nextAction, '');
  assert.equal(f.config.autoUpdate.enabled, false);
});

test('status exposes normalized network policy', (t) => {
  const f = fixture(t);
  f.setAutoUpdate({ networkRetries: 99, retryBaseMs: 5, disableOnFailure: false });
  const status = f.manager.status();
  assert.equal(status.networkRetries, 10);
  assert.equal(status.retryBaseMs, 100);
  assert.equal(status.disableOnFailure, false);
  assert.equal(status.forceHttp11, true);
});

test('resume and pause persist automatic update state', (t) => {
  const f = fixture(t);
  f.manager.resume({ ownerUin: '900001', intervalHours: 12 });
  assert.equal(f.config.autoUpdate.enabled, true);
  assert.equal(f.config.autoUpdate.intervalHours, 12);
  assert.equal(readAutoUpdateState(f.dataDir).status, 'idle');

  f.manager.pause();
  assert.equal(f.config.autoUpdate.enabled, false);
  assert.equal(readAutoUpdateState(f.dataDir).status, 'disabled');
});

test('pending deployment failure disables automatic updates and notifies once', async (t) => {
  const f = fixture(t);
  f.manager.resume({ ownerUin: '900001', intervalHours: 6 });
  writeAutoUpdateState(f.dataDir, {
    status: 'failed',
    mode: 'scheduled',
    phase: 'testing',
    targetRevision: 'a'.repeat(40),
    error: 'unit test failed',
    autoDisabled: true,
    notification: {
      pending: true,
      ownerUin: '900001',
      sentAt: 0,
      error: ''
    }
  });

  await f.manager.handlePendingFailure();
  await f.manager.handlePendingFailure();

  assert.equal(f.config.autoUpdate.enabled, false);
  assert.equal(f.notifications.length, 1);
  assert.equal(f.notifications[0].ownerUin, '900001');
  assert.match(f.notifications[0].text, /自动更新已停止/);
  assert.equal(readAutoUpdateState(f.dataDir).notification.pending, false);
  assert.ok(fs.existsSync(autoUpdatePaths(f.dataDir).state));
});

test('pending failure respects keep-enabled policy and still notifies once', async (t) => {
  const f = fixture(t);
  f.setAutoUpdate({ enabled: true, disableOnFailure: false });
  writeAutoUpdateState(f.dataDir, {
    status: 'failed',
    mode: 'scheduled',
    phase: 'connectivity',
    error: 'GnuTLS recv error (-110)',
    autoDisabled: false,
    notification: {
      pending: true,
      ownerUin: '900001',
      sentAt: 0,
      error: ''
    }
  });

  await f.manager.handlePendingFailure();
  await f.manager.handlePendingFailure();

  assert.equal(f.config.autoUpdate.enabled, true);
  assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0].text, /保持启用/);
  assert.equal(readAutoUpdateState(f.dataDir).notification.pending, false);
});
