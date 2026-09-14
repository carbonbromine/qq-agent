import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'data-dir': { type: 'string' }, host: { type: 'string', default: '127.0.0.1' },
  port: { type: 'string', default: '3210' }, 'import-bridge': { type: 'string' },
  'credential-file': { type: 'string' }
} });
if (!values['data-dir']) throw new Error('--data-dir is required');
process.env.QQ_AGENT_DATA_DIR = path.resolve(values['data-dir']);
const { getConfig, updateConfig, CONFIG_FILE } = await import('../src/config.js');
const exists = fs.existsSync(CONFIG_FILE);
const patch = {
  server: { host: values.host, port: Number(values.port), strictPort: true }
};
const consoleToken = String(process.env.QQ_AGENT_CONSOLE_TOKEN || '').trim();
const onebotToken = String(process.env.QQ_AGENT_ONEBOT_TOKEN || '').trim();
const onebotHttpToken = String(process.env.QQ_AGENT_ONEBOT_HTTP_TOKEN || onebotToken).trim();
const onebotWsUrl = String(process.env.QQ_AGENT_ONEBOT_WS_URL || '').trim();
const onebotHttpUrl = String(process.env.QQ_AGENT_ONEBOT_HTTP_URL || '').trim();
const modelBaseUrl = String(process.env.QQ_AGENT_MODEL_BASE_URL || '').trim();
const modelApiKey = String(process.env.QQ_AGENT_MODEL_API_KEY || '').trim();
const model = String(process.env.QQ_AGENT_MODEL || '').trim();
const parseIds = (name) => {
  if (!(name in process.env)) return null;
  const ids = String(process.env[name] || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (ids.some((id) => !/^\d+$/.test(id))) throw new Error(`${name} must contain comma-separated numeric IDs`);
  return [...new Set(ids)];
};
const allowGroups = parseIds('QQ_AGENT_ALLOW_GROUPS');
const allowPrivate = parseIds('QQ_AGENT_ALLOW_PRIVATE');
if (consoleToken) patch.server.token = consoleToken;
if (!exists) {
  patch.runtime = { mode: 'observe', paused: false };
  patch.server.token ||= crypto.randomBytes(24).toString('hex');
  if (values['import-bridge']) {
    const old = JSON.parse(fs.readFileSync(values['import-bridge'], 'utf8'));
    const oldOneBot = old.onebot || old.snowluma || {};
    patch.onebot = {
      wsUrl: oldOneBot.wsUrl,
      httpUrl: oldOneBot.httpUrl,
      accessToken: oldOneBot.accessToken || '',
      httpAccessToken: oldOneBot.httpAccessToken || oldOneBot.accessToken || ''
    };
    patch.allow = old.allow;
    patch.deny = old.deny;
    patch.api = { baseUrl: old.dsh?.baseUrl?.includes('api.') ? old.dsh.baseUrl : 'https://api.deepseek.com',
      model: old.dsh?.model || '', provider: '' };
    if (values['credential-file']) {
      const env = fs.readFileSync(values['credential-file'], 'utf8');
      const line = env.split(/\r?\n/).find((v) => v.startsWith('DEEPSEEK_API_KEY='));
      if (line) {
        const raw = line.slice('DEEPSEEK_API_KEY='.length).trim();
        patch.api.apiKey = raw.replace(/^(['"])(.*)\1$/, '$2');
      }
    }
  }
}
if (onebotToken || onebotHttpToken || onebotWsUrl || onebotHttpUrl) {
  patch.onebot = {
    ...(patch.onebot || {}),
    ...(onebotWsUrl ? { wsUrl: onebotWsUrl } : {}),
    ...(onebotHttpUrl ? { httpUrl: onebotHttpUrl } : {}),
    ...(onebotToken ? { accessToken: onebotToken } : {}),
    ...(onebotHttpToken ? { httpAccessToken: onebotHttpToken } : {})
  };
}
if (modelBaseUrl || modelApiKey || model) {
  patch.api = {
    ...(patch.api || {}),
    ...(modelBaseUrl ? { baseUrl: modelBaseUrl } : {}),
    ...(modelApiKey ? { apiKey: modelApiKey } : {}),
    ...(model ? { model } : {})
  };
}
if (allowGroups !== null || allowPrivate !== null) {
  patch.allow = {
    ...(patch.allow || {}),
    ...(allowGroups !== null ? { groups: allowGroups } : {}),
    ...(allowPrivate !== null ? { private: allowPrivate } : {})
  };
}
updateConfig(patch);
fs.chmodSync(CONFIG_FILE, 0o600);
const current = getConfig();
fs.writeFileSync(path.join(path.dirname(CONFIG_FILE), 'console-access.txt'),
  `QQ Agent Linux\nURL: http://${current.server.host}:${current.server.port}\nToken: ${current.server.token}\nMode: ${current.runtime.mode}\n`,
  { mode: 0o600 });
console.log(JSON.stringify({ config: CONFIG_FILE, mode: getConfig().runtime.mode,
  host: getConfig().server.host, port: getConfig().server.port, imported: !exists && !!values['import-bridge'] }));
