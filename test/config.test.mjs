import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-stable-'));
process.env.QQ_AGENT_DATA_DIR = dir;

fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
  identityPilot: {
    enabled: false,
    graduated: false,
    incomingFriendRequest: {
      enabled: false,
      autoWhitelist: false,
      maxPending: 25
    },
    friendProposal: {
      enabled: false,
      graduated: false,
      activeDispatchEnabled: false,
      ownerUin: '',
      mode: 'prompt',
      cooldownDays: 45,
      maxPending: 7
    }
  },
  slangPilot: {
    enabled: true,
    graduated: true,
    ownerUin: ''
  },
  incidentPilot: {
    enabled: false,
    graduated: false,
    ownerUin: '',
    retentionDays: 123
  },
  ui: { refreshMs: 15000 }
}, null, 2));

const {
  DEFAULT_CONFIG,
  friendProposalEnabled,
  friendRequestDispatchEnabled,
  getConfig,
  identityPilotEnabled,
  incomingFriendRequestEnabled,
  incidentPilotEnabled,
  promptFriendProposalEnabled,
  slangPilotEnabled,
  triggeredFriendProposalEnabled,
  updateConfig
} = await import('../src/config.js');

test('promoted production capabilities ignore historical feature gates without losing tuning', async (t) => {
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(DEFAULT_CONFIG.identityPilot.enabled, true);
  assert.equal(DEFAULT_CONFIG.identityPilot.incomingFriendRequest.enabled, true);
  assert.equal(DEFAULT_CONFIG.identityPilot.friendProposal.enabled, true);
  assert.equal(DEFAULT_CONFIG.identityPilot.friendProposal.activeDispatchEnabled, true);
  assert.equal(DEFAULT_CONFIG.incidentPilot.enabled, true);
  assert.equal(DEFAULT_CONFIG.slangPilot.enabled, false);

  const cfg = getConfig();
  assert.equal(cfg.identityPilot.enabled, true);
  assert.equal(cfg.identityPilot.graduated, true);
  assert.equal(cfg.identityPilot.incomingFriendRequest.enabled, true);
  assert.equal(cfg.identityPilot.friendProposal.enabled, true);
  assert.equal(cfg.identityPilot.friendProposal.graduated, true);
  assert.equal(cfg.identityPilot.friendProposal.activeDispatchEnabled, true);
  assert.equal(cfg.identityPilot.incomingFriendRequest.autoWhitelist, false);
  assert.equal(cfg.identityPilot.incomingFriendRequest.maxPending, 25);
  assert.equal(cfg.identityPilot.friendProposal.mode, 'prompt');
  assert.equal(cfg.identityPilot.friendProposal.cooldownDays, 45);
  assert.equal(cfg.identityPilot.friendProposal.maxPending, 7);
  assert.equal(cfg.incidentPilot.enabled, true);
  assert.equal(cfg.incidentPilot.graduated, true);
  assert.equal(cfg.incidentPilot.retentionDays, 123);
  assert.equal(cfg.slangPilot.enabled, false);
  assert.equal(cfg.slangPilot.graduated, false);

  assert.equal(identityPilotEnabled({ identityPilot: { enabled: false } }), true);
  assert.equal(friendProposalEnabled({}), true);
  assert.equal(friendRequestDispatchEnabled({}), true);
  assert.equal(incomingFriendRequestEnabled({}), true);
  assert.equal(incidentPilotEnabled({ incidentPilot: { enabled: false } }), true);
  assert.equal(slangPilotEnabled({ slangPilot: { enabled: true } }), false);
  assert.equal(promptFriendProposalEnabled(cfg), true);
  assert.equal(triggeredFriendProposalEnabled(cfg), false);

  // Direct or stale callers may still POST the removed gates. They must not be
  // able to disable stable infrastructure or revive retired slang research.
  // Missing approval-owner QQ must also not block unrelated configuration saves.
  const next = updateConfig({
    identityPilot: {
      enabled: false,
      incomingFriendRequest: { enabled: false },
      friendProposal: {
        enabled: false,
        activeDispatchEnabled: false,
        ownerUin: ''
      }
    },
    incidentPilot: { enabled: false, ownerUin: '' },
    slangPilot: { enabled: true, graduated: true, ownerUin: '' },
    ui: { refreshMs: 7000 }
  });

  assert.equal(next.ui.refreshMs, 7000);
  assert.equal(next.identityPilot.enabled, true);
  assert.equal(next.identityPilot.incomingFriendRequest.enabled, true);
  assert.equal(next.identityPilot.friendProposal.enabled, true);
  assert.equal(next.identityPilot.friendProposal.activeDispatchEnabled, true);
  assert.equal(next.incidentPilot.enabled, true);
  assert.equal(next.slangPilot.enabled, false);

  await new Promise((resolve) => setTimeout(resolve, 500));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.ui.refreshMs, 7000);
  assert.equal(saved.identityPilot.enabled, true);
  assert.equal(saved.identityPilot.incomingFriendRequest.enabled, true);
  assert.equal(saved.identityPilot.friendProposal.enabled, true);
  assert.equal(saved.identityPilot.friendProposal.activeDispatchEnabled, true);
  assert.equal(saved.incidentPilot.enabled, true);
  assert.equal(saved.slangPilot.enabled, false);
  assert.equal(saved.slangPilot.graduated, false);
});
