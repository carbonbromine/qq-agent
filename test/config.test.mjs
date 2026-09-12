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
  const {
    conversationConfigForChat,
    friendProposalEnabled,
    getConfig,
    identityPilotEnabled,
    updateConfig
  } = await import('../src/config.js');
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
  assert.equal(config.api.maxRunTokens, 160000);
  assert.equal(config.api.contextWindowTokens, 1000000);
  assert.equal(config.conversation.lifecycleRolloverInputTokens, 32000);
  assert.equal(config.qzoneInteractions.enabled, false);
  assert.equal(config.qzoneInteractions.feedIntervalMinutes, 60);
  assert.equal(config.qzoneInteractions.replyIntervalMinutes, 5);
  assert.equal(config.identityPilot.enabled, false);
  assert.equal(config.identityPilot.friendProposal.enabled, false);
  assert.equal(config.identityPilot.friendProposal.cooldownDays, 30);
  assert.equal(identityPilotEnabled(config), false);
  assert.equal(friendProposalEnabled(config), false);
  assert.equal(config.wakeDelayMinMs, 8000);
  assert.equal(config.wakeDelayMaxMs, 12000);
  updateConfig({
    api: { maxRunTokens: 180000, contextWindowTokens: 800000 },
    ui: { refreshMs: 5000 },
    qzoneInteractions: {
      enabled: true,
      feedIntervalMinutes: 90,
      replyIntervalMinutes: 10,
      maxBatchItems: 15
    },
    identityPilot: {
      enabled: true,
      friendProposal: {
        enabled: true,
        ownerUin: '123456',
        minMessageCount: 75,
        cooldownDays: 45,
        maxPending: 6
      }
    },
    allow: { private: ['123456'] },
    wakeDelayMinMs: 14000,
    wakeDelayMaxMs: 6000,
    conversation: {
      mode: 'threaded',
      unifiedMode: false,
      groupModes: { 100: 'lifecycle', 200: 'legacy' },
      continuationWindowMs: 120000,
      threadTtlMs: 900000,
      continuationContextCount: 80,
      lifecycleRolloverInputTokens: 36000
    }
  });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.onebot.wsUrl, 'ws://127.0.0.1:13001');
  assert.equal(saved.providerKeys.provider, 'model-secret');
  assert.equal('snowluma' in saved, false);
  assert.equal(saved.conversation.mode, 'threaded');
  assert.equal(saved.api.maxRunTokens, 180000);
  assert.equal(saved.api.contextWindowTokens, 800000);
  assert.equal(saved.qzoneInteractions.enabled, true);
  assert.equal(saved.qzoneInteractions.feedIntervalMinutes, 90);
  assert.equal(saved.qzoneInteractions.replyIntervalMinutes, 10);
  assert.equal(saved.qzoneInteractions.maxBatchItems, 15);
  assert.equal(saved.identityPilot.enabled, true);
  assert.equal(saved.identityPilot.friendProposal.enabled, true);
  assert.equal(saved.identityPilot.friendProposal.ownerUin, '123456');
  assert.equal(saved.identityPilot.friendProposal.minMessageCount, 75);
  assert.equal(saved.identityPilot.friendProposal.cooldownDays, 45);
  assert.equal(saved.identityPilot.friendProposal.maxPending, 6);
  assert.equal(identityPilotEnabled(), true);
  assert.equal(friendProposalEnabled(), true);
  assert.equal(saved.wakeDelayMinMs, 6000);
  assert.equal(saved.wakeDelayMaxMs, 14000);
  assert.equal(saved.wakeDelayMs, 10000);
  assert.equal(saved.conversation.lifecycleRolloverInputTokens, 36000);
  assert.equal(conversationConfigForChat('group:100').mode, 'lifecycle');
  assert.equal(conversationConfigForChat('group:200').mode, 'legacy');
  assert.equal(conversationConfigForChat('group:300').mode, 'threaded');
  assert.equal(conversationConfigForChat('private:100').mode, 'threaded');
  updateConfig({ identityPilot: { enabled: false } });
  const disabled = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(disabled.identityPilot.enabled, false);
  assert.equal(identityPilotEnabled(), false);
  assert.equal(friendProposalEnabled(), false);
  assert.throws(
    () => updateConfig({
      identityPilot: { enabled: true, friendProposal: { enabled: true, ownerUin: '' } }
    }),
    /管理员 QQ/
  );
  assert.throws(() => updateConfig({ conversation: { mode: 'invalid' } }), /conversation mode/);
  assert.throws(
    () => updateConfig({ conversation: { groupModes: { 100: 'invalid' } } }),
    /group conversation mode/
  );
});
