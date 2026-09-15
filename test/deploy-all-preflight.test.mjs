import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shellOptions = { skip: process.getuid?.() === 0 ? 'Installer must run as a non-root service user' : false };

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qq-stack-preflight-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'stack');
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  const source = path.join(dir, 'source');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  for (const file of ['deploy-all.sh', 'scripts/check-stack-update.mjs', 'scripts/configure-snowluma.mjs']) {
    fs.copyFileSync(path.join(repo, file), path.join(source, file));
  }
  fs.writeFileSync(path.join(source, 'deploy.sh'), '#!/bin/bash\nexit 0\n');
  fs.writeFileSync(path.join(source, 'scripts/rotate-snowluma-password.mjs'), 'throw new Error("Unexpected credential rotation");\n');
  const stateFile = path.join(dir, 'host.json');
  const callsFile = path.join(dir, 'calls.jsonl');
  const host = { service: 'not-found', workingDirectory: path.join(root, 'app'), containers: [], listeners: [] };
  // Host commands never reach the real daemon, package manager or systemd.
  // Write-shaped calls are rejected unless testing an allowed managed update.
  const mock = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const name = path.basename(process.argv[1]);
const state = JSON.parse(fs.readFileSync(process.env.QQ_PREFLIGHT_FIXTURE));
fs.appendFileSync(process.env.QQ_PREFLIGHT_CALLS, JSON.stringify([name, ...args]) + '\\n');
const out = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value));
if (name === 'uname') out('Linux');
else if (name === 'realpath') out(path.resolve(args.at(-1)));
else if (name === 'systemctl') {
  if (args.includes('show-environment')) process.exit(0);
  else if (args.includes('--property=LoadState')) {
    out(state.service);
    if (state.loadFailed) process.exit(1);
  }
  else if (args.includes('--property=WorkingDirectory')) out(state.workingDirectory);
  else if (args.includes('is-active')) process.exit(state.running ? 0 : 3);
  else if (state.allowMockWrites && args.includes('restart')) process.exit(0);
  else process.exit(90);
} else if (name === 'docker') {
  if (state.dockerDenied) process.exit(1);
  if (args[0] === 'info') process.exit(0);
  else if (args[0] === 'ps') {
    if (state.inventoryFailed) process.exit(1);
    for (const c of state.containers) out([c.Id, c.Name.slice(1), c.Config.Image].join('|'));
  } else if (args[0] === 'inspect') {
    const c = state.containers.find((c) => c.Id === args.at(-1));
    if (!c) process.exit(1);
    if (args.includes('--format')) {
      if (c.State.Running) {
        for (const ports of Object.values(c.HostConfig.PortBindings)) for (const port of ports) out(port.HostPort);
      }
    } else out([c]);
  } else if (args[0] === 'compose' && args.includes('config')) out(state.compose);
  else if (state.allowMockWrites && (args[0] === 'pull' || args[0] === 'compose')) process.exit(0);
  else process.exit(90);
} else if (name === 'ss') {
  if (state.ssFailed) process.exit(1);
  for (const port of state.listeners) out('LISTEN 0 511 0.0.0.0:' + port + ' 0.0.0.0:*');
} else if (name === 'curl' && state.allowMockWrites) process.exit(0);
else process.exit(90);
`;
  for (const name of ['uname', 'realpath', 'systemctl', 'docker', 'ss', 'sudo', 'curl']) {
    fs.writeFileSync(path.join(bin, name), mock, { mode: 0o755 });
  }
  function run(args = ['--check-only']) {
    fs.writeFileSync(stateFile, JSON.stringify(host));
    return spawnSync('/bin/bash', [path.join(source, 'deploy-all.sh'), '--root-dir', root, ...args], {
      cwd: source,
      env: {
        HOME: home, PATH: `${bin}:/usr/bin:/bin`,
        QQ_PREFLIGHT_FIXTURE: stateFile, QQ_PREFLIGHT_CALLS: callsFile
      },
      encoding: 'utf8',
      timeout: 15_000
    });
  }
  return { root, host, run, callsFile };
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data), { mode: 0o600 });
}

function managed(f) {
  const { root, host } = f;
  const env = {
    SNOWLUMA_IMAGE: 'motricseven7/snowluma:v1.14.15',
    SNOWLUMA_CONTAINER: 'qq-agent-snowluma',
    QQ_AGENT_SERVICE: 'qq-agent-linux',
    AGENT_PORT: '3210',
    SNOWLUMA_WEBUI_HOST_PORT: '5099',
    NOVNC_PORT: '6081',
    ONEBOT_HTTP_PORT: '3000',
    ONEBOT_WS_PORT: '3001',
    ONEBOT_TOKEN: 'onebot-token-do-not-print',
    QQ_AGENT_CONSOLE_TOKEN: 'console-token-do-not-print',
    SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD: 'Secret!Password123',
    VNC_PASSWD: 'abcdef12'
  };
  write(path.join(root, 'snowluma/.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  write(path.join(root, 'app/.deployment.json'), {
    root: path.join(root, 'app'), data: path.join(root, 'data'), node: process.execPath, service: 'qq-agent-linux'
  });
  write(path.join(root, 'app/.deployment-node'), `${process.execPath}\n`);
  write(path.join(root, 'data/config.json'), {
    runtime: { mode: 'active', paused: false },
    server: { host: '0.0.0.0', port: 3210, token: env.QQ_AGENT_CONSOLE_TOKEN },
    onebot: {
      httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001',
      accessToken: env.ONEBOT_TOKEN, httpAccessToken: env.ONEBOT_TOKEN
    }
  });
  const volumes = [
    ['data', '/app/data'], ['client-config', '/app/.config'], ['client-data', '/app/.local/share']
  ].map(([source, target]) => ({ type: 'bind', source: path.join(root, 'snowluma', source), target }));
  const ports = [
    [3000, '127.0.0.1'], [3001, '127.0.0.1'], [5099, '0.0.0.0'], [6081, '0.0.0.0']
  ].map(([target, host_ip]) => ({ target, host_ip, published: String(target), protocol: 'tcp' }));
  host.compose = { services: { snowluma: {
    image: env.SNOWLUMA_IMAGE, container_name: env.SNOWLUMA_CONTAINER,
    volumes, ports, environment: { VNC_PASSWD: env.VNC_PASSWD, SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD: env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD }
  } } };
  write(path.join(root, 'snowluma/docker-compose.yml'), host.compose);
  host.service = 'loaded';
  host.running = true;
  host.containers = [{
    Id: 'abc123', Name: '/qq-agent-snowluma', State: { Running: true },
    Config: {
      Image: env.SNOWLUMA_IMAGE,
      Labels: { 'com.docker.compose.project.working_dir': path.join(root, 'snowluma'), 'com.docker.compose.service': 'snowluma' }
    },
    Mounts: volumes.map((v) => ({ Type: v.type, Source: v.source, Destination: v.target })),
    HostConfig: { PortBindings: Object.fromEntries(ports.map((p) => [`${p.target}/tcp`, [{ HostPort: p.published, HostIp: p.host_ip }]])) }
  }];
  host.listeners = [3210, 3000, 3001, 5099, 6081];
}

function snapshot(root) {
  if (!fs.existsSync(root)) return null;
  const result = {};
  function visit(file) {
    const stat = fs.lstatSync(file);
    result[path.relative(root, file)] = {
      mode: stat.mode, mtime: stat.mtimeMs,
      content: stat.isFile() ? fs.readFileSync(file, 'base64') : null
    };
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(file, name));
  }
  visit(root);
  return result;
}

function protectedRun(f, pattern, args = ['--check-only']) {
  const before = snapshot(f.root);
  const result = f.run(args);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, pattern);
  assert.deepEqual(snapshot(f.root), before, 'No contents, permissions or timestamps may change on refusal');
  assert.doesNotMatch(result.stdout + result.stderr, /onebot-token-do-not-print|console-token-do-not-print|Secret!Password123/);
  const calls = fs.existsSync(f.callsFile)
    ? fs.readFileSync(f.callsFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
  assert.ok(!calls.some(([name, ...args]) =>
    (name === 'sudo' && args.join(' ') !== '-n docker info')
    || name === 'curl' || (name === 'docker' && args[0] === 'pull')
    || (name === 'systemctl' && args.some((arg) => ['restart', 'start', 'stop', 'enable'].includes(arg)))));
}

test('legacy production state is refused before credentials, dependencies or services change', shellOptions, (t) => {
  const f = fixture(t);
  write(path.join(f.root, 'data/config.json'), {
    runtime: { mode: 'active' },
    onebot: { httpUrl: 'http://127.0.0.1:13000', wsUrl: 'ws://127.0.0.1:13001', accessToken: 'production-token' }
  });
  write(path.join(f.root, 'app/.deployment.json'), { service: 'qq-agent-linux' });
  protectedRun(f, /without managed stack metadata/, ['--yes', '--rotate-credentials', '--skip-model-config']);
  assert.ok(!fs.existsSync(path.join(f.root, 'snowluma')));
});

test('a lone .env never implies a managed installation', shellOptions, (t) => {
  const f = fixture(t);
  write(path.join(f.root, 'snowluma/.env'), 'ONEBOT_TOKEN=onebot-token-do-not-print\n');
  protectedRun(f, /incomplete managed stack/);
});

test('leftover QQ login data is protected even without any Agent configuration', shellOptions, (t) => {
  const f = fixture(t);
  write(path.join(f.root, 'snowluma/client-data/login.json'), '{"session":"existing"}');
  protectedRun(f, /without managed stack metadata/);
});

test('fresh preflight succeeds without creating the stack or asking for model credentials', shellOptions, (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Environment: fresh installation/);
  assert.equal(snapshot(f.root), null);
});

test('pre-created empty data directories do not count as an existing installation', shellOptions, (t) => {
  const f = fixture(t);
  for (const name of ['data', 'app/data', 'snowluma']) fs.mkdirSync(path.join(f.root, name), { recursive: true });
  const before = snapshot(f.root);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Environment: fresh installation/);
  assert.deepEqual(snapshot(f.root), before);
});

test('a not-found service reported with nonzero exit still permits fresh installation', shellOptions, (t) => {
  const f = fixture(t);
  f.host.loadFailed = true;
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Environment: fresh installation/);
  assert.equal(snapshot(f.root), null);
});

test('a managed stack may be checked repeatedly with all of its own ports occupied', shellOptions, (t) => {
  const f = fixture(t);
  managed(f);
  const before = snapshot(f.root);
  for (let i = 0; i < 2; i++) {
    const result = f.run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Environment: managed stack/);
    assert.deepEqual(snapshot(f.root), before);
  }
});

test('ordinary managed update does not attempt password rotation and preserves Agent configuration', shellOptions, (t) => {
  const f = fixture(t);
  managed(f);
  f.host.allowMockWrites = true;
  const configFile = path.join(f.root, 'data/config.json');
  const before = fs.readFileSync(configFile, 'utf8');
  const result = f.run(['--yes']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Deployment complete. Agent mode: active/);
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);
  assert.doesNotMatch(result.stderr, /credential rotation/);
});

test('a managed stack with a stopped container and Agent can be updated', shellOptions, (t) => {
  const f = fixture(t);
  managed(f);
  f.host.running = false;
  f.host.containers[0].State.Running = false;
  f.host.listeners = [];
  const before = snapshot(f.root);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(snapshot(f.root), before);
});

for (const [name, mutate, pattern] of [
  ['external SnowLuma at another root', (f) => {
    f.host.containers = [{ Id: 'external', Name: '/qq-bridge-snowluma', Config: { Image: 'motricseven7/snowluma:v1.14.15' } }];
  }, /external QQ gateway container/],
  ['pre-existing Agent service', (f) => { f.host.service = 'loaded'; }, /qq-agent-linux.service already exists/],
  ['Nginx on the selected WebUI port', (f) => { f.host.listeners = [5099]; }, /port 5099 is already in use/],
  ['failed Docker inventory', (f) => { f.host.inventoryFailed = true; }, /container inventory is unavailable/],
  ['inaccessible Docker daemon', (f) => { f.host.dockerDenied = true; }, /containers cannot be inspected/],
  ['failed service inspection', (f) => {
    f.host.service = '';
    f.host.loadFailed = true;
  }, /Cannot inspect the selected systemd service/],
  ['unavailable port inventory', (f) => { f.host.ssFailed = true; }, /Cannot inspect listening ports/]
]) {
  test(`preflight protects ${name}`, shellOptions, (t) => {
    const f = fixture(t);
    mutate(f);
    protectedRun(f, pattern);
  });
}

for (const [name, mutate, pattern] of [
  ['service directory', (f) => { f.host.workingDirectory = '/different/app'; }, /another application directory/],
  ['container project', (f) => {
    f.host.containers[0].Config.Labels['com.docker.compose.project.working_dir'] = '/home/sourcecode/apps';
  }, /another Compose project/],
  ['container volumes', (f) => { f.host.containers[0].Mounts[0].Type = 'volume'; }, /different installation/],
  ['unrelated Compose services', (f) => { f.host.compose.services.database = {}; }, /unrelated services/],
  ['Compose volume source', (f) => {
    f.host.compose.services.snowluma.volumes[0].source = '/different/data';
  }, /different installation/],
  ['changed live Token', (f) => {
    const file = path.join(f.root, 'data/config.json');
    const config = JSON.parse(fs.readFileSync(file));
    config.server.token = 'changed-by-admin';
    write(file, config);
  }, /Console credentials have changed/],
  ['production OneBot endpoints', (f) => {
    const file = path.join(f.root, 'data/config.json');
    const config = JSON.parse(fs.readFileSync(file));
    config.onebot.httpUrl = 'http://127.0.0.1:13000';
    write(file, config);
  }, /different OneBot endpoints/],
  ['corrupt configuration', (f) => {
    write(path.join(f.root, 'data/config.json'), '{"token":"onebot-token-do-not-print');
  }, /Malformed deployment metadata/]
]) {
  test(`managed preflight refuses mismatched ${name} without writing`, shellOptions, (t) => {
    const f = fixture(t);
    managed(f);
    mutate(f);
    protectedRun(f, pattern);
  });
}
