import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('migrates legacy desktop and DSH keys into the Linux configuration', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    snowluma: {
      dir: '/old/bundle', autoLaunch: true,
      wsUrl: 'ws://127.0.0.1:13001', httpUrl: 'http://127.0.0.1:13000',
      accessToken: 'ws-secret', httpAccessToken: 'http-secret'
    },
    dshProviderKeys: { provider: 'model-secret' },
    providersSourceYaml: '/old/dsh/settings.yaml',
    providersImported: true,
    telemetry: { enabled: true },
    server: { port: 3210, host: '127.0.0.1', autoStart: true, closeToTray: true },
    ui: { theme: '?' }
  }));
  process.env.QQ_AGENT_DATA_DIR = dir;
  const { getConfig, updateConfig } = await import('../src/config.js');
  const config = getConfig();
  assert.deepEqual(config.onebot, {
    wsUrl: 'ws://127.0.0.1:13001', httpUrl: 'http://127.0.0.1:13000',
    accessToken: 'ws-secret', httpAccessToken: 'http-secret'
  });
  assert.deepEqual(config.providerKeys, { provider: 'model-secret' });
  for (const key of ['snowluma', 'dshProviderKeys', 'providersSourceYaml', 'providersImported', 'telemetry']) {
    assert.equal(key in config, false);
  }
  assert.equal('autoStart' in config.server, false);
  assert.equal('closeToTray' in config.server, false);
  assert.equal(config.ui.theme, 'dark');
  updateConfig({ ui: { refreshMs: 5000 } });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.onebot.wsUrl, 'ws://127.0.0.1:13001');
  assert.equal(saved.providerKeys.provider, 'model-secret');
  assert.equal('snowluma' in saved, false);
});
