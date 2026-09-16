import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { IdentityPilotManager } from '../src/identity-pilot.js';
import {
  parseRelationshipResponse,
  RelationshipPilotManager,
  relationshipPilotConfig
} from '../src/relationship-pilot.js';
import { relationshipDatabasePath } from '../src/relationship-pilot-store.js';
import '../src/relationship-runtime-integration.js';

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-rel-shadow-'));
  dirs.push(dir);
  return dir;
}

function config({ relationship = false } = {}) {
  return {
    api: { model: 'test-model' },
    allowAllWhenEmpty: true,
    allow: { groups: [], private: [] },
    deny: { groups: [], private: [] },
    blocklist: {},
    identityPilot: {
      enabled: true,
      friendProposal: { enabled: false },
      incomingFriendRequest: { enabled: false }
    },
    relationshipPilot: {
      enabled: relationship,
      shadowMode: false
    }
  };
}

function response(argumentsValue) {
  return {
    message: {
      tool_calls: [{
        id: 'rel-1',
        type: 'function',
        function: {
          name: 'submit_relationship_events',
          arguments: JSON.stringify(argumentsValue)
        }
      }]
    }
  };
}

test('V1 shadowMode cannot be disabled by config', () => {
  const settings = relationshipPilotConfig(config({ relationship: true }));
  assert.equal(settings.enabled, true);
  assert.equal(settings.shadowMode, true);
});

test('disabled pilot creates no relationship database', () => {
  const dataDir = tempDir();
  const pilot = new RelationshipPilotManager({
    identityPilot: { active: true },
    store: {},
    dataDir,
    config: () => config({ relationship: false })
  });
  const status = pilot.start();
  assert.equal(status.enabled, false);
  assert.equal(status.active, false);
  assert.equal(fs.existsSync(relationshipDatabasePath(dataDir)), false);
});

test('evaluator accepts only evidence ids from NEW_EVIDENCE', () => {
  const evidence = [{ evidenceId: 'group:1#10', chatKey: 'group:1' }];
  const parsed = parseRelationshipResponse(response({
    events: [{
      type: 'warm_exchange',
      strength: 0.5,
      confidence: 0.8,
      evidenceIds: ['group:1#10'],
      summary: '用户主动延续此前共同话题'
    }]
  }), evidence);
  assert.equal(parsed.events.length, 1);
  assert.deepEqual(parsed.events[0].sourceChatKeys, ['group:1']);

  assert.throws(() => parseRelationshipResponse(response({
    events: [{
      type: 'trust_signal',
      strength: 0.8,
      confidence: 0.9,
      evidenceIds: ['memory:invented'],
      summary: '非法引用长期记忆'
    }]
  }), evidence), /不存在或不可计数/);
});

test('ordinary interaction may explicitly produce zero relationship events', () => {
  const parsed = parseRelationshipResponse(response({
    events: [],
    noChangeReason: '普通问答，没有明显关系变化'
  }), [{ evidenceId: 'private:12345#1', chatKey: 'private:12345' }]);
  assert.deepEqual(parsed.events, []);
  assert.match(parsed.noChangeReason, /普通问答/);
});

test('runtime patch keeps relationship state out of agent lookupPerson path', () => {
  const manager = Object.create(IdentityPilotManager.prototype);
  manager.config = () => config({ relationship: true });
  manager.identityStore = {
    hasSource: () => true,
    getPerson: (uin) => ({ userId: String(uin), primaryName: '测试用户' })
  };
  const person = manager.lookupPerson('12345', { chatKey: 'group:1' });
  assert.deepEqual(person, { userId: '12345', primaryName: '测试用户' });
  assert.equal(Object.hasOwn(person, 'relationship'), false,
    'Shadow Mode must not expose affinity/friction to person_memory_lookup');
});
