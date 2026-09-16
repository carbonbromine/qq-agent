export const STABLE_FEATURE_POLICY = Object.freeze({
  identityPilot: true,
  incomingFriendRequest: true,
  friendProposal: true,
  friendRequestDispatch: true,
  incidentPilot: true,
  slangPilot: false
});

function objectSection(parent, key) {
  if (!parent[key] || typeof parent[key] !== 'object' || Array.isArray(parent[key])) {
    parent[key] = {};
  }
  return parent[key];
}

function normalizedAdminUin(value) {
  const uin = String(value || '').trim();
  return /^\d{5,15}$/.test(uin) ? uin : '';
}

function legacyAdminCandidates(config = {}) {
  return [
    config?.identityPilot?.friendProposal?.ownerUin,
    config?.incidentPilot?.ownerUin,
    config?.autoUpdate?.ownerUin,
    config?.slangPilot?.ownerUin
  ];
}

/** Return the one global administrator QQ used by every subsystem. */
export function globalAdminUin(config = {}) {
  return normalizedAdminUin(config?.admin?.ownerUin);
}

function adminAccessState(config = {}, ownerUin = '') {
  const privateAllow = Array.isArray(config?.allow?.private)
    ? config.allow.private.map(String)
    : [];
  const privateDeny = Array.isArray(config?.deny?.private)
    ? config.deny.private.map(String)
    : [];
  return {
    allowed: !ownerUin || config.allowAllWhenEmpty === true || privateAllow.includes(ownerUin),
    denied: Boolean(ownerUin && privateDeny.includes(ownerUin))
  };
}

export function stableFeatureFingerprint(config = {}) {
  const ownerUin = normalizedAdminUin(config?.admin?.ownerUin);
  const access = adminAccessState(config, ownerUin);
  return JSON.stringify({
    adminPresent: Boolean(
      config?.admin
      && typeof config.admin === 'object'
      && !Array.isArray(config.admin)
    ),
    adminOwnerUin: ownerUin,
    adminAllowed: access.allowed,
    adminDenied: access.denied,
    identityOwnerUin: normalizedAdminUin(config?.identityPilot?.friendProposal?.ownerUin),
    incidentOwnerUin: normalizedAdminUin(config?.incidentPilot?.ownerUin),
    updateOwnerUin: normalizedAdminUin(config?.autoUpdate?.ownerUin),
    slangOwnerUin: normalizedAdminUin(config?.slangPilot?.ownerUin),
    identity: config?.identityPilot?.enabled === true,
    identityGraduated: config?.identityPilot?.graduated === true,
    incomingFriend: config?.identityPilot?.incomingFriendRequest?.enabled === true,
    friendProposal: config?.identityPilot?.friendProposal?.enabled === true,
    friendGraduated: config?.identityPilot?.friendProposal?.graduated === true,
    friendDispatch: config?.identityPilot?.friendProposal?.activeDispatchEnabled === true,
    slang: config?.slangPilot?.enabled === true,
    slangGraduated: config?.slangPilot?.graduated === true,
    incident: config?.incidentPilot?.enabled === true,
    incidentGraduated: config?.incidentPilot?.graduated === true
  });
}

/**
 * Apply production invariants in-place while preserving operational tuning.
 *
 * Administrator migration:
 * - once config.admin exists it is the sole source of truth, including an
 *   intentionally empty ownerUin;
 * - old installs without config.admin migrate the first valid historical owner
 *   in this order: Identity/Friends -> Incident -> Auto Update -> Slang;
 * - historical ownerUin fields remain synchronized compatibility mirrors only;
 * - a configured administrator is automatically allowed to private-message the
 *   bot and removed from the private deny list, so QQ approval commands work.
 */
export function applyStableFeaturePolicy(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;

  const hadAdminSection = Boolean(
    config.admin
    && typeof config.admin === 'object'
    && !Array.isArray(config.admin)
  );
  const admin = objectSection(config, 'admin');
  let ownerUin = normalizedAdminUin(admin.ownerUin);
  if (!hadAdminSection) {
    ownerUin = legacyAdminCandidates(config)
      .map(normalizedAdminUin)
      .find(Boolean) || '';
  }
  admin.ownerUin = ownerUin;

  if (ownerUin) {
    const allow = objectSection(config, 'allow');
    const privateAllow = Array.isArray(allow.private) ? allow.private.map(String) : [];
    allow.private = [...new Set([...privateAllow, ownerUin])];

    const deny = objectSection(config, 'deny');
    const privateDeny = Array.isArray(deny.private) ? deny.private.map(String) : [];
    deny.private = privateDeny.filter((uin) => uin !== ownerUin);
  }

  const identity = objectSection(config, 'identityPilot');
  identity.enabled = true;
  identity.graduated = true;

  const incoming = objectSection(identity, 'incomingFriendRequest');
  incoming.enabled = true;

  const friend = objectSection(identity, 'friendProposal');
  friend.enabled = true;
  friend.graduated = true;
  friend.activeDispatchEnabled = true;
  friend.ownerUin = ownerUin;

  // Keep the old object as a compatibility tombstone so older callers can
  // still read it, but make it impossible to reactivate the retired worker.
  const slang = objectSection(config, 'slangPilot');
  slang.enabled = false;
  slang.graduated = false;
  slang.ownerUin = ownerUin;

  const incident = objectSection(config, 'incidentPilot');
  incident.enabled = true;
  incident.graduated = true;
  incident.ownerUin = ownerUin;

  // Auto update is not forced on, but its administrator is global as well.
  const autoUpdate = objectSection(config, 'autoUpdate');
  autoUpdate.ownerUin = ownerUin;

  return config;
}

/**
 * The legacy validator tied "enabled" to experimental owner requirements.
 * Stable infrastructure must be able to start before an optional notification
 * owner is configured, so validation runs with only those obsolete gates down.
 * The public facade reapplies the production invariants immediately afterwards.
 */
export function suspendLegacyExperimentalGates(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;

  const identity = objectSection(config, 'identityPilot');
  identity.enabled = false;
  identity.graduated = false;
  objectSection(identity, 'incomingFriendRequest').enabled = false;
  const friend = objectSection(identity, 'friendProposal');
  friend.enabled = false;
  friend.graduated = false;
  friend.activeDispatchEnabled = false;

  const slang = objectSection(config, 'slangPilot');
  slang.enabled = false;
  slang.graduated = false;

  const incident = objectSection(config, 'incidentPilot');
  incident.enabled = false;
  incident.graduated = false;

  return config;
}
