import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  autoUpdatePaths,
  readAutoUpdateState,
  writeAutoUpdateRequest
} from '../src/auto-update.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function writeDeployment(appDir, dataDir) {
  fs.writeFileSync(path.join(appDir, '.deployment.json'), JSON.stringify({
    root: appDir,
    data: dataDir,
    node: process.execPath,
    service: 'qq-agent-test'
  }));
}

function runUpdater({ appDir, dataDir, binDir = '', env = {}, timeout = 15000 }) {
  return spawnSync(process.execPath, [
    path.join(repo, 'scripts/auto-update.mjs'),
    '--app-dir', appDir,
    '--data-dir', dataDir,
    '--service', 'qq-agent-test'
  ], {
    cwd: repo,
    env: {
      ...process.env,
      ...(binDir ? { PATH: `${binDir}:${process.env.PATH || ''}` } : {}),
      ...env
    },
    encoding: 'utf8',
    timeout
  });
}

test('scheduled updater uses the persistent Git cache and records no-update', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-runner-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  const binDir = path.join(root, 'bin');
  const revision = 'a'.repeat(40);
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(autoUpdatePaths(dataDir).repository, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: true,
      ownerUin: '900001',
      repository: 'https://github.com/carbonbromine/qq-agent.git',
      branch: 'main',
      intervalHours: 6
    },
    server: { host: '127.0.0.1', port: 3210, token: 'token' }
  }));
  fs.writeFileSync(path.join(dataDir, 'deployed-revision'), `${revision}\n`);
  writeDeployment(appDir, dataDir);

  const fakeGit = path.join(binDir, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
args="$*"
case "$args" in
  *" remote") printf '%s\\n' 'origin' ;;
  *"remote set-url origin"*) ;;
  *" ls-remote "*) printf '%s\\t%s\\n' '${revision}' 'refs/heads/main' ;;
  *" fetch "*) ;;
  *" rev-parse "*) printf '%s\\n' '${revision}' ;;
  *) printf 'unexpected git command: %s\\n' "$args" >&2; exit 9 ;;
esac
`, { mode: 0o700 });

  const result = runUpdater({ appDir, dataDir, binDir, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);

  const state = readAutoUpdateState(dataDir);
  assert.equal(state.status, 'no-update');
  assert.equal(state.currentRevision, revision);
  assert.equal(state.targetRevision, revision);
  assert.equal(state.connectivity.status, 'ok');
  assert.equal(state.connectivity.attempts, 1);
  assert.ok(state.lastCheckAt > 0);
  assert.ok(state.completedAt >= state.lastCheckAt);
  assert.equal(fs.existsSync(autoUpdatePaths(dataDir).lock), false);
});

test('updater tests a checkout and delegates deployment with the exact revision', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-deploy-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  const binDir = path.join(root, 'bin');
  const candidate = path.join(root, 'candidate');
  const marker = path.join(root, 'deployed.txt');
  const previousRevision = 'a'.repeat(40);
  const targetRevision = 'b'.repeat(40);
  for (const directory of [
    appDir,
    dataDir,
    binDir,
    candidate,
    path.join(candidate, 'src'),
    path.join(candidate, 'scripts'),
    path.join(candidate, 'test')
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.mkdirSync(autoUpdatePaths(dataDir).repository, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: true,
      ownerUin: '900001',
      repository: 'https://github.com/carbonbromine/qq-agent.git',
      branch: 'main',
      intervalHours: 6
    },
    server: { host: '127.0.0.1', port: 3210, token: 'token' }
  }));
  fs.writeFileSync(path.join(dataDir, 'deployed-revision'), `${previousRevision}\n`);
  writeDeployment(appDir, dataDir);
  fs.writeFileSync(path.join(candidate, 'package.json'), JSON.stringify({
    name: 'qq-agent',
    type: 'module'
  }));
  fs.writeFileSync(path.join(candidate, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(candidate, 'src/server.js'), '');
  fs.writeFileSync(path.join(candidate, 'scripts/auto-update.mjs'), '');
  fs.writeFileSync(
    path.join(candidate, 'test/smoke.test.mjs'),
    "import { test } from 'node:test'; import fs from 'node:fs'; import path from 'node:path';\n"
      + "test('candidate', () => { fs.mkdirSync(process.env.QQ_AGENT_DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.QQ_AGENT_DATA_DIR, 'candidate-test-marker'), 'ok'); });\n"
  );
  fs.writeFileSync(path.join(candidate, 'deploy.sh'), `#!/bin/sh
