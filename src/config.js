// Stable configuration facade.
//
// The historical implementation remains in config-legacy.js so all existing
// migrations, normalization and persistence code keeps working. This facade
// owns production feature invariants that are no longer user-switchable.
import * as legacy from './config-legacy.js';
import {
  applyStableFeaturePolicy,
  stableFeatureFingerprint,
  suspendLegacyExperimentalGates
} from './stable-feature-policy.js';

export * from './config-legacy.js';

function stabilize(config, { persist = false } = {}) {
  const before = stableFeatureFingerprint(config);
  applyStableFeaturePolicy(config);
  if (persist && before !== stableFeatureFingerprint(config)) {
    legacy.scheduleConfigSave();
  }
  return config;
}

// Explicit exports override names re-exported by `export *`.
export const DEFAULT_CONFIG = applyStableFeaturePolicy(
  structuredClone(legacy.DEFAULT_CONFIG)
);

export function loadConfig() {
  return stabilize(legacy.loadConfig());
}

export function getConfig() {
  return stabilize(legacy.getConfig(), { persist: true });
}

export function identityPilotEnabled() {
  return true;
}

export function friendProposalEnabled() {
  return true;
}

export function triggeredFriendProposalEnabled(cfg = getConfig()) {
  return cfg?.identityPilot?.friendProposal?.mode === 'triggered';
}

export function promptFriendProposalEnabled(cfg = getConfig()) {
  return cfg?.identityPilot?.friendProposal?.mode !== 'triggered';
}

export function incomingFriendRequestEnabled() {
  return true;
}

export function friendRequestDispatchEnabled() {
  return true;
}

export function slangPilotEnabled() {
  return false;
}

export function incidentPilotEnabled() {
  return true;
}

export function updateConfig(patch) {
  // Reuse the mature legacy normalizer without allowing its obsolete
  // experimental owner validation to make unrelated settings unsaveable.
  suspendLegacyExperimentalGates(legacy.getConfig());
  const compatiblePatch = suspendLegacyExperimentalGates(
    structuredClone(patch && typeof patch === 'object' ? patch : {})
  );
  const updated = legacy.updateConfig(compatiblePatch);
  applyStableFeaturePolicy(updated);
  legacy.scheduleConfigSave();
  return updated;
}

export function setRuntimeConfig(config) {
  return legacy.setRuntimeConfig(applyStableFeaturePolicy(config));
}

export function scheduleConfigSave() {
  applyStableFeaturePolicy(legacy.getConfig());
  return legacy.scheduleConfigSave();
}
