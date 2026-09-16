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
    ownerUin: '45678901'
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
  slangPilotEnabled,
  triggeredFriendProposalEnabled,
  updateConfig
} = await import('../src/config.js');

test('stable capabilities and all administrator consumers share one global owner', async (t) => {
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(DEFAULT_CONFIG.identityPilot.enabled, true);
  assert.equal(DEFAULT_CONFIG.identityPilot.incomingFriendRequest.enabled, true);
  assert.equal(DEFAULT_CONFIG.identityPilot.friendProposal.enabled, true);
  assert.equal(DEFAULT_CONFIG.identityPilot.friendProposal.activeDispatchEnabled, true);
  assert.equal(DEFAULT_CONFIG.incidentPilot.enabled, true);
  assert.equal(DEFAULT_CONFIG.slangPilot.enabled, false);
  assert.equal(DEFAULT_CONFIG.admin.ownerUin, '');

  // Old installs had separate owner fields. Identity/Friends is the migration
  // priority; after migration every historical field becomes only a mirror.
  const cfg = getConfig();
  assert.equal(adminOwnerUin(cfg), '12345678');
  assert.equal(cfg.admin.ownerUin, '12345678');
  assert.equal(cfg.identityPilot.friendProposal.ownerUin, '12345678');
  assert.equal(cfg.incidentPilot.ownerUin, '12345678');
  assert.equal(cfg.autoUpdate.ownerUin, '12345678');
  assert.equal(cfg.slangPilot.ownerUin, '12345678');
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

  // Stale callers may still POST removed gates and historical per-feature owner
  // fields. None of those writes may disable stable infrastructure or change
  // the administrator independently.
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
    slangPilot: { enabled: true, graduated: true, ownerUin: '55555555' },
    ui: { refreshMs: 7000 }
  });

  assert.equal(stale.ui.refreshMs, 7000);
  assert.equal(stale.admin.ownerUin, '12345678');
  assert.equal(stale.identityPilot.friendProposal.ownerUin, '12345678');
  assert.equal(stale.incidentPilot.ownerUin, '12345678');
  assert.equal(stale.autoUpdate.ownerUin, '12345678');
  assert.equal(stale.slangPilot.ownerUin, '12345678');
  assert.equal(stale.identityPilot.enabled, true);
  assert.equal(stale.identityPilot.incomingFriendRequest.enabled, true);
  assert.equal(stale.identityPilot.friendProposal.enabled, true);
  assert.equal(stale.identityPilot.friendProposal.activeDispatchEnabled, true);
  assert.equal(stale.incidentPilot.enabled, true);
  assert.equal(stale.slangPilot.enabled, false);

  // The global setting is the only supported write path. It fans out to every
  // compatibility mirror and guarantees private admin access.
  const next = updateConfig({ admin: { ownerUin: '23456789' } });
  assert.equal(adminOwnerUin(next), '23456789');
  assert.equal(next.identityPilot.friendProposal.ownerUin, '23456789');
  assert.equal(next.incidentPilot.ownerUin, '23456789');
  assert.equal(next.autoUpdate.ownerUin, '23456789');
  assert.equal(next.slangPilot.ownerUin, '23456789');
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
  assert.equal(saved.slangPilot.enabled, false);
  assert.equal(saved.slangPilot.graduated, false);
});
