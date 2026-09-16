import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-auto-update-api-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');
const { consumeAutoUpdateRequest } = await import('../src/auto-update.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('console routes updater administrator aliases into global admin', async (t) => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-auto-update-app-'));
  fs.mkdirSync(path.join(appDir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'scripts/auto-update.mjs'), '');
  fs.writeFileSync(path.join(appDir, '.deployment.json'), JSON.stringify({
    root: appDir,
    data: dataDir,
    node: process.execPath,
    service: 'qq-agent-api',
    updateService: 'qq-agent-api-update'
  }));
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));

  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = {
    ...cfg.server,
    host: '127.0.0.1',
    port,
    token: 'auto-update-console-token'
  };
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.allow.private = [];
  updateConfig(cfg);

  const systemctlCalls = [];
  const app = createApp({
    log: () => {},
    autoUpdateOptions: {
      appDir,
      runSystemctl: (args) => {
        systemctlCalls.push(args);
        return { status: args.includes('is-active') ? 3 : 0, stdout: '', stderr: '' };
      }
    }
  });
  await app.start();
  t.after(async () => app.stop());

  const request = async (route, method = 'GET', body = null) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-console-token': cfg.server.token
      },
      body: body ? JSON.stringify(body) : undefined
    });
    return { response, body: await response.json() };
  };

  const initial = await request('/api/auto-update/status');
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.installed, true);
  assert.equal(initial.body.enabled, false);
  assert.equal(initial.body.ownerUin, '');

  // ownerUin is kept as a backwards-compatible endpoint argument, but its
  // value must be persisted exclusively as config.admin.ownerUin.
  const settings = await request('/api/auto-update/settings', 'PUT', {
    ownerUin: '900001',
    intervalHours: 12
  });
  assert.equal(settings.response.status, 200);
  assert.equal(settings.body.status.intervalHours, 12);
  assert.equal(settings.body.status.ownerUin, '900001');

  const afterSettings = await request('/api/config');
  assert.equal(afterSettings.body.admin.ownerUin, '900001');
  assert.ok(afterSettings.body.allow.private.includes('900001'));
  assert.equal(afterSettings.body.autoUpdate.ownerUin, '900001');

  const resumed = await request('/api/auto-update/resume', 'POST', {
    confirm: true,
    intervalHours: 12
  });
  assert.equal(resumed.response.status, 200);
  assert.equal(resumed.body.status.enabled, true);
  assert.equal(resumed.body.status.ownerUin, '900001');

  const paused = await request('/api/auto-update/pause', 'POST', { confirm: true });
  assert.equal(paused.response.status, 200);
  assert.equal(paused.body.status.enabled, false);

  const manual = await request('/api/auto-update/run', 'POST', { confirm: true });
  assert.equal(manual.response.status, 202);
  assert.equal(manual.body.status.status, 'queued');
  assert.equal(consumeAutoUpdateRequest(dataDir).mode, 'manual');
  assert.ok(systemctlCalls.some((args) =>
    args.includes('qq-agent-api-update.service') && args.includes('--no-block')));
});

process.on('exit', () => fs.rmSync(dataDir, { recursive: true, force: true }));