printf '%s\\n' "$QQ_AGENT_SOURCE_REVISION" > "$FAKE_DEPLOY_MARKER"
`, { mode: 0o700 });

  const fakeGit = path.join(binDir, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
args="$*"
case "$args" in
  *" remote") printf '%s\\n' 'origin' ;;
  *"remote set-url origin"*) ;;
  *" ls-remote "*) printf '%s\\t%s\\n' '${targetRevision}' 'refs/heads/main' ;;
  *" fetch "*) ;;
  *" rev-parse "*) printf '%s\\n' '${targetRevision}' ;;
  *" checkout "*)
    work=''
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--work-tree" ]; then work="$2"; shift 2; else shift; fi
    done
    cp -R "$FAKE_CANDIDATE"/. "$work"/
    ;;
  *) printf 'unexpected git command: %s\\n' "$args" >&2; exit 9 ;;
esac
`, { mode: 0o700 });
  const fakeNpm = path.join(binDir, 'npm');
  fs.writeFileSync(fakeNpm, '#!/bin/sh\nexit 0\n', { mode: 0o700 });

  const result = runUpdater({
    appDir,
    dataDir,
    binDir,
    env: {
      QQ_AGENT_UPDATE_NPM: fakeNpm,
      FAKE_CANDIDATE: candidate,
      FAKE_DEPLOY_MARKER: marker
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), targetRevision);
  const state = readAutoUpdateState(dataDir);
  assert.equal(state.status, 'succeeded');
  assert.equal(state.currentRevision, targetRevision);
  assert.equal(state.lastSuccessAt > 0, true);
  assert.equal(state.connectivity.status, 'ok');
  assert.equal(fs.existsSync(path.join(dataDir, 'candidate-test-marker')), false);
});

test('transient GitHub TLS failures are retried before fetch', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-retry-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  const binDir = path.join(root, 'bin');
  const counter = path.join(root, 'probe-count');
  const revision = 'c'.repeat(40);
  for (const directory of [appDir, dataDir, binDir]) fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(autoUpdatePaths(dataDir).repository, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: true,
      ownerUin: '900001',
      repository: 'https://github.com/carbonbromine/qq-agent.git',
      branch: 'main',
      intervalHours: 6,
      networkRetries: 3,
      retryBaseMs: 100,
      retryMaxMs: 200,
      connectivityTimeoutSeconds: 3
    },
    server: { host: '127.0.0.1', port: 3210, token: 'token' }
  }));
  fs.writeFileSync(path.join(dataDir, 'deployed-revision'), `${revision}\n`);
  writeDeployment(appDir, dataDir);

  const fakeGit = path.join(binDir, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
args="$*"
case "$args" in
  *" remote") printf '%s\\n' 'origin' ;;
  *"remote set-url origin"*) ;;
  *" ls-remote "*)
    n=0; [ -f "$FAKE_COUNTER" ] && n=$(cat "$FAKE_COUNTER")
    n=$((n+1)); printf '%s' "$n" > "$FAKE_COUNTER"
    if [ "$n" -lt 3 ]; then printf '%s\\n' 'fatal: GnuTLS recv error (-110): TLS connection was non-properly terminated.' >&2; exit 1; fi
    printf '%s\\t%s\\n' '${revision}' 'refs/heads/main'
    ;;
  *" fetch "*) ;;
  *" rev-parse "*) printf '%s\\n' '${revision}' ;;
  *) printf 'unexpected git command: %s\\n' "$args" >&2; exit 9 ;;
