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
  const { conversationConfigForChat, getConfig, updateConfig } = await import('../src/config.js');
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
  assert.equal(config.conversation.mode, 'legacy');
  updateConfig({
    ui: { refreshMs: 5000 },
    conversation: {
      mode: 'threaded',
      unifiedMode: false,
      groupModes: { 100: 'lifecycle', 200: 'legacy' },
      continuationWindowMs: 120000,
      threadTtlMs: 900000,
      continuationContextCount: 80
    }
  });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.onebot.wsUrl, 'ws://127.0.0.1:13001');
  assert.equal(saved.providerKeys.provider, 'model-secret');
  assert.equal('snowluma' in saved, false);
  assert.equal(saved.conversation.mode, 'threaded');
  assert.equal(conversationConfigForChat('group:100').mode, 'lifecycle');
  assert.equal(conversationConfigForChat('group:200').mode, 'legacy');
  assert.equal(conversationConfigForChat('group:300').mode, 'threaded');
  assert.equal(conversationConfigForChat('private:100').mode, 'threaded');
  assert.throws(() => updateConfig({ conversation: { mode: 'invalid' } }), /conversation mode/);
  assert.throws(
    () => updateConfig({ conversation: { groupModes: { 100: 'invalid' } } }),
    /group conversation mode/
  );
});
