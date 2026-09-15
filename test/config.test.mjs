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
    friendRequestDispatchEnabled,
    getConfig,
    incomingFriendRequestEnabled,
    incidentPilotEnabled,
    identityPilotEnabled,
    slangPilotEnabled,
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
  assert.equal(config.dailyMoments.scheduleWindows, null);
  assert.equal(config.identityPilot.enabled, false);
  assert.equal(config.identityPilot.graduated, false);
  assert.equal(config.identityPilot.incomingFriendRequest.enabled, false);
  assert.equal(config.identityPilot.incomingFriendRequest.autoWhitelist, true);
  assert.equal(config.identityPilot.incomingFriendRequest.maxPending, 50);
  assert.equal(config.identityPilot.friendProposal.enabled, false);
  assert.equal(config.identityPilot.friendProposal.graduated, false);
  assert.equal(config.identityPilot.friendProposal.activeDispatchEnabled, false);
  assert.equal(config.identityPilot.friendProposal.mode, 'triggered');
  assert.equal(config.identityPilot.friendProposal.cooldownDays, 30);
  assert.equal(config.identityPilot.friendProposal.triggered.probability, 0.05);
  assert.equal(config.identityPilot.friendProposal.triggered.minMessages, 50);
  assert.equal(config.identityPilot.friendProposal.triggered.minActiveDays, 3);
  assert.equal(config.identityPilot.friendProposal.triggered.minDirectExchanges, 3);
  assert.equal(identityPilotEnabled(config), false);
  assert.equal(friendProposalEnabled(config), false);
  assert.equal(friendRequestDispatchEnabled(config), false);
  assert.equal(incomingFriendRequestEnabled(config), false);
  assert.equal(config.slangPilot.enabled, false);
  assert.equal(config.slangPilot.graduated, false);
  assert.equal(config.slangPilot.minOccurrences, 3);
  assert.equal(config.slangPilot.minSpeakers, 2);
  assert.equal(slangPilotEnabled(config), false);
  assert.equal(config.incidentPilot.enabled, false);
  assert.equal(config.incidentPilot.graduated, false);
  assert.equal(config.incidentPilot.unknownWritesBlockChat, false);
  assert.equal(incidentPilotEnabled(config), false);
  assert.equal(config.autoUpdate.enabled, false);
  assert.equal(config.autoUpdate.ownerUin, '');
  assert.equal(config.autoUpdate.intervalHours, 6);
  assert.equal(config.autoUpdate.branch, 'main');
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
      graduated: true,
      incomingFriendRequest: {
        enabled: true,
        autoWhitelist: true,
        maxPending: 25
      },
      friendProposal: {
        enabled: true,
        graduated: true,
        activeDispatchEnabled: true,
        ownerUin: '123456',
        minMessageCount: 75,
        cooldownDays: 45,
        maxPending: 6
      }
    },
    slangPilot: {
      enabled: true,
      graduated: true,
      ownerUin: '123456',
      minOccurrences: 4,
      minSpeakers: 3,
      maxPending: 25,
      webResearch: false
    },
    incidentPilot: {
      enabled: true,
      graduated: true,
      ownerUin: '123456',
      notifyWarnings: false,
      duplicateWindowMinutes: 30,
      unknownWritesBlockChat: true,
      retentionDays: 120
    },
    autoUpdate: {
      enabled: true,
      ownerUin: '123456',
      intervalHours: 12
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
  assert.equal(saved.identityPilot.graduated, true);
  assert.equal(saved.identityPilot.incomingFriendRequest.enabled, true);
  assert.equal(saved.identityPilot.incomingFriendRequest.autoWhitelist, true);
  assert.equal(saved.identityPilot.incomingFriendRequest.maxPending, 25);
  assert.equal(saved.identityPilot.friendProposal.enabled, true);
  assert.equal(saved.identityPilot.friendProposal.graduated, true);
  assert.equal(saved.identityPilot.friendProposal.activeDispatchEnabled, true);
  assert.equal(saved.identityPilot.friendProposal.mode, 'triggered');
  assert.equal(saved.identityPilot.friendProposal.ownerUin, '123456');
  assert.equal(saved.identityPilot.friendProposal.minMessageCount, 75);
  assert.equal(saved.identityPilot.friendProposal.cooldownDays, 45);
  assert.equal(saved.identityPilot.friendProposal.maxPending, 6);
  assert.equal(identityPilotEnabled(), true);
  assert.equal(friendProposalEnabled(), true);
  assert.equal(friendRequestDispatchEnabled(), true);
  assert.equal(incomingFriendRequestEnabled(), true);
  assert.equal(saved.slangPilot.enabled, true);
  assert.equal(saved.slangPilot.graduated, true);
  assert.equal(saved.slangPilot.ownerUin, '123456');
  assert.equal(saved.slangPilot.minOccurrences, 4);
  assert.equal(saved.slangPilot.minSpeakers, 3);
  assert.equal(saved.slangPilot.maxPending, 25);
  assert.equal(saved.slangPilot.webResearch, false);
  assert.equal(slangPilotEnabled(), true);
  assert.equal(saved.incidentPilot.enabled, true);
  assert.equal(saved.incidentPilot.graduated, true);
  assert.equal(saved.incidentPilot.ownerUin, '123456');
  assert.equal(saved.incidentPilot.notifyWarnings, false);
  assert.equal(saved.incidentPilot.duplicateWindowMinutes, 30);
  assert.equal(saved.incidentPilot.unknownWritesBlockChat, true);
  assert.equal(saved.incidentPilot.retentionDays, 120);
  assert.equal(incidentPilotEnabled(), true);
  assert.equal(saved.autoUpdate.enabled, true);
  assert.equal(saved.autoUpdate.ownerUin, '123456');
  assert.equal(saved.autoUpdate.intervalHours, 12);
  assert.equal(saved.autoUpdate.repository, 'https://github.com/carbonbromine/qq-agent.git');
  assert.equal(saved.wakeDelayMinMs, 6000);
  assert.equal(saved.wakeDelayMaxMs, 14000);
  assert.equal(saved.wakeDelayMs, 10000);
  assert.equal(saved.conversation.lifecycleRolloverInputTokens, 36000);
  assert.equal(conversationConfigForChat('group:100').mode, 'lifecycle');
  assert.equal(conversationConfigForChat('group:200').mode, 'legacy');
  assert.equal(conversationConfigForChat('group:300').mode, 'threaded');
  assert.equal(conversationConfigForChat('private:100').mode, 'threaded');
  updateConfig({
    identityPilot: {
      friendProposal: {
        mode: 'triggered',
        triggered: {
          probability: 0,
          minMessages: 0,
          minActiveDays: 0,
          minDirectExchanges: 0,
          maxReviewsPerDay: 0
        }
      }
    }
  });
  assert.equal(getConfig().identityPilot.friendProposal.triggered.probability, 0);
  assert.equal(getConfig().identityPilot.friendProposal.triggered.minMessages, 0);
  assert.equal(getConfig().identityPilot.friendProposal.triggered.maxReviewsPerDay, 0);
  assert.throws(() => updateConfig({
    identityPilot: {
      friendProposal: {
        triggered: {
          weights: { quality: 40, interest: 40, reciprocity: 20, stability: 10 }
        }
      }
    }
  }), /权重合计必须为 100/);
  updateConfig({ identityPilot: { enabled: false } });
  const disabled = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(disabled.identityPilot.enabled, false);
  assert.equal(disabled.identityPilot.graduated, true);
  assert.equal(disabled.identityPilot.friendProposal.graduated, true);
  assert.equal(identityPilotEnabled(), false);
  assert.equal(friendProposalEnabled(), false);
  assert.equal(friendRequestDispatchEnabled(), false);
  assert.equal(incomingFriendRequestEnabled(), false);
  updateConfig({ slangPilot: { enabled: false } });
  assert.equal(slangPilotEnabled(), false);
  assert.equal(getConfig().slangPilot.graduated, true);
  updateConfig({ incidentPilot: { enabled: false } });
  assert.equal(incidentPilotEnabled(), false);
  assert.equal(getConfig().incidentPilot.graduated, true);
  updateConfig({ autoUpdate: { enabled: false } });
  assert.equal(getConfig().autoUpdate.enabled, false);
  assert.throws(
    () => updateConfig({
      identityPilot: { enabled: true, friendProposal: { enabled: true, ownerUin: '' } }
    }),
    /管理员 QQ/
  );
  assert.throws(
    () => updateConfig({ slangPilot: { enabled: true, ownerUin: '' } }),
    /黑话语料库试点需要配置审批管理员 QQ/
  );
  assert.throws(
    () => updateConfig({ incidentPilot: { enabled: true, ownerUin: '' } }),
    /异常处理试点需要配置告警管理员 QQ/
  );
  assert.throws(
    () => updateConfig({ autoUpdate: { enabled: true, ownerUin: '' } }),
    /自动更新需要配置告警管理员 QQ/
  );
  assert.throws(
    () => updateConfig({ autoUpdate: { repository: 'https://example.com/repo.git' } }),
    /GitHub HTTPS/
  );
  assert.throws(() => updateConfig({ conversation: { mode: 'invalid' } }), /conversation mode/);
  assert.throws(
    () => updateConfig({ conversation: { groupModes: { 100: 'invalid' } } }),
    /group conversation mode/
  );
  await t.test('persists multiple moment windows and rejects invalid updates atomically', () => {
    const windows = [
      { start: '12:00', end: '14:00', count: 2 },
      { start: '23:00', end: '01:00', count: 3 }
    ];
    updateConfig({ dailyMoments: { scheduleWindows: windows } });
    const configPath = path.join(dir, 'config.json');
    const before = fs.readFileSync(configPath, 'utf8');
    assert.deepEqual(JSON.parse(before).dailyMoments.scheduleWindows, windows);
    for (const invalid of [
      [],
      [{ start: '12:00', end: '12:05', count: 2 }],
      [...windows, { start: '00:30', end: '02:00', count: 1 }]
    ]) {
      assert.throws(() => updateConfig({ dailyMoments: { scheduleWindows: invalid } }));
      assert.equal(fs.readFileSync(configPath, 'utf8'), before);
      assert.deepEqual(getConfig().dailyMoments.scheduleWindows, windows);
    }
    updateConfig({ dailyMoments: { scheduleWindows: null, hour: 17, minute: 30 } });
    const fixed = JSON.parse(fs.readFileSync(configPath, 'utf8')).dailyMoments;
    assert.equal(fixed.scheduleWindows, null);
    assert.equal(fixed.hour, 17);
    assert.equal(fixed.minute, 30);
  });
});
