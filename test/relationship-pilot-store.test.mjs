import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  compileRelationshipPolicy,
  decayFriction,
  familiarityFromStats,
  RelationshipPilotStore
} from '../src/relationship-pilot-store.js';

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function tempStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-rel-'));
  dirs.push(dataDir);
  return new RelationshipPilotStore({ dataDir });
}

test('familiarity is deterministic, bounded, and does not imply affinity', () => {
  const low = familiarityFromStats({ messageCount: 5, activeDays: 1, directInteractions: 1, chatCount: 1 });
  const high = familiarityFromStats({ messageCount: 500, activeDays: 80, directInteractions: 100, chatCount: 8 });
  assert.ok(low > 0 && low < high);
  assert.ok(high <= 1);

  const store = tempStore();
  const state = store.refreshFamiliarity('12345', {
    messageCount: 500,
    activeDays: 80,
    directInteractions: 100,
    chatCount: 8,
    lastInteractionAt: 1000
  }, 2000);
  assert.ok(state.familiarity > 0.8);
  assert.equal(state.affinity, 0);
  assert.equal(state.friction, 0);
  store.close();
});

test('events update affinity with saturation and exact evidence dedupe', () => {
  const store = tempStore();
  store.refreshFamiliarity('12345', { messageCount: 20 }, 1000);
  const event = {
    type: 'warm_exchange',
    strength: 1,
    confidence: 1,
    evidenceIds: ['group:1#10', 'group:1#11'],
    sourceChatKeys: ['group:1'],
    summary: '双方连续接住同一话题并自然延续互动'
  };
  const first = store.applyEvaluation('12345', [event], {
    cursorUpdates: { 'group:1': 11 },
    now: 2000
  });
  assert.equal(first.appliedEvents.length, 1);
  assert.ok(first.state.affinity > 0);
  const afterFirst = first.state.affinity;

  const duplicate = store.applyEvaluation('12345', [event], {
    cursorUpdates: { 'group:1': 11 },
    now: 3000
  });
  assert.equal(duplicate.appliedEvents.length, 0);
  assert.equal(duplicate.state.affinity, afterFirst);
  assert.equal(store.recentEvents('12345', 20).length, 1);
  assert.equal(store.cursors('12345')['group:1'], 11);
  store.close();
});

test('conflict friction decays, boundary stays flagged until repair', () => {
  const store = tempStore();
  store.refreshFamiliarity('54321', { messageCount: 40 }, 1000);
  const crossed = store.applyEvaluation('54321', [{
    type: 'boundary_cross',
    strength: 0.8,
    confidence: 0.9,
    evidenceIds: ['private:54321#20'],
    sourceChatKeys: ['private:54321'],
    summary: '在明确拒绝后仍持续施压'
  }], { now: 2000, halfLifeHours: 48 });
  assert.ok(crossed.state.affinity < 0);
  assert.ok(crossed.state.friction > 0.2);
  assert.equal(crossed.openFlags.length, 1);

  const decayed = store.getState('54321', {
    now: 2000 + 48 * 3600000,
    halfLifeHours: 48
  });
  assert.ok(Math.abs(decayed.friction - crossed.state.friction / 2) < 1e-9);
  assert.equal(store.openFlags('54321').length, 1, 'time decay must not erase unresolved boundary flags');

  const repaired = store.applyEvaluation('54321', [{
    type: 'repair',
    strength: 0.8,
    confidence: 0.8,
    evidenceIds: ['private:54321#25'],
    sourceChatKeys: ['private:54321'],
    summary: '明确道歉并停止此前的施压'
  }], { now: 2000 + 49 * 3600000, halfLifeHours: 48 });
  assert.equal(repaired.openFlags.length, 0);
  assert.ok(repaired.state.friction < decayed.friction);
  store.close();
});

test('replay recomputes relationship state from immutable event ledger', () => {
  const store = tempStore();
  store.refreshFamiliarity('67890', { messageCount: 100, activeDays: 10 }, 1000);
  store.applyEvaluation('67890', [{
    type: 'trust_signal', strength: 0.7, confidence: 0.9,
    evidenceIds: ['group:2#1'], sourceChatKeys: ['group:2'], summary: '主动分享较私人信息'
  }], { now: 2000 });
  store.applyEvaluation('67890', [{
    type: 'conflict', strength: 0.5, confidence: 0.8,
    evidenceIds: ['group:2#9'], sourceChatKeys: ['group:2'], summary: '明确表达不悦并发生争执'
  }], { now: 4000 });
  const before = store.getState('67890', { now: 4000 });
  const replayed = store.replay('67890', { now: 4000 });
  assert.ok(Math.abs(replayed.affinity - before.affinity) < 1e-12);
  assert.ok(Math.abs(replayed.friction - before.friction) < 1e-12);
  store.close();
});

test('policy compiler stays coarse and friction can suppress positive affinity behavior', () => {
  const normal = compileRelationshipPolicy({
    familiarity: 0.8,
    affinity: 0.6,
    friction: 0.05,
    frictionUpdatedAt: 1000
  }, { now: 1000 });
  assert.equal(normal.policy.shared_context_use, 1);
  assert.equal(normal.policy.banter_permission, 1);
  assert.equal(normal.policy.formality, -1);

  const tense = compileRelationshipPolicy({
    familiarity: 0.8,
    affinity: 0.6,
    friction: 0.8,
    frictionUpdatedAt: 1000
  }, { now: 1000 });
  assert.equal(tense.policy.banter_permission, -1);
  assert.equal(tense.policy.followup_initiative, -1);
});

test('decayFriction has the configured half-life', () => {
  assert.equal(decayFriction(0, 0, 1000, 48), 0);
  const value = decayFriction(0.8, 1000, 1000 + 48 * 3600000, 48);
  assert.ok(Math.abs(value - 0.4) < 1e-12);
});