esac
`, { mode: 0o700 });

  const result = runUpdater({
    appDir,
    dataDir,
    binDir,
    env: { FAKE_COUNTER: counter },
    timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(counter, 'utf8'), '3');
  const state = readAutoUpdateState(dataDir);
  assert.equal(state.status, 'no-update');
  assert.equal(state.connectivity.status, 'ok');
  assert.equal(state.connectivity.attempts, 3);
  assert.match(result.stderr, /retry 2\/4/);
});

test('probe request checks repository and branch without fetching or deploying', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-probe-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  const binDir = path.join(root, 'bin');
  const revision = 'd'.repeat(40);
  for (const directory of [appDir, dataDir, binDir]) fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(autoUpdatePaths(dataDir).repository, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: false,
      ownerUin: '',
      repository: 'https://github.com/carbonbromine/qq-agent.git',
      branch: 'feat/test-branch',
      intervalHours: 6
    },
    server: { host: '127.0.0.1', port: 3210, token: 'token' }
  }));
  writeDeployment(appDir, dataDir);
  writeAutoUpdateRequest(dataDir, 'probe');

  const fakeGit = path.join(binDir, 'git');
  fs.writeFileSync(fakeGit, `#!/bin/sh
args="$*"
case "$args" in
  *" remote") printf '%s\\n' 'origin' ;;
  *"remote set-url origin"*) ;;
  *" ls-remote "*) printf '%s\\t%s\\n' '${revision}' 'refs/heads/feat/test-branch' ;;
  *" fetch "*) printf '%s\\n' 'fetch must not run during probe' >&2; exit 21 ;;
  *" checkout "*) printf '%s\\n' 'checkout must not run during probe' >&2; exit 22 ;;
  *) printf 'unexpected git command: %s\\n' "$args" >&2; exit 9 ;;
esac
`, { mode: 0o700 });

  const result = runUpdater({ appDir, dataDir, binDir, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const state = readAutoUpdateState(dataDir);
  assert.equal(state.status, 'idle');
  assert.equal(state.mode, 'probe');
  assert.equal(state.phase, 'complete');
  assert.equal(state.connectivity.status, 'ok');
  assert.equal(state.connectivity.branch, 'feat/test-branch');
  assert.equal(state.connectivity.revision, revision);
});

test('runner failure disables future automatic updates by default and preserves a pending notice', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-failure-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: true,
      ownerUin: '900001',
      repository: 'https://example.invalid/not-allowed.git',
      branch: 'main',
      intervalHours: 6
    },
    server: { host: '127.0.0.1', port: 9, token: 'token' }
  }));
  writeDeployment(appDir, dataDir);

  const result = runUpdater({
    appDir,
    dataDir,
    env: {
      QQ_AGENT_UPDATE_NOTIFY_ATTEMPTS: '1',
      QQ_AGENT_UPDATE_NOTIFY_RETRY_MS: '10'
    },
    timeout: 5000
  });
  assert.equal(result.status, 1);

  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  const state = readAutoUpdateState(dataDir);
  assert.equal(config.autoUpdate.enabled, false);
  assert.equal(state.status, 'failed');
  assert.equal(state.autoDisabled, true);
  assert.equal(state.notification.pending, true);
  assert.equal(state.notification.ownerUin, '900001');
  assert.match(state.error, /approved GitHub HTTPS URL/);
});

test('runner failure can preserve automatic updates when disableOnFailure is false', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-update-keep-enabled-'));
  const appDir = path.join(root, 'app');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    autoUpdate: {
      enabled: true,
      ownerUin: '900001',
      repository: 'https://example.invalid/not-allowed.git',
      branch: 'main',
      intervalHours: 6,
      disableOnFailure: false
    },
    server: { host: '127.0.0.1', port: 9, token: 'token' }
  }));
  writeDeployment(appDir, dataDir);

  const result = runUpdater({
    appDir,
    dataDir,
    env: {
      QQ_AGENT_UPDATE_NOTIFY_ATTEMPTS: '1',
      QQ_AGENT_UPDATE_NOTIFY_RETRY_MS: '10'
    },
    timeout: 5000
  });
  assert.equal(result.status, 1);
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  const state = readAutoUpdateState(dataDir);
  assert.equal(config.autoUpdate.enabled, true);
  assert.equal(state.autoDisabled, false);
  assert.equal(state.notification.pending, true);
});
