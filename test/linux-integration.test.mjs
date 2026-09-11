import assert from 'node:assert/strict';
import { it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-linux-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { DEFAULT_CONFIG, updateConfig } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

it('protects console APIs, redacts credentials and blocks all sending in observe mode', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, port, token: 'console-test-secret' };
  cfg.allow.groups = ['123'];
  cfg.api.apiKey = 'provider-test-secret';
  cfg.snowluma.wsUrl = 'ws://127.0.0.1:1';
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); });
  let sends = 0;
  app.onebot.sendText = async () => { sends++; return { message_id: 1 }; };
  await app.start();
  const request = (route, body, headers = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  assert.equal((await request('/api/status')).status, 401);
  assert.equal((await request('/api/login', { token: 'wrong' })).status, 401);
  const login = await request('/api/login', { token: cfg.server.token });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.ok(cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict'));
  const headers = { cookie: cookie.split(';')[0] };
  const saved = await (await request('/api/config', { runtime: { mode: 'active' }, ui: { theme: 'light' } }, headers)).json();
  assert.equal(saved.config.runtime.mode, 'observe');
  assert.equal(saved.config.server.token, undefined);
  assert.equal(saved.config.api.apiKey, undefined);
  assert.ok(!JSON.stringify(saved).includes('provider-test-secret'));
  assert.equal((await request('/api/config', {}, { ...headers, origin: 'https://attacker.invalid' })).status, 401);
  assert.equal((await request('/api/runtime', { mode: 'active' }, headers)).status, 409);
  assert.equal((await request('/api/chats/group_123/test-send', { text: 'must not send' }, headers)).status, 502);
  assert.equal(sends, 0);
  const state = await (await request('/api/status', null, headers)).json();
  assert.equal(state.orchestrator.mode, 'observe');
});

it('persists mode, starts headless and exits cleanly on SIGTERM', async (t) => {
  const port = await freePort();
  updateConfig({ server: { port }, runtime: { mode: 'observe' } });
  const child = spawn(process.execPath, ['src/server.js'], { cwd: process.cwd(),
    env: { ...process.env, QQ_AGENT_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (v) => { output += v; });
  child.stderr.on('data', (v) => { output += v; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const until = Date.now() + 5000;
  let ready = false;
  while (Date.now() < until) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, output);
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(signal, null);
  assert.equal(code, 0, output);
});

process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
