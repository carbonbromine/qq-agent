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
import {
  gitTransportPrefix,
  isRetryableUpdateNetworkError,
  normalizeUpdateNetworkSettings,
  retryUpdateOperation
} from '../src/update-network.js';

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
let cfg = {};
let repository = '';
let branch = 'main';
let probeStartedAt = 0;
let networkSettings = normalizeUpdateNetworkSettings();
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
    const error = new Error(`${path.basename(binary)} ${args[0] || ''} failed`
      + `${detail ? `: ${detail}` : ` with exit ${result.status}`}`);
    error.status = result.status;
    error.stdout = String(result.stdout || '');
    error.stderr = String(result.stderr || '');
    error.command = `${binary} ${args.join(' ')}`;
    throw error;
  }
  return result;
}

function git(args, options = {}) {
  return command('git', args, options);
}

function networkGitArgs(args) {
  return [...gitTransportPrefix(networkSettings), ...args];
}

function commandFailure(binary, args, result) {
  if (result?.error) return result.error;
  const detail = String(result?.stderr || result?.stdout || '').trim().slice(-2000);
  const error = new Error(`${path.basename(binary)} ${args[0] || ''} failed`
    + `${detail ? `: ${detail}` : ` with exit ${result?.status}`}`);
  error.status = result?.status;
  error.stdout = String(result?.stdout || '');
  error.stderr = String(result?.stderr || '');
  error.command = `${binary} ${args.join(' ')}`;
  return error;
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
  const current = readObject(configFile);
  current.autoUpdate = {
    ...(current.autoUpdate || {}),
    enabled: false
  };
  writeObject(configFile, current);
  cfg = current;
  return current;
}

