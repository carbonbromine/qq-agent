import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

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

test('auto update resolves the administrator exclusively from config.admin', () => {
  const source = read('src/auto-update.js');
  const ownerFn = source.match(/export function autoUpdateOwner\(config = \{\}\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(ownerFn, /config\.admin\?\.ownerUin/);
  assert.doesNotMatch(ownerFn, /config\.autoUpdate\?\.ownerUin/);
  assert.doesNotMatch(ownerFn, /config\.incidentPilot\?\.ownerUin/);
  assert.doesNotMatch(ownerFn, /config\.identityPilot\?\.friendProposal\?\.ownerUin/);
});

test('retired slang research has no canonical owner or tuning configuration', async () => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.stable-feature-test-'));
  const previous = process.env.QQ_AGENT_DATA_DIR;
  process.env.QQ_AGENT_DATA_DIR = dir;
  try {
    // Cache-bust so this test does not share config module state with another
    // test file when a runner chooses the same process.
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
  } finally {
    if (previous === undefined) delete process.env.QQ_AGENT_DATA_DIR;
    else process.env.QQ_AGENT_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
