import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

// Read persisted files directly. Importing the application's config loader can
// migrate/write configuration, which is not permitted during this preflight.
const { values } = parseArgs({
  options: {
    'root-dir': { type: 'string' },
    service: { type: 'string' },
    input: { type: 'string', default: 'none' }
  }
});

function requireMatch(condition, message) {
  if (!condition) throw new Error(message);
}

function canonical(file) {
  const resolved = path.resolve(file);
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

function readObject(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  requireMatch(parsed && typeof parsed === 'object' && !Array.isArray(parsed),
    `Invalid object in ${path.basename(file)}`);
  return parsed;
}

function check() {
  requireMatch(values['root-dir'] && values.service, '--root-dir and --service are required');
  const root = canonical(values['root-dir']);
  const app = path.join(root, 'app');
  const data = path.join(root, 'data');
  const snowluma = path.join(root, 'snowluma');
  const env = {};
  for (const line of fs.readFileSync(path.join(snowluma, '.env'), 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    requireMatch(match && !Object.hasOwn(env, match[1]), 'Invalid or duplicate stack environment entry');
    env[match[1]] = match[2];
  }
  for (const key of ['SNOWLUMA_IMAGE', 'SNOWLUMA_CONTAINER', 'QQ_AGENT_SERVICE',
    'AGENT_PORT', 'SNOWLUMA_WEBUI_HOST_PORT', 'NOVNC_PORT', 'ONEBOT_HTTP_PORT',
    'ONEBOT_WS_PORT', 'ONEBOT_TOKEN', 'QQ_AGENT_CONSOLE_TOKEN',
    'SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD', 'VNC_PASSWD']) {
    requireMatch(env[key], `Missing saved stack setting: ${key}`);
  }
  requireMatch(env.SNOWLUMA_CONTAINER === 'qq-agent-snowluma', 'Unrecognized stack container name');
  requireMatch(env.QQ_AGENT_SERVICE === values.service, 'Changing the managed service name is not supported');
  const portKeys = ['AGENT_PORT', 'SNOWLUMA_WEBUI_HOST_PORT', 'NOVNC_PORT',
    'ONEBOT_HTTP_PORT', 'ONEBOT_WS_PORT'];
  for (const key of portKeys) {
    requireMatch(/^[1-9]\d*$/.test(env[key]) && Number(env[key]) <= 65535, `Invalid saved port: ${key}`);
  }
  requireMatch(new Set(portKeys.map((key) => env[key])).size === 5, 'Saved ports are not distinct');

  const deployment = readObject(path.join(app, '.deployment.json'));
  const recordedNode = fs.readFileSync(path.join(app, '.deployment-node'), 'utf8').trim();
  requireMatch(typeof deployment.root === 'string' && canonical(deployment.root) === app,
    'Agent installation directory does not match this stack');
  requireMatch(typeof deployment.data === 'string' && canonical(deployment.data) === data,
    'Agent data directory does not match this stack');
  requireMatch(deployment.service === values.service && deployment.node === recordedNode,
    'Agent service/runtime metadata does not match this stack');

  const config = readObject(path.join(data, 'config.json'));
  const expectedHttp = `http://127.0.0.1:${env.ONEBOT_HTTP_PORT}`;
  const expectedWs = `ws://127.0.0.1:${env.ONEBOT_WS_PORT}`;
  requireMatch(config.onebot?.httpUrl === expectedHttp && config.onebot?.wsUrl === expectedWs,
    'Agent uses different OneBot endpoints; refusing to replace them');
  requireMatch(config.onebot?.accessToken === env.ONEBOT_TOKEN
    && (config.onebot?.httpAccessToken || config.onebot?.accessToken) === env.ONEBOT_TOKEN,
  'OneBot credentials have changed outside the installer; refusing to overwrite them');
  requireMatch(config.server?.token === env.QQ_AGENT_CONSOLE_TOKEN,
    'Console credentials have changed outside the installer; refusing to overwrite them');
  requireMatch(config.server?.host === '0.0.0.0' && config.server?.port === Number(env.AGENT_PORT),
    'Console binding has changed outside the installer; refusing to overwrite it');

  const mounts = new Map([
    ['/app/data', path.join(snowluma, 'data')],
    ['/app/.config', path.join(snowluma, 'client-config')],
    ['/app/.local/share', path.join(snowluma, 'client-data')]
  ]);
  function checkMounts(entries) {
    requireMatch(Array.isArray(entries) && entries.length === mounts.size, 'Unexpected SnowLuma mounts');
    const seen = new Set();
    for (const { type, source, target } of entries) {
      requireMatch(type === 'bind' && typeof source === 'string'
        && mounts.has(target) && canonical(source) === canonical(mounts.get(target))
        && !seen.has(target), 'SnowLuma data volumes belong to a different installation');
      seen.add(target);
    }
  }
  const expectedPorts = new Map([
    [3000, ['127.0.0.1', env.ONEBOT_HTTP_PORT]],
    [3001, ['127.0.0.1', env.ONEBOT_WS_PORT]],
    [5099, ['0.0.0.0', env.SNOWLUMA_WEBUI_HOST_PORT]],
    [6081, ['0.0.0.0', env.NOVNC_PORT]]
  ]);
  function checkPorts(entries) {
    requireMatch(Array.isArray(entries) && entries.length === expectedPorts.size, 'Unexpected SnowLuma ports');
    const seen = new Set();
    for (const { target, published, host_ip, protocol } of entries) {
      const expected = expectedPorts.get(Number(target));
      requireMatch(expected && expected[0] === host_ip && expected[1] === String(published)
        && protocol === 'tcp' && !seen.has(Number(target)), 'SnowLuma port bindings differ from the saved stack');
      seen.add(Number(target));
    }
  }

  if (values.input === 'compose') {
    const compose = JSON.parse(fs.readFileSync(0, 'utf8'));
    requireMatch(Object.keys(compose.services || {}).length === 1, 'Compose includes unrelated services');
    const service = compose.services.snowluma;
    requireMatch(service?.container_name === env.SNOWLUMA_CONTAINER
      && service?.image === env.SNOWLUMA_IMAGE, 'Compose service does not match this stack');
    checkMounts(service.volumes);
    checkPorts(service.ports);
    requireMatch(service.environment?.VNC_PASSWD === env.VNC_PASSWD
      && service.environment?.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD === env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD,
    'Compose credentials differ from the saved stack');
  } else if (values.input === 'container') {
    const containers = JSON.parse(fs.readFileSync(0, 'utf8'));
    requireMatch(Array.isArray(containers) && containers.length === 1, 'Invalid container inspection');
    const container = containers[0];
    const labels = container.Config?.Labels || {};
    requireMatch(container.Name === `/${env.SNOWLUMA_CONTAINER}`
      && labels['com.docker.compose.service'] === 'snowluma'
      && typeof labels['com.docker.compose.project.working_dir'] === 'string'
      && canonical(labels['com.docker.compose.project.working_dir']) === snowluma,
    'SnowLuma container belongs to another Compose project');
    requireMatch(container.Config?.Image === env.SNOWLUMA_IMAGE, 'SnowLuma container image differs from the saved stack');
    checkMounts(container.Mounts?.map((entry) => ({
      type: entry.Type, source: entry.Source, target: entry.Destination
    })));
    checkPorts(Object.entries(container.HostConfig?.PortBindings || {}).flatMap(([key, bindings]) => {
      const [target, protocol] = key.split('/');
      return (bindings || []).map((binding) => ({
        target, protocol, published: binding.HostPort, host_ip: binding.HostIp
      }));
    }));
  } else {
    requireMatch(values.input === 'none', 'Unknown preflight input type');
  }
}

try {
  check();
} catch (error) {
  // JSON parser errors can contain source text, including credentials.
  console.error(error instanceof SyntaxError ? 'Malformed deployment metadata; refusing to modify it' : error.message);
  process.exitCode = 1;
}
