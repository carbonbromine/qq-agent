import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { backup, DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deploy = JSON.parse(fs.readFileSync(path.join(root, '.deployment.json'), 'utf8'));
const cfg = JSON.parse(fs.readFileSync(path.join(deploy.data, 'config.json'), 'utf8'));
const command = process.argv[2] || 'status';
const systemctl = (action) => {
  const r = spawnSync('systemctl', ['--user', action, `${deploy.service}.service`, '--no-pager'], { stdio: 'inherit' });
  process.exitCode = r.status || 0;
};
const host = cfg.server.host === '0.0.0.0' ? '127.0.0.1' : cfg.server.host;
const base = `http://${host}:${cfg.server.port}`;
async function api(route, body) {
  const res = await fetch(base + route, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-console-token': cfg.server.token },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000)
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`);
  return result;
}
if (['start', 'stop', 'restart', 'status'].includes(command)) {
  systemctl(command);
} else if (command === 'logs') {
  spawnSync('journalctl', ['--user', '-u', `${deploy.service}.service`, '-n', '100', '--no-pager'], { stdio: 'inherit' });
} else if (command === 'token') {
  console.log(cfg.server.token);
} else if (command === 'observe' || command === 'activate') {
  const active = command === 'activate';
  const confirm = process.argv.includes('--confirm-exclusive');
  if (active && !confirm) throw new Error('Stop/exclude the old instance first, then use activate --confirm-exclusive');
  console.log(await api('/api/runtime', { mode: active ? 'active' : 'observe',
    confirmExclusive: confirm, skipBacklog: active && !process.argv.includes('--with-backlog') }));
} else if (command === 'health') {
  console.log(JSON.stringify(await api('/api/status'), null, 2));
} else if (command === 'retry-failed' || command === 'resolve-held') {
  const key = process.argv[3];
  if (!/^(group|private):\d+$/.test(key || '') || !process.argv.includes('--confirm')) {
    throw new Error(`${command} group:123 --confirm (resolve-held acknowledges reviewed delivery; it does not resend)`);
  }
  console.log(await api(`/api/chats/${key.replace(':', '_')}/${command}`, { confirm: true }));
} else if (command === 'backup') {
  const target = process.argv[3];
  if (!target || fs.existsSync(target)) throw new Error('Provide a new backup directory');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(deploy.data, 'messages.sqlite'), { readOnly: true });
  try { await backup(db, path.join(target, 'messages.sqlite')); } finally { db.close(); }
  for (const name of ['config.json', 'memory', 'sessions', 'stickers.json']) {
    const source = path.join(deploy.data, name);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(target, name), { recursive: true });
  }
  console.log(`Backup saved to ${target}`);
} else {
  throw new Error('Commands: status start stop restart logs health token observe activate retry-failed resolve-held backup');
}
