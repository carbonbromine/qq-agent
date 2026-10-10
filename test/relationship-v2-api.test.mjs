import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-relationship-retired-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');
async function port() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
test('relationship V2 cannot be reenabled and old API routes are removed', async (t) => {
  const p = await port();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port: p, token: '' };
  cfg.runtime.mode = 'observe';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  const file = path.join(dir, 'relationship-v2.sqlite');
  fs.writeFileSync(file, 'historical bytes');
  cfg.relationshipV2 = { enabled: true, graduated: true, behaviorInjectionEnabled: true };
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await app.start();
  async function request(route, method = 'GET', body) {
    const res = await fetch(`http://127.0.0.1:${p}${route}`, {
      method, headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: await res.json() };
  }
  assert.deepEqual((await request('/api/config')).body.relationshipV2, { enabled: false, graduated: false });
  assert.deepEqual((await request('/api/config', 'POST', { relationshipV2: { enabled: true } })).body.config.relationshipV2, { enabled: false, graduated: false });
  for (const route of ['/api/relationship-v2/status', '/api/relationships', '/api/relationship-v2/events', '/api/relationship-v2/jobs']) assert.equal((await request(route)).status, 404);
  assert.equal((await request('/api/relationship-v2/evaluations', 'POST', { userId: '12345' })).status, 404);
  assert.equal(fs.readFileSync(file, 'utf8'), 'historical bytes');
});
