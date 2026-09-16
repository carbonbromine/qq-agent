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

export function stableFeatureFingerprint(config = {}) {
  return JSON.stringify({
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
 * Apply the production feature invariants in-place while preserving all
 * operational tuning fields (owners, thresholds, retention policy, etc.).
 */
export function applyStableFeaturePolicy(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;

  const identity = objectSection(config, 'identityPilot');
  identity.enabled = true;
  identity.graduated = true;

  const incoming = objectSection(identity, 'incomingFriendRequest');
  incoming.enabled = true;

  const friend = objectSection(identity, 'friendProposal');
  friend.enabled = true;
  friend.graduated = true;
  friend.activeDispatchEnabled = true;

  // Keep the old object as a compatibility tombstone so older callers can
  // still read it, but make it impossible to reactivate the retired worker.
  const slang = objectSection(config, 'slangPilot');
  slang.enabled = false;
  slang.graduated = false;

  const incident = objectSection(config, 'incidentPilot');
  incident.enabled = true;
  incident.graduated = true;

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
