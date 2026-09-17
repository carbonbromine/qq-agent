export const DEFAULT_RELATIONSHIP_V2_CONFIG = Object.freeze({
  enabled: false,
  graduated: false,
  behaviorInjectionEnabled: false,
  autoEvaluationEnabled: true,
  minDirectMessages: 6,
  perUserCooldownHours: 12,
  maxEvaluationsPerDay: 20,
  maxEvidenceMessages: 48,
  warmthHalfLifeHours: 12,
  tensionHalfLifeHours: 48,
  familiarityHalfLifeDays: 60,
  bondGraceDays: 30,
  bondHalfLifeDays: 180,
  model: ''
});

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max, fallback) => Math.min(max, Math.max(min, finite(value, fallback)));
const integer = (value, min, max, fallback) => Math.round(clamp(value, min, max, fallback));

export function normalizeRelationshipV2Config(raw = {}) {
  return {
    ...raw,
    enabled: raw.enabled === true,
    graduated: raw.graduated === true,
    behaviorInjectionEnabled: raw.behaviorInjectionEnabled === true,
    autoEvaluationEnabled: raw.autoEvaluationEnabled !== false,
    minDirectMessages: integer(raw.minDirectMessages, 3, 50, 6),
    perUserCooldownHours: clamp(raw.perUserCooldownHours, 1, 720, 12),
    maxEvaluationsPerDay: integer(raw.maxEvaluationsPerDay, 1, 200, 20),
    maxEvidenceMessages: integer(raw.maxEvidenceMessages, 12, 120, 48),
    warmthHalfLifeHours: clamp(raw.warmthHalfLifeHours, 1, 168, 12),
    tensionHalfLifeHours: clamp(raw.tensionHalfLifeHours, 6, 720, 48),
    familiarityHalfLifeDays: clamp(raw.familiarityHalfLifeDays, 7, 730, 60),
    bondGraceDays: clamp(raw.bondGraceDays, 0, 365, 30),
    bondHalfLifeDays: clamp(raw.bondHalfLifeDays, 30, 3650, 180),
    model: String(raw.model || '').trim().slice(0, 160)
  };
}

export function relationshipV2Enabled(config = {}) {
  return config?.relationshipV2?.enabled === true;
}
