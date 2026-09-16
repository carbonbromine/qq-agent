import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { ChatStore } from '../src/store.js';
import { IdentityPilotManager } from '../src/identity-pilot.js';
import { relationshipDatabasePath } from '../src/relationship-pilot-store.js';
import '../src/relationship-runtime-integration.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-rel-boundary-'));
const chatStore = new ChatStore(0, { dataDir, filename: path.join(dataDir, 'messages.sqlite') });

function config() {
  return {
    api: { model: 'test-model' },
    allowAllWhenEmpty: true,
    allow: { groups: [], private: [] },
    deny: { groups: [], private: [] },
    blocklist: {},
    identityPilot: { enabled: true, friendProposal: { enabled: false } },
    relationshipPilot: { enabled: true }
  };
}

const manager = new IdentityPilotManager({
  store: chatStore,
  onebot: { selfId: '99999' },
  dataDir,
  config,
  complete: async () => { throw new Error('model should not be called'); },
  emit: () => {},
  log: () => {}
});
// Relationship runtime only needs Identity Pilot to be active; no remote friend sync is needed here.
manager.identityStore = {};

after(() => {
  try { manager.stop(); } catch {}
  try { chatStore.close(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('runtime store ignores duplicate unresolved boundary flags for one person', () => {
  manager.relationshipFor('12345');
  const db = new DatabaseSync(relationshipDatabasePath(dataDir));
  try {
    const insert = db.prepare(`INSERT INTO relationship_flags
      (id,uin,type,status,source_event_id,created_at)
      VALUES (?,?,?,'open',?,?)`);
    insert.run('flag-a', '12345', 'boundary_violation', 'event-a', 1000);
    insert.run('flag-b', '12345', 'boundary_violation', 'event-b', 2000);
    const count = Number(db.prepare(`SELECT COUNT(*) AS n FROM relationship_flags
      WHERE uin=? AND type='boundary_violation' AND status='open'`).get('12345').n) || 0;
    assert.equal(count, 1);
  } finally {
    db.close();
  }
});