async function notifyFailure(currentConfig) {
  const host = ['0.0.0.0', '::', '[::]'].includes(String(currentConfig.server?.host || ''))
    ? '127.0.0.1'
    : String(currentConfig.server?.host || '127.0.0.1');
  const displayHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const url = `http://${displayHost}:${Number(currentConfig.server?.port) || 3210}/api/auto-update/notify-pending`;
  for (let attempt = 0; attempt < notifyAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-console-token': String(currentConfig.server?.token || '')
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

function ensureRepository(cache, remoteRepository) {
  fs.mkdirSync(path.dirname(cache), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(cache)) {
    git(['init', '--bare', cache]);
  }
  const remotes = git(['--git-dir', cache, 'remote']).stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (remotes.includes('origin')) {
    git(['--git-dir', cache, 'remote', 'set-url', 'origin', remoteRepository]);
  } else {
    git(['--git-dir', cache, 'remote', 'add', 'origin', remoteRepository]);
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

function retryLog(scope) {
  return ({ nextAttempt, delayMs, error }) => {
    const text = sanitizeUpdateError(error);
    console.warn(
      `[auto-update] ${scope} failed; retry ${nextAttempt}/${networkSettings.networkRetries + 1}`
      + ` in ${delayMs}ms: ${text}`
    );
  };
}

async function probeConnectivity() {
  probeStartedAt = Date.now();
  const timeout = networkSettings.connectivityTimeoutSeconds * 1000;
  const result = await retryUpdateOperation(async () => {
    const args = networkGitArgs([
      'ls-remote',
      '--exit-code',
      '--heads',
      repository,
      `refs/heads/${branch}`
    ]);
    const probe = git(args, { allowFailure: true, timeout });
    if (probe.error) throw probe.error;
    if (probe.status === 2) {
      throw Object.assign(
        new Error(`Automatic update branch not found: ${branch}`),
        { code: 'UPDATE_BRANCH_NOT_FOUND', retryable: false, status: 2 }
      );
    }
    if (probe.status !== 0) throw commandFailure('git', args, probe);
    const line = String(probe.stdout || '').trim().split(/\r?\n/)[0] || '';
    const match = /^([0-9a-f]{40})\s+refs\/heads\//.exec(line);
    if (!match) {
      throw Object.assign(
        new Error(`GitHub returned no valid revision for branch ${branch}`),
        { retryable: false }
      );
    }
    return match[1];
  }, {
    retries: networkSettings.networkRetries,
    baseDelayMs: networkSettings.retryBaseMs,
    maxDelayMs: networkSettings.retryMaxMs,
    isRetryable: isRetryableUpdateNetworkError,
    onRetry: retryLog('connectivity probe')
  });
  const connectivity = {
    status: 'ok',
    checkedAt: Date.now(),
    attempts: result.attempts,
    latencyMs: Date.now() - probeStartedAt,
    repository,
    branch,
    revision: result.value,
    error: ''
  };
  writeAutoUpdateState(dataDir, { connectivity });
  return connectivity;
}

async function fetchTargetBranch() {
  const timeout = networkSettings.fetchTimeoutSeconds * 1000;
  return retryUpdateOperation(async () => {
    git(networkGitArgs([
      '--git-dir',
      paths.repository,
      'fetch',
      '--force',
      '--prune',
      '--depth=1',
      'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`
    ]), { timeout });
    return true;
  }, {
    retries: networkSettings.networkRetries,
    baseDelayMs: networkSettings.retryBaseMs,
    maxDelayMs: networkSettings.retryMaxMs,
    isRetryable: isRetryableUpdateNetworkError,
    onRetry: retryLog('git fetch')
  });
}

async function run() {
  acquireLock();
  const request = consumeAutoUpdateRequest(dataDir);
  mode = request?.mode || 'scheduled';
  cfg = readObject(configFile);
  const settings = cfg.autoUpdate || {};
  networkSettings = normalizeUpdateNetworkSettings(settings);
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

  repository = String(settings.repository || '').trim();
  branch = String(settings.branch || 'main').trim();
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

  phase = 'connectivity';
  const currentRevision = revisionFromFile();
  writeAutoUpdateState(dataDir, {
    status: 'checking',
    mode,
    phase,
    startedAt: now,
    completedAt: 0,
    ...(mode === 'scheduled' ? { lastCheckAt: now } : {}),
    currentRevision,
    targetRevision: '',
    error: '',
    notification: {
      pending: false,
      ownerUin: autoUpdateOwner(cfg),
      sentAt: 0,
      error: ''
    },
    connectivity: {
      status: 'testing',
      checkedAt: 0,
      attempts: 0,
      latencyMs: 0,
      repository,
      branch,
      revision: '',
      error: ''
    }
  });

  ensureRepository(paths.repository, repository);
  const connectivity = await probeConnectivity();
  if (mode === 'probe') {
    writeAutoUpdateState(dataDir, {
      status: 'idle',
      mode,
      phase: 'complete',
      completedAt: Date.now(),
      error: '',
      autoDisabled: false,
      connectivity
    });
    return;
  }

  phase = 'checking';
  writeAutoUpdateState(dataDir, {
    status: 'checking',
    mode,
    phase,
    lastCheckAt: now,
    connectivity
  });
  await fetchTargetBranch();
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
      error: '',
      autoDisabled: false
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
  command(npm, [
    'ci',
    '--ignore-scripts',
    '--prefer-offline',
    '--no-audit',
    '--fund=false',
    `--fetch-retries=${networkSettings.networkRetries}`,
    `--fetch-retry-mintimeout=${networkSettings.retryBaseMs}`,
    `--fetch-retry-maxtimeout=${networkSettings.retryMaxMs}`
  ], {
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
  } else if (mode === 'probe') {
    const message = sanitizeUpdateError(error);
    writeAutoUpdateState(dataDir, {
      status: 'idle',
      mode: 'probe',
      phase: 'complete',
      completedAt: Date.now(),
      error: '',
      autoDisabled: false,
      connectivity: {
        status: 'failed',
        checkedAt: Date.now(),
        attempts: Number(error?.attempts) || 1,
        latencyMs: probeStartedAt ? Date.now() - probeStartedAt : 0,
        repository,
        branch,
        revision: '',
        error: message
      },
      notification: { pending: false }
    });
    console.error(`[auto-update] connectivity probe failed: ${message}`);
    process.exitCode = 0;
  } else {
    const message = sanitizeUpdateError(error);
    let currentConfig = cfg;
    try {
      if (!currentConfig || !Object.keys(currentConfig).length) currentConfig = readObject(configFile);
    } catch { currentConfig = {}; }
    const failurePolicy = normalizeUpdateNetworkSettings(currentConfig.autoUpdate || {});
    if (failurePolicy.disableOnFailure) {
      try { currentConfig = disableAutoUpdate(); } catch { /* state still records autoDisabled */ }
    }
    writeAutoUpdateState(dataDir, {
      status: 'failed',
      mode,
      phase,
      completedAt: Date.now(),
      targetRevision,
      error: message,
      autoDisabled: failurePolicy.disableOnFailure,
      ...(phase === 'connectivity' ? {
        connectivity: {
          status: 'failed',
          checkedAt: Date.now(),
          attempts: Number(error?.attempts) || 1,
          latencyMs: probeStartedAt ? Date.now() - probeStartedAt : 0,
          repository,
          branch,
          revision: '',
          error: message
        }
      } : {}),
      notification: {
        pending: true,
        ownerUin: autoUpdateOwner(currentConfig),
        sentAt: 0,
        error: ''
      }
    });
    console.error(`[auto-update] ${message}`);
    try { await notifyFailure(currentConfig); } catch { /* keep pending notification on disk */ }
    process.exitCode = 1;
  }
} finally {
  releaseLock();
}
