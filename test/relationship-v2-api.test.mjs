import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-relationship-v2-api-'));
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

test('relationship V2 API owns its lifecycle and preserves data while disabled', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.relationshipV2 = {
    ...cfg.relationshipV2,
    enabled: true,
    autoEvaluationEnabled: false,
    behaviorInjectionEnabled: false
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
    return { status: response.status, body: await response.json() };
  };

  const status = await request('/api/relationship-v2/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.active, true);
  assert.equal(status.body.shadowMode, true);
  assert.equal(status.body.database, 'relationship-v2.sqlite');

  const list = await request('/api/relationships');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.relationships, []);

  const disabled = await request('/api/config', {
    method: 'POST',
    body: { relationshipV2: { enabled: false } }
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.config.relationshipV2.enabled, false);

  const disabledStatus = await request('/api/relationship-v2/status');
  assert.equal(disabledStatus.status, 200);
  assert.equal(disabledStatus.body.active, false);
  assert.equal(fs.existsSync(path.join(root, 'relationship-v2.sqlite')), true);

  const rejected = await request('/api/relationship-v2/evaluations', {
    method: 'POST',
    body: { userId: '12345' }
  });
  assert.equal(rejected.status, 409);
});
