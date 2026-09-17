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
      ownerUin: '12345678',
      mode: 'prompt',
      cooldownDays: 45,
      maxPending: 7
    }
  },
  slangPilot: {
    enabled: true,
    graduated: true,
    ownerUin: '45678901',
    minOccurrences: 2,
    webResearch: true,
    maxResearchRounds: 5
  },
  incidentPilot: {
    enabled: false,
    graduated: false,
    ownerUin: '87654321',
    retentionDays: 123
  },
  autoUpdate: {
    enabled: false,
    ownerUin: '56789012'
  },
  relationshipPilot: { enabled: true, minNewMessages: 4 },
  allow: { groups: [], private: [] },
  deny: { groups: [], private: ['12345678'] },
  ui: { refreshMs: 15000 }
}, null, 2));

const {
  DEFAULT_CONFIG,
  adminOwnerUin,
  friendProposalEnabled,
  friendRequestDispatchEnabled,
  getConfig,
  identityPilotEnabled,
  incomingFriendRequestEnabled,
  incidentPilotEnabled,
  promptFriendProposalEnabled,
  relationshipV2Enabled,
  slangPilotEnabled,
  triggeredFriendProposalEnabled,
  updateConfig
} = await import('../src/config.js');

test('promoted capabilities share one admin and retired slang config is purged', async (t) => {
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(DEFAULT_CONFIG.identityPilot.enabled, true);
  assert.equal(DEFAULT_CONFIG.identityPilot.incomingFriendRequest.enabled, true);
  assert.equal(DEFAULT_CONFIG.identityPilot.friendProposal.enabled, true);
  assert.equal(DEFAULT_CONFIG.identityPilot.friendProposal.activeDispatchEnabled, true);
  assert.equal(DEFAULT_CONFIG.incidentPilot.enabled, true);
  assert.deepEqual(DEFAULT_CONFIG.slangPilot, { enabled: false, graduated: false });
  assert.equal(DEFAULT_CONFIG.relationshipV2.enabled, false);
  assert.equal(DEFAULT_CONFIG.relationshipV2.behaviorInjectionEnabled, false);
  assert.equal(DEFAULT_CONFIG.admin.ownerUin, '');

  // Old installs had separate owner fields. Identity/Friends is the migration
  // priority. Current administrator consumers keep compatibility mirrors, while
  // retired slang research loses all owner/tuning configuration entirely.
  const cfg = getConfig();
  assert.equal('relationshipPilot' in cfg, false);
  assert.equal(cfg.relationshipV2.enabled, false);
  assert.equal(cfg.relationshipV2.minDirectMessages, 6);
  assert.equal(relationshipV2Enabled(cfg), false);
  assert.equal(adminOwnerUin(cfg), '12345678');
  assert.equal(cfg.admin.ownerUin, '12345678');
  assert.equal(cfg.identityPilot.friendProposal.ownerUin, '12345678');
  assert.equal(cfg.incidentPilot.ownerUin, '12345678');
  assert.equal(cfg.autoUpdate.ownerUin, '12345678');
  assert.deepEqual(cfg.slangPilot, { enabled: false, graduated: false });
  assert.ok(cfg.allow.private.includes('12345678'));
  assert.ok(!cfg.deny.private.includes('12345678'));

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

  assert.equal(identityPilotEnabled({ identityPilot: { enabled: false } }), true);
  assert.equal(friendProposalEnabled({}), true);
  assert.equal(friendRequestDispatchEnabled({}), true);
  assert.equal(incomingFriendRequestEnabled({}), true);
  assert.equal(incidentPilotEnabled({ incidentPilot: { enabled: false } }), true);
  assert.equal(slangPilotEnabled({ slangPilot: { enabled: true } }), false);
  assert.equal(promptFriendProposalEnabled(cfg), true);
  assert.equal(triggeredFriendProposalEnabled(cfg), false);

  // Stale callers may still POST removed gates and old per-feature owners.
  // None can disable stable infrastructure, change the administrator
  // independently, or revive retired slang-research settings.
  const stale = updateConfig({
    identityPilot: {
      enabled: false,
      incomingFriendRequest: { enabled: false },
      friendProposal: {
        enabled: false,
        activeDispatchEnabled: false,
        ownerUin: '22222222'
      }
    },
    incidentPilot: { enabled: false, ownerUin: '33333333' },
    autoUpdate: { ownerUin: '44444444' },
    slangPilot: {
      enabled: true,
      graduated: true,
      ownerUin: '55555555',
      minOccurrences: 1,
      webResearch: true
    },
    relationshipV2: {
      enabled: true,
      graduated: true,
      behaviorInjectionEnabled: true,
      minDirectMessages: 9,
      perUserCooldownHours: 18
    },
    ui: { refreshMs: 7000 }
  });

  assert.equal(stale.ui.refreshMs, 7000);
  assert.equal(stale.admin.ownerUin, '12345678');
  assert.equal(stale.identityPilot.friendProposal.ownerUin, '12345678');
  assert.equal(stale.incidentPilot.ownerUin, '12345678');
  assert.equal(stale.autoUpdate.ownerUin, '12345678');
  assert.deepEqual(stale.slangPilot, { enabled: false, graduated: false });
  assert.equal(stale.relationshipV2.enabled, true);
  assert.equal(stale.relationshipV2.graduated, true);
  assert.equal(stale.relationshipV2.behaviorInjectionEnabled, true);
  assert.equal(stale.relationshipV2.minDirectMessages, 9);
  assert.equal(stale.relationshipV2.perUserCooldownHours, 18);
  assert.equal(relationshipV2Enabled(stale), true);
  assert.equal(stale.identityPilot.enabled, true);
  assert.equal(stale.identityPilot.incomingFriendRequest.enabled, true);
  assert.equal(stale.identityPilot.friendProposal.enabled, true);
  assert.equal(stale.identityPilot.friendProposal.activeDispatchEnabled, true);
  assert.equal(stale.incidentPilot.enabled, true);

  // The global setting is the only supported write path. It fans out to the
  // remaining compatibility mirrors and guarantees private admin access.
  const next = updateConfig({ admin: { ownerUin: '23456789' } });
  assert.equal(adminOwnerUin(next), '23456789');
  assert.equal(next.identityPilot.friendProposal.ownerUin, '23456789');
  assert.equal(next.incidentPilot.ownerUin, '23456789');
  assert.equal(next.autoUpdate.ownerUin, '23456789');
  assert.deepEqual(next.slangPilot, { enabled: false, graduated: false });
  assert.ok(next.allow.private.includes('23456789'));
  assert.ok(!next.deny.private.includes('23456789'));

  assert.throws(
    () => updateConfig({ admin: { ownerUin: 'not-a-qq' } }),
    /管理员 QQ 必须为 5 到 15 位数字/
  );

  await new Promise((resolve) => setTimeout(resolve, 500));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.ui.refreshMs, 7000);
  assert.equal(saved.admin.ownerUin, '23456789');
  assert.equal(saved.identityPilot.friendProposal.ownerUin, '23456789');
  assert.equal(saved.incidentPilot.ownerUin, '23456789');
  assert.equal(saved.autoUpdate.ownerUin, '23456789');
  assert.equal(saved.identityPilot.enabled, true);
  assert.equal(saved.identityPilot.incomingFriendRequest.enabled, true);
  assert.equal(saved.identityPilot.friendProposal.enabled, true);
  assert.equal(saved.identityPilot.friendProposal.activeDispatchEnabled, true);
  assert.equal(saved.incidentPilot.enabled, true);
  assert.equal(saved.relationshipV2.enabled, true);
  assert.equal(saved.relationshipV2.graduated, true);
  assert.equal(saved.relationshipV2.behaviorInjectionEnabled, true);
  assert.equal(saved.relationshipV2.minDirectMessages, 9);
  assert.deepEqual(saved.slangPilot, { enabled: false, graduated: false });
});
