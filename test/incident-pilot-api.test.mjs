import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-incident-api-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('incident infrastructure stays active and versions chat controls', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.allow.private = ['2948771712'];
  cfg.allow.groups = ['1'];
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.incidentPilot = {
    ...cfg.incidentPilot,
    ownerUin: '2948771712'
  };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.start();
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return {
      status: response.status,
      body: await response.json()
    };
  };

  const incident = app.captureIncident(new Error('API integration error'), {
    source: 'test-api',
    severity: 'error',
    chatKey: 'group:1'
  });
  assert.ok(incident.id);
  assert.equal(app.sender.onebot.selfInfo, null);

  const list = await request('/api/incidents?state=open');
  assert.equal(list.status, 200);
  assert.equal(list.body.incidents.length, 1);
  assert.equal(list.body.incidents[0].notifyState, 'pending');

  const control = await request('/api/chats/group_1/runtime-control', {
    method: 'PUT',
    body: {
      mode: 'blocked',
      reason: 'integration test',
      expectedVersion: 0,
      backlogAction: 'keep'
    }
  });
  assert.equal(control.status, 200);
  assert.equal(control.body.control.mode, 'blocked');
  const conflict = await request('/api/chats/group_1/runtime-control', {
    method: 'PUT',
    body: {
      mode: 'auto',
      expectedVersion: 0,
      backlogAction: 'keep'
    }
  });
  assert.equal(conflict.status, 409);

  const rejectedDelete = await request(`/api/incidents/${incident.id}`, {
    method: 'DELETE',
    body: { confirm: true }
  });
  assert.equal(rejectedDelete.status, 409);
  const resolved = await request(`/api/incidents/${incident.id}/resolve`, {
    method: 'POST',
    body: { resolution: 'handled in integration test' }
  });
  assert.equal(resolved.status, 200);
  const deleted = await request(`/api/incidents/${incident.id}`, {
    method: 'DELETE',
    body: { confirm: true }
  });
  assert.equal(deleted.status, 200);

  // Old clients may still submit the removed switch. The stable config facade
  // must canonicalize it back to enabled, and the API must stay operational.
  const attemptedDisable = await request('/api/config', {
    method: 'POST',
    body: { incidentPilot: { enabled: false } }
  });
  assert.equal(attemptedDisable.status, 200);
  assert.equal(attemptedDisable.body.config.incidentPilot.enabled, true);

  const stillActive = await request('/api/incidents');
  assert.equal(stillActive.status, 200);
  assert.equal(stillActive.body.status.active, true);
  const restoredControl = await request('/api/chats/group_1/runtime-control', {
    method: 'PUT',
    body: { mode: 'auto', expectedVersion: 1, backlogAction: 'keep' }
  });
  assert.equal(restoredControl.status, 200);
  assert.equal(restoredControl.body.control.mode, 'auto');
});
