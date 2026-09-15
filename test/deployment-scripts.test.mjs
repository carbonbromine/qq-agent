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

test('deploy script verifies and rolls back the update service and timer', () => {
  const source = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  assert.match(source, /scripts\/auto-update\.mjs/);
  assert.match(source, /UPDATE_SERVICE="\$\{SERVICE\}-update"/);
  assert.match(source, /systemd-analyze --user verify "\$UPDATE_UNIT_FILE"/);
  assert.match(source, /systemctl --user enable --now "\$UPDATE_SERVICE\.timer"/);
  assert.match(source, /cp -p "\$LOCK_DIR\/state\/update\.service" "\$UPDATE_UNIT_FILE"/);
  assert.match(source, /QQ_AGENT_SOURCE_REVISION/);
});

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

test('configure-linux accepts full-stack credentials and OneBot endpoints', (t) => {
  const dataDir = tempDir(t, 'qq-full-deploy-config-');
  const result = runNode(path.join(repo, 'scripts/configure-linux.mjs'), [
    '--data-dir', dataDir,
    '--host', '0.0.0.0',
    '--port', '43212'
  ], {
    env: {
      ...process.env,
      QQ_AGENT_CONSOLE_TOKEN: 'agent-console-token-1234',
      QQ_AGENT_ONEBOT_TOKEN: 'onebot-ws-token-1234',
      QQ_AGENT_ONEBOT_HTTP_TOKEN: 'onebot-http-token-1234',
      QQ_AGENT_ONEBOT_WS_URL: 'ws://127.0.0.1:33001',
      QQ_AGENT_ONEBOT_HTTP_URL: 'http://127.0.0.1:33000',
      QQ_AGENT_MODEL_BASE_URL: 'https://model.example/v1',
      QQ_AGENT_MODEL_API_KEY: 'model-secret',
      QQ_AGENT_MODEL: 'model-name',
      QQ_AGENT_ALLOW_GROUPS: '123,456',
      QQ_AGENT_ALLOW_PRIVATE: '789'
    }
  });
  assert.equal(result.status, 0, result.stderr);

  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  assert.equal(config.server.token, 'agent-console-token-1234');
  assert.equal(config.onebot.wsUrl, 'ws://127.0.0.1:33001');
  assert.equal(config.onebot.httpUrl, 'http://127.0.0.1:33000');
  assert.equal(config.onebot.accessToken, 'onebot-ws-token-1234');
  assert.equal(config.onebot.httpAccessToken, 'onebot-http-token-1234');
  assert.equal(config.api.baseUrl, 'https://model.example/v1');
  assert.equal(config.api.apiKey, 'model-secret');
  assert.equal(config.api.model, 'model-name');
  assert.deepEqual(config.allow.groups, ['123', '456']);
  assert.deepEqual(config.allow.private, ['789']);
});

test('configure-snowluma synchronizes global and per-account server tokens', (t) => {
  const dataDir = tempDir(t, 'qq-snowluma-config-');
  const configDir = path.join(dataDir, 'config');
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'onebot_12345.json'), JSON.stringify({
    mode: 'snapshot',
    networks: {
      httpServers: [{ name: 'custom-http', host: '127.0.0.1', port: 3100 }],
      wsServers: [{ name: 'custom-ws', host: '127.0.0.1', port: 3101, role: 'Event' }]
    }
  }));

  const result = runNode(path.join(repo, 'scripts/configure-snowluma.mjs'), [
    '--data-dir', dataDir,
    '--token', 'shared-onebot-token-1234',
    '--http-port', '3000',
    '--ws-port', '3001'
  ]);
  assert.equal(result.status, 0, result.stderr);

  for (const name of ['onebot.json', 'onebot_12345.json']) {
    const config = JSON.parse(fs.readFileSync(path.join(configDir, name), 'utf8'));
    assert.equal(config.networks.httpServers[0].host, '0.0.0.0');
    assert.equal(config.networks.httpServers[0].port, 3000);
    assert.equal(config.networks.httpServers[0].accessToken, 'shared-onebot-token-1234');
    assert.equal(config.networks.wsServers[0].host, '0.0.0.0');
    assert.equal(config.networks.wsServers[0].port, 3001);
    assert.equal(config.networks.wsServers[0].accessToken, 'shared-onebot-token-1234');
  }
  assert.ok(fs.existsSync(path.join(configDir, 'onebot_12345.json.bak')));
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
      QQ_SERVICE: 'qq-agent-test',
      QQ_SNOWLUMA_WEBUI_URL: 'http://127.0.0.1:15099'
    }
  });
  assert.equal(install.status, 0, install.stderr);
  assert.equal(fs.readFileSync(path.join(root, '.deployment-node'), 'utf8'), `${fakeNode}\n`);
  assert.equal(fs.statSync(path.join(root, '.deployment-node')).mode & 0o777, 0o600);
  const unit = fs.readFileSync(path.join(home, '.config/systemd/user/qq-agent-test.service'), 'utf8');
  assert.match(unit, /Environment="SNOWLUMA_WEBUI_URL=http:\/\/127\.0\.0\.1:15099"/);
  const updateUnit = fs.readFileSync(
    path.join(home, '.config/systemd/user/qq-agent-test-update.service'),
    'utf8'
  );
  const updateTimer = fs.readFileSync(
    path.join(home, '.config/systemd/user/qq-agent-test-update.timer'),
    'utf8'
  );
  assert.match(updateUnit, /scripts\/auto-update\.mjs/);
  assert.match(updateUnit, /TimeoutStartSec=30min/);
  assert.match(updateTimer, /OnUnitInactiveSec=1h/);
  assert.match(updateTimer, /RandomizedDelaySec=10min/);
  const deployment = JSON.parse(fs.readFileSync(path.join(root, '.deployment.json'), 'utf8'));
  assert.equal(deployment.updateService, 'qq-agent-test-update');
  assert.equal(deployment.repository, 'https://github.com/carbonbromine/qq-agent.git');
  assert.equal(deployment.branch, 'main');

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
