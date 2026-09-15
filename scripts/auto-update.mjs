import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  autoUpdateOwner,
  autoUpdatePaths,
  consumeAutoUpdateRequest,
  readAutoUpdateState,
  sanitizeUpdateError,
  writeAutoUpdateState
} from '../src/auto-update.js';

const { values } = parseArgs({
  options: {
    'app-dir': { type: 'string' },
    'data-dir': { type: 'string' },
    service: { type: 'string' }
  }
});

const appDir = path.resolve(values['app-dir'] || path.resolve(import.meta.dirname, '..'));
const dataDir = path.resolve(values['data-dir'] || process.env.QQ_AGENT_DATA_DIR || path.join(appDir, 'data'));
const service = String(values.service || '').trim();
if (!service || !/^[A-Za-z0-9_-]+$/.test(service)) {
  throw new Error('--service is required and must be a valid systemd unit prefix');
}

const paths = autoUpdatePaths(dataDir);
const configFile = path.join(dataDir, 'config.json');
const deploymentFile = path.join(appDir, '.deployment.json');
let lockHandle = null;
let workDir = '';
let phase = 'startup';
let mode = 'scheduled';
let targetRevision = '';
const notifyAttempts = Math.min(
  30,
  Math.max(1, Number(process.env.QQ_AGENT_UPDATE_NOTIFY_ATTEMPTS) || 30)
);
const notifyRetryMs = Math.min(
  10_000,
  Math.max(10, Number(process.env.QQ_AGENT_UPDATE_NOTIFY_RETRY_MS) || 1_000)
);

function readObject(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid object: ${path.basename(file)}`);
  }
  return parsed;
}

function writeObject(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}

function command(binary, args, {
  cwd = appDir,
  env = process.env,
  timeout = 20 * 60 * 1000,
  allowFailure = false
} = {}) {
  const result = spawnSync(binary, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 24 * 1024 * 1024
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (allowFailure) return result;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(-2000);
    throw new Error(`${path.basename(binary)} ${args[0] || ''} failed`
      + `${detail ? `: ${detail}` : ` with exit ${result.status}`}`);
  }
  return result;
}

function git(args, options = {}) {
  return command('git', args, options);
}

function revisionFromFile() {
  try {
    return fs.readFileSync(path.join(dataDir, 'deployed-revision'), 'utf8')
      .trim()
      .replace(/-dirty$/, '');
  } catch {
    return '';
  }
}

function acquireLock() {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    lockHandle = fs.openSync(paths.lock, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let owner = {};
    try { owner = readObject(paths.lock); } catch { /* stale lock */ }
    const pid = Number(owner.pid) || 0;
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        throw Object.assign(
          new Error(`Another update process is running (${pid})`),
          { code: 'UPDATE_BUSY' }
        );
      } catch (signalError) {
        if (signalError?.code !== 'ESRCH') throw signalError;
      }
    }
    fs.unlinkSync(paths.lock);
    lockHandle = fs.openSync(paths.lock, 'wx', 0o600);
  }
  fs.writeFileSync(lockHandle, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
}

function releaseLock() {
  if (lockHandle !== null) {
    try { fs.closeSync(lockHandle); } catch { /* ignore */ }
    lockHandle = null;
  }
  try { fs.unlinkSync(paths.lock); } catch { /* ignore */ }
  if (workDir) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    workDir = '';
  }
}

function disableAutoUpdate() {
  const cfg = readObject(configFile);
  cfg.autoUpdate = {
    ...(cfg.autoUpdate || {}),
    enabled: false
  };
  writeObject(configFile, cfg);
  return cfg;
}

async function notifyFailure(cfg) {
  const host = ['0.0.0.0', '::', '[::]'].includes(String(cfg.server?.host || ''))
    ? '127.0.0.1'
    : String(cfg.server?.host || '127.0.0.1');
  const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const url = `http://${displayHost}:${Number(cfg.server?.port) || 3210}/api/auto-update/notify-pending`;
  for (let attempt = 0; attempt < notifyAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-console-token': String(cfg.server?.token || '')
        },
        body: '{}',
        signal: AbortSignal.timeout(2_000)
      });
      if (response.ok) return true;
    } catch {
      // A failed deployment may still be restoring the Agent.
    }
    await new Promise((resolve) => setTimeout(resolve, notifyRetryMs));
  }
  return false;
}

