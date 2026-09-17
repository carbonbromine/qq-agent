// Production configuration adapter.
//
// The historical normalizer/persistence implementation remains in
// config-legacy.js for data-format compatibility. This module owns the current
// production invariants: promoted capabilities are not user-switchable,
// automated slang research is retired, and admin.ownerUin is the sole
// administrator configuration source.
import * as legacy from './config-legacy.js';
import {
  normalizeGlobalBlocklist,
  withGlobalBlocklistRuntimeView
} from './global-blocklist.js';
import {
  applyStableFeaturePolicy,
  globalAdminUin,
  stableFeatureFingerprint,
  suspendLegacyExperimentalGates
} from './stable-feature-policy.js';

export * from './config-legacy.js';

function stabilize(config, { persist = false } = {}) {
  const before = stableFeatureFingerprint(config);
  applyStableFeaturePolicy(config);
  const users = normalizeGlobalBlocklist(config?.deny?.users);
  config.deny = {
    ...(config.deny || {}),
    users
  };
  if (persist && before !== stableFeatureFingerprint(config)) {
    legacy.scheduleConfigSave();
  }
  return config;
}

function hasOwn(object, key) {
  return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
}

function normalizedRequestedAdmin(patch, current) {
  const explicit = hasOwn(patch?.admin, 'ownerUin');
  if (!explicit) return { explicit: false, ownerUin: globalAdminUin(current) };
  const ownerUin = String(patch.admin.ownerUin || '').trim();
  if (ownerUin && !/^\d{5,15}$/.test(ownerUin)) {
    throw new Error('管理员 QQ 必须为 5 到 15 位数字');
  }
  return { explicit: true, ownerUin };
}

function mirrorAdminIntoLegacyPatch(patch, ownerUin) {
  // These mirrors exist only until the remaining runtime modules stop reading
  // their historical paths. The retired slang worker intentionally has no
  // mirror at all: its old owner/tuning fields are removed by the policy.
  patch.identityPilot = {
    ...(patch.identityPilot || {}),
    friendProposal: {
      ...(patch.identityPilot?.friendProposal || {}),
      ownerUin
    }
  };
  patch.incidentPilot = {
    ...(patch.incidentPilot || {}),
    ownerUin
  };
  patch.autoUpdate = {
    ...(patch.autoUpdate || {}),
    ownerUin
  };
  return patch;
}

function ensureAdminPrivateAccess(patch, current, ownerUin) {
  if (!ownerUin) return patch;

  const requestedAllow = Array.isArray(patch.allow?.private)
    ? patch.allow.private.map(String)
    : (current.allow?.private || []).map(String);
  patch.allow = {
    ...(patch.allow || {}),
    private: [...new Set([...requestedAllow, ownerUin])]
  };

  const requestedDeny = Array.isArray(patch.deny?.private)
    ? patch.deny.private.map(String)
    : (current.deny?.private || []).map(String);
  patch.deny = {
    ...(patch.deny || {}),
    private: requestedDeny.filter((uin) => uin !== ownerUin)
  };
  return patch;
}

// Explicit exports override names re-exported by `export *`.
export const DEFAULT_CONFIG = applyStableFeaturePolicy(
  structuredClone(legacy.DEFAULT_CONFIG)
);

export function loadConfig() {
  return stabilize(legacy.loadConfig());
}

export function getConfig() {
  return withGlobalBlocklistRuntimeView(
    stabilize(legacy.getConfig(), { persist: true })
  );
}

/** The only administrator QQ configuration read/written by current code. */
export function adminOwnerUin(cfg = getConfig()) {
  return globalAdminUin(cfg);
}

// Compatibility helpers retained because current runtime modules still import
// the old names. They are constants now, not feature gates.
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

/** Compatibility tombstone: automated slang research cannot be reactivated. */
export function slangPilotEnabled() {
  return false;
}

export function incidentPilotEnabled() {
  return true;
}

export function updateConfig(patch) {
  const current = stabilize(legacy.getConfig());
  const rawPatch = structuredClone(
    patch && typeof patch === 'object' ? patch : {}
  );
  if (hasOwn(rawPatch?.deny, 'users')) {
    rawPatch.deny.users = normalizeGlobalBlocklist(rawPatch.deny.users, { strict: true });
  }
  const requestedAdmin = normalizedRequestedAdmin(rawPatch, current);
  const autoUpdateEnabled = hasOwn(rawPatch?.autoUpdate, 'enabled')
    ? rawPatch.autoUpdate.enabled === true
    : current.autoUpdate?.enabled === true;

  // Auto update has a real notification dependency. Promoted Identity/Incident
  // infrastructure does not: it remains active with no administrator and only
  // skips QQ notification/approval edges.
  if (!requestedAdmin.ownerUin && autoUpdateEnabled) {
    throw new Error('自动更新已启用，不能清空全局管理员 QQ');
  }

  // Reuse the mature legacy normalizer without allowing obsolete experimental
  // gates or per-feature owner fields to become configuration sources again.
  suspendLegacyExperimentalGates(current);
  const compatiblePatch = suspendLegacyExperimentalGates(rawPatch);
  mirrorAdminIntoLegacyPatch(compatiblePatch, requestedAdmin.ownerUin);
  ensureAdminPrivateAccess(compatiblePatch, current, requestedAdmin.ownerUin);

  try {
    const updated = legacy.updateConfig(compatiblePatch);
    return stabilize(updated);
  } finally {
    // An unrelated validation error must never leave promoted infrastructure
    // gated off in the in-memory legacy object.
    applyStableFeaturePolicy(legacy.getConfig());
    legacy.scheduleConfigSave();
  }
}

export function setRuntimeConfig(config) {
  return legacy.setRuntimeConfig(stabilize(applyStableFeaturePolicy(config)));
}

export function scheduleConfigSave() {
  applyStableFeaturePolicy(legacy.getConfig());
  return legacy.scheduleConfigSave();
}
