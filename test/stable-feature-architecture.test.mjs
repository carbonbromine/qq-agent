import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { autoUpdateOwner } from '../src/auto-update.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('promoted-feature UI uses render-boundary normalization instead of DOM mutation polling', () => {
  const source = read('ui/stable-features.js');
  assert.doesNotMatch(source, /new\s+MutationObserver\s*\(/);
  assert.match(source, /renderExperimentalSettingsSection/);
  assert.match(source, /renderFriendFeaturePage/);
  assert.match(source, /renderIncidentFeaturePage/);
  assert.match(source, /cfg-global-admin-owner/);
});

test('auto update uses global admin once migrated and only falls back for pre-admin legacy files', () => {
  assert.equal(autoUpdateOwner({
    admin: { ownerUin: '12345678' },
    autoUpdate: { ownerUin: '87654321' },
    incidentPilot: { ownerUin: '22222222' },
    identityPilot: { friendProposal: { ownerUin: '33333333' } }
  }), '12345678');

  // An explicitly empty admin remains authoritative; old mirrors cannot revive it.
  assert.equal(autoUpdateOwner({
    admin: { ownerUin: '' },
    autoUpdate: { ownerUin: '87654321' }
  }), '');

  // The standalone updater can start before the main process migrates an old
  // config.json, so a file with no admin section gets one read-only fallback.
  assert.equal(autoUpdateOwner({
    autoUpdate: { ownerUin: '87654321' }
  }), '87654321');
});

test('retired slang research has no canonical owner or tuning configuration', async () => {
  const mod = await import(`../src/stable-feature-policy.js?test=${Date.now()}`);
  const cfg = {
    admin: { ownerUin: '12345678' },
    slangPilot: {
      enabled: true,
      graduated: true,
      ownerUin: '87654321',
      minOccurrences: 1,
      maxResearchRounds: 99,
      webResearch: true
    }
  };
  mod.applyStableFeaturePolicy(cfg);
  assert.deepEqual(cfg.slangPilot, { enabled: false, graduated: false });
});