function ensureRepository(cache, repository) {
  fs.mkdirSync(path.dirname(cache), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(cache)) {
    git(['init', '--bare', cache]);
  }
  const remotes = git(['--git-dir', cache, 'remote']).stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (remotes.includes('origin')) {
    git(['--git-dir', cache, 'remote', 'set-url', 'origin', repository]);
  } else {
    git(['--git-dir', cache, 'remote', 'add', 'origin', repository]);
  }
}

function validateCheckout(directory) {
  for (const file of [
    'package.json',
    'package-lock.json',
    'deploy.sh',
    'src/server.js',
    'scripts/auto-update.mjs'
  ]) {
    if (!fs.existsSync(path.join(directory, file))) {
      throw new Error(`Downloaded revision is incomplete: missing ${file}`);
    }
  }
  const pkg = readObject(path.join(directory, 'package.json'));
  if (pkg.name !== 'qq-agent') throw new Error('Downloaded repository is not QQ Agent');
}

async function run() {
  acquireLock();
  const request = consumeAutoUpdateRequest(dataDir);
  mode = request?.mode || 'scheduled';
  let cfg = readObject(configFile);
  const settings = cfg.autoUpdate || {};
  if (mode === 'scheduled' && settings.enabled !== true) return;

  const previous = readAutoUpdateState(dataDir);
  const now = Date.now();
  const intervalMs = Math.max(1, Number(settings.intervalHours) || 6) * 60 * 60 * 1000;
  if (
    mode === 'scheduled'
    && Number(previous.lastCheckAt || 0) > 0
    && now < Number(previous.lastCheckAt) + intervalMs
  ) {
    return;
  }

  const repository = String(settings.repository || '').trim();
  const branch = String(settings.branch || 'main').trim();
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(repository)) {
    throw new Error('Automatic update repository is not an approved GitHub HTTPS URL');
  }
  if (
    !/^[A-Za-z0-9._/-]{1,100}$/.test(branch)
    || branch.startsWith('-')
    || branch.includes('..')
    || branch.endsWith('/')
  ) {
    throw new Error('Automatic update branch is invalid');
  }
  const deployment = readObject(deploymentFile);
  if (
    path.resolve(deployment.root || '') !== appDir
    || path.resolve(deployment.data || '') !== dataDir
    || deployment.service !== service
  ) {
    throw new Error('Deployment metadata does not match this installation');
  }

  phase = 'checking';
  const currentRevision = revisionFromFile();
  writeAutoUpdateState(dataDir, {
    status: 'checking',
    mode,
    phase,
    startedAt: now,
    completedAt: 0,
    lastCheckAt: now,
    currentRevision,
    targetRevision: '',
    error: '',
    notification: {
      pending: false,
      ownerUin: autoUpdateOwner(cfg),
      sentAt: 0,
      error: ''
    }
  });

  ensureRepository(paths.repository, repository);
  git([
    '--git-dir',
    paths.repository,
    'fetch',
    '--force',
    '--prune',
    '--depth=1',
    'origin',
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`
  ], { timeout: 5 * 60 * 1000 });
  targetRevision = git([
    '--git-dir',
    paths.repository,
    'rev-parse',
    `refs/remotes/origin/${branch}`
  ]).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(targetRevision)) {
    throw new Error('GitHub did not return a valid revision');
  }

  if (currentRevision === targetRevision) {
    writeAutoUpdateState(dataDir, {
      status: 'no-update',
      mode,
      phase: 'complete',
      completedAt: Date.now(),
      currentRevision,
      targetRevision,
      error: ''
    });
    return;
  }

  fs.mkdirSync(paths.workRoot, { recursive: true, mode: 0o700 });
  workDir = fs.mkdtempSync(path.join(paths.workRoot, 'checkout-'));
  git([
    '--git-dir',
    paths.repository,
    '--work-tree',
    workDir,
    'checkout',
    '--force',
    targetRevision,
    '--',
    '.'
  ]);
  validateCheckout(workDir);

  phase = 'testing';
  writeAutoUpdateState(dataDir, {
    status: 'testing',
    mode,
    phase,
    targetRevision
  });
  const npm = String(
    process.env.QQ_AGENT_UPDATE_NPM
    || path.join(path.dirname(process.execPath), 'npm')
  );
  if (!fs.existsSync(npm)) throw new Error('The deployed Node.js runtime does not include npm');
  const runtimeEnv = {
    ...process.env,
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH || '/usr/bin:/bin'}`
  };
  command(npm, ['ci', '--ignore-scripts'], {
    cwd: workDir,
    timeout: 10 * 60 * 1000,
    env: runtimeEnv
  });
  const tests = fs.readdirSync(path.join(workDir, 'test'))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => path.join('test', name));
  const testDataDir = path.join(workDir, '.auto-update-test-data');
  fs.mkdirSync(testDataDir, { recursive: true, mode: 0o700 });
  command(process.execPath, ['--test', ...tests], {
    cwd: workDir,
    timeout: 20 * 60 * 1000,
    env: {
      ...runtimeEnv,
      NODE_ENV: 'test',
      QQ_AGENT_DATA_DIR: testDataDir
    }
  });
  command(process.execPath, ['--check', 'src/server.js'], { cwd: workDir });
  command(process.execPath, ['--check', 'scripts/auto-update.mjs'], { cwd: workDir });
  fs.rmSync(testDataDir, { recursive: true, force: true });

  phase = 'deploying';
  writeAutoUpdateState(dataDir, {
    status: 'deploying',
    mode,
    phase,
    targetRevision
  });
  command('/bin/bash', [
    path.join(workDir, 'deploy.sh'),
    '--install-dir', appDir,
    '--data-dir', dataDir,
    '--host', String(cfg.server?.host || '127.0.0.1'),
    '--port', String(Number(cfg.server?.port) || 3210),
    '--service', service,
    '--node', process.execPath
  ], {
    cwd: workDir,
    timeout: 20 * 60 * 1000,
    env: {
      ...runtimeEnv,
      QQ_AGENT_SOURCE_REVISION: targetRevision,
      QQ_AGENT_REPOSITORY: repository,
      QQ_AGENT_BRANCH: branch
    }
  });

  writeAutoUpdateState(dataDir, {
    status: 'succeeded',
    mode,
    phase: 'complete',
    completedAt: Date.now(),
    lastSuccessAt: Date.now(),
    currentRevision: targetRevision,
    targetRevision,
    error: '',
    autoDisabled: false
  });
}

try {
  await run();
} catch (error) {
  if (error?.code === 'UPDATE_BUSY') {
    console.log(`[auto-update] ${error.message}`);
    process.exitCode = 0;
  } else {
    const message = sanitizeUpdateError(error);
    let cfg = {};
    try { cfg = readObject(configFile); } catch { /* preserve original failure */ }
    writeAutoUpdateState(dataDir, {
      status: 'failed',
      mode,
      phase,
      completedAt: Date.now(),
      targetRevision,
      error: message,
      autoDisabled: true,
      notification: {
        pending: true,
        ownerUin: autoUpdateOwner(cfg),
        sentAt: 0,
        error: ''
      }
    });
    console.error(`[auto-update] ${message}`);
    let reported = false;
    try { reported = await notifyFailure(cfg); } catch { /* use disk fallback */ }
    if (!reported) {
      try { disableAutoUpdate(); } catch { /* state still blocks the next scheduled run */ }
    }
    process.exitCode = 1;
  }
} finally {
  releaseLock();
}
