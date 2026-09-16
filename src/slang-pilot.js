const RETIRED_MESSAGE = '黑话研究已下线；手工黑话资产库仍可正常使用';

export function inactiveSlangPilotStatus({ error = '' } = {}) {
  return {
    enabled: false,
    active: false,
    retired: true,
    databaseExists: false,
    error: String(error || ''),
    pendingResearch: 0,
    researching: 0,
    pendingAdmission: 0,
    admitted: 0,
    rejected: 0,
    failed: 0,
    counts: {}
  };
}

/**
 * Compatibility tombstone for callers that still import SlangPilotManager.
 * The production config facade permanently reports slangPilotEnabled=false,
 * so createApp never constructs this class. Keeping the API surface avoids a
 * hard import failure while old routes/UI disappear during the same release.
 */
export class SlangPilotManager {
  constructor() {
    this.active = false;
  }

  status() { return inactiveSlangPilotStatus(); }
  start() { return this.status(); }
  async stop() { this.active = false; }
  observeMessage() {}
  abortResearch() {}
  resumeQueued() {}
  list() { return []; }
  detail() { return null; }

  decideResearch() { throw new Error(RETIRED_MESSAGE); }
  decideAdmission() { throw new Error(RETIRED_MESSAGE); }
  retryResearch() { throw new Error(RETIRED_MESSAGE); }
}
