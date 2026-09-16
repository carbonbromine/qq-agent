// Stable configuration facade.
//
// The historical implementation remains in config-legacy.js so all existing
// migrations, normalization and persistence code keeps working. This facade
// owns production feature invariants that are no longer user-switchable and
// the one global administrator QQ used by every subsystem.
import * as legacy from './config-legacy.js';
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
  patch.slangPilot = {
    ...(patch.slangPilot || {}),
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
  return stabilize(legacy.getConfig(), { persist: true });
}

/** The only administrator QQ configuration read by production code. */
export function adminOwnerUin(cfg = getConfig()) {
  return globalAdminUin(cfg);
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
  const current = stabilize(legacy.getConfig());
  const rawPatch = structuredClone(
    patch && typeof patch === 'object' ? patch : {}
  );
  const requestedAdmin = normalizedRequestedAdmin(rawPatch, current);
  const autoUpdateEnabled = hasOwn(rawPatch?.autoUpdate, 'enabled')
    ? rawPatch.autoUpdate.enabled === true
    : current.autoUpdate?.enabled === true;

  // Auto update still has a real notification/approval dependency. Prevent an
  // impossible state instead of allowing the old validator to poison later,
  // unrelated config saves.
  if (!requestedAdmin.ownerUin && autoUpdateEnabled) {
    throw new Error('自动更新已启用，不能清空全局管理员 QQ');
  }

  // Reuse the mature legacy normalizer without allowing obsolete per-feature
  // owner switches to become independent configuration sources. All legacy
  // owner fields receive the global administrator only as compatibility mirrors.
  suspendLegacyExperimentalGates(current);
  const compatiblePatch = suspendLegacyExperimentalGates(rawPatch);
  mirrorAdminIntoLegacyPatch(compatiblePatch, requestedAdmin.ownerUin);
  ensureAdminPrivateAccess(compatiblePatch, current, requestedAdmin.ownerUin);

  try {
    const updated = legacy.updateConfig(compatiblePatch);
    return stabilize(updated);
  } finally {
    // The finally block is essential so an unrelated validation error can never
    // leave a production capability accidentally gated off in memory.
    applyStableFeaturePolicy(legacy.getConfig());
    legacy.scheduleConfigSave();
  }
}

export function setRuntimeConfig(config) {
  return legacy.setRuntimeConfig(applyStableFeaturePolicy(config));
}

export function scheduleConfigSave() {
  applyStableFeaturePolicy(legacy.getConfig());
  return legacy.scheduleConfigSave();
}
