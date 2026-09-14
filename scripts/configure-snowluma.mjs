import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    token: { type: 'string' },
    'http-port': { type: 'string', default: '3000' },
    'ws-port': { type: 'string', default: '3001' }
  }
});

if (!values['data-dir']) throw new Error('--data-dir is required');
if (!values.token || values.token.length < 16) {
  throw new Error('--token must contain at least 16 characters');
}

const parsePort = (name, raw) => {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return port;
};

const httpPort = parsePort('--http-port', values['http-port']);
const wsPort = parsePort('--ws-port', values['ws-port']);
if (httpPort === wsPort) throw new Error('HTTP and WebSocket ports must differ');

const configDir = path.join(path.resolve(values['data-dir']), 'config');
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

function readObject(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('root value must be an object');
    }
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Cannot read ${file}: ${error.message}`, { cause: error });
  }
}

function updateServer(list, fallback) {
  if (!Array.isArray(list) || list.length === 0) return [fallback];
  const index = Math.max(0, list.findIndex((item) => item?.name === fallback.name));
  const current = list[index];
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    list[index] = fallback;
  } else {
    list[index] = {
      ...current,
      host: '0.0.0.0',
      port: fallback.port,
      path: '/',
      accessToken: values.token,
      messageFormat: current.messageFormat || 'array',
      reportSelfMessage: current.reportSelfMessage === true,
      ...(fallback.role ? { role: current.role || fallback.role } : {}),
      ...(Object.hasOwn(fallback, 'enableWebSocket')
        ? { enableWebSocket: current.enableWebSocket === true }
        : {})
    };
  }
  return list;
}

function updateFile(file) {
  const config = readObject(file);
  const networks = config.networks && typeof config.networks === 'object'
    && !Array.isArray(config.networks) ? config.networks : {};

  networks.httpServers = updateServer(networks.httpServers, {
    name: 'http-default',
    host: '0.0.0.0',
    port: httpPort,
    path: '/',
    enableWebSocket: false,
    accessToken: values.token,
    messageFormat: 'array',
    reportSelfMessage: false
  });
  networks.wsServers = updateServer(networks.wsServers, {
    name: 'ws-default',
    host: '0.0.0.0',
    port: wsPort,
    path: '/',
    role: 'Universal',
    accessToken: values.token,
    messageFormat: 'array',
    reportSelfMessage: false
  });
  networks.httpClients = Array.isArray(networks.httpClients) ? networks.httpClients : [];
  networks.wsClients = Array.isArray(networks.wsClients) ? networks.wsClients : [];
  config.networks = networks;

  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.bak`);
  }
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
  return path.basename(file);
}

const files = ['onebot.json'];
for (const name of fs.readdirSync(configDir)) {
  if (/^onebot_\d+\.json$/.test(name)) files.push(name);
}

const updated = [...new Set(files)].map((name) => updateFile(path.join(configDir, name)));
console.log(JSON.stringify({ updated, httpPort, wsPort }));
