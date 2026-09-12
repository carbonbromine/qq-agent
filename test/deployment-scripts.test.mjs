import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runNode(script, args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repo,
    encoding: 'utf8',
    ...options
  });
}

test('configure-linux creates observe config and preserves runtime mode on update', (t) => {
  const dataDir = tempDir(t, 'qq-deploy-config-');
  const script = path.join(repo, 'scripts/configure-linux.mjs');
  const first = runNode(script, [
    '--data-dir', dataDir,
    '--host', '127.0.0.1',
    '--port', '43210'
  ]);
  assert.equal(first.status, 0, first.stderr);

  const configFile = path.join(dataDir, 'config.json');
  const initial = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(initial.runtime.mode, 'observe');
  assert.equal(initial.server.host, '127.0.0.1');
  assert.equal(initial.server.port, 43210);
  assert.ok(initial.server.token.length >= 32);
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);

  initial.runtime.mode = 'active';
  fs.writeFileSync(configFile, JSON.stringify(initial), { mode: 0o600 });
  const second = runNode(script, [
    '--data-dir', dataDir,
    '--host', '0.0.0.0',
    '--port', '43211'
  ]);
  assert.equal(second.status, 0, second.stderr);

  const updated = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(updated.runtime.mode, 'active');
  assert.equal(updated.server.host, '0.0.0.0');
  assert.equal(updated.server.port, 43211);
  assert.equal(updated.server.token, initial.server.token);
});

test('installed manage launcher uses the exact deployed Node runtime', (t) => {
  const root = tempDir(t, 'qq-deploy-root-');
  const home = tempDir(t, 'qq-deploy-home-');
  const data = path.join(root, 'data');
  const capture = path.join(root, 'node-invocation.txt');
  const fakeNode = path.join(root, 'private-node');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.copyFileSync(path.join(repo, 'manage.sh'), path.join(root, 'manage.sh'));
  fs.writeFileSync(path.join(root, 'scripts/manage.mjs'), '');
  fs.writeFileSync(fakeNode, `#!/bin/sh\nprintf '%s\\n' "$@" > "${capture}"\n`, { mode: 0o700 });

  const install = runNode(path.join(repo, 'scripts/install-service.mjs'), [], {
    env: {
      ...process.env,
      HOME: home,
      QQ_INSTALL_DIR: root,
      QQ_DATA_DIR: data,
      QQ_NODE: fakeNode,
      QQ_SERVICE: 'qq-agent-test'
    }
  });
  assert.equal(install.status, 0, install.stderr);
  assert.equal(fs.readFileSync(path.join(root, '.deployment-node'), 'utf8'), `${fakeNode}\n`);
  assert.equal(fs.statSync(path.join(root, '.deployment-node')).mode & 0o777, 0o600);

  const manage = spawnSync('/bin/bash', [path.join(root, 'manage.sh'), 'health'], {
    cwd: root,
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    encoding: 'utf8'
  });
  assert.equal(manage.status, 0, manage.stderr);
  assert.deepEqual(
    fs.readFileSync(capture, 'utf8').trim().split('\n'),
    ['scripts/manage.mjs', 'health']
  );
});
