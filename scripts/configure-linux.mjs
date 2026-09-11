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
if (!exists) {
  patch.runtime = { mode: 'observe', paused: false };
  patch.server.token = crypto.randomBytes(24).toString('hex');
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
updateConfig(patch);
fs.chmodSync(CONFIG_FILE, 0o600);
const current = getConfig();
fs.writeFileSync(path.join(path.dirname(CONFIG_FILE), 'console-access.txt'),
  `QQ Agent Linux\nURL: http://${current.server.host}:${current.server.port}\nToken: ${current.server.token}\nMode: ${current.runtime.mode}\n`,
  { mode: 0o600 });
console.log(JSON.stringify({ config: CONFIG_FILE, mode: getConfig().runtime.mode,
  host: getConfig().server.host, port: getConfig().server.port, imported: !exists && !!values['import-bridge'] }));
