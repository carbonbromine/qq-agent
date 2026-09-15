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
      intervalHours: 6
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
