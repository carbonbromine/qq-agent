import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  compileRelationshipV2Policy,
  RelationshipV2Store
} from '../src/relationship-v2-store.js';

const dirs = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function makeStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relationship-v2-'));
  dirs.push(dataDir);
  return new RelationshipV2Store({ dataDir });
}

const settings = {
  warmthHalfLifeHours: 12,
  tensionHalfLifeHours: 48,
  familiarityHalfLifeDays: 60,
  bondGraceDays: 30,
  bondHalfLifeDays: 180
};

function event(type, evidenceId, extra = {}) {
  return {
    type,
    strength: 0.8,
    confidence: 0.9,
    durableEligible: false,
    evidenceIds: [evidenceId],
    sourceChatKeys: ['group:1'],
    personaBasisIds: ['role:direct'],
    summary: type,
    ...extra
  };
}

test('recent warmth changes quickly but does not directly promote durable bond', () => {
  const store = makeStore();
  const now = 1_800_000_000_000;
  store.recordDirectInteraction('12345', 'private:12345', now, settings, '小明');
  assert.equal(store.getState('12345', settings, now).name, '小明');
  const result = store.applyEvaluation('12345', [event('pleasant_moment', 'group:1#1')], {
    settings, now, personaVersion: 'p1'
  });
  assert.equal(result.state.bondLevel, 0);
  assert.ok(result.state.recentWarmth > 0.2);
  const later = store.getState('12345', settings, now + 24 * 3600000);
  assert.ok(later.recentWarmth < result.state.recentWarmth / 3);
  assert.equal(later.bondLevel, 0);
  store.close();
});

test('durable bond promotion needs multiple event types across multiple days', () => {
  const store = makeStore();
  const day = 86400000;
  const base = 1_800_000_000_000;
  store.applyEvaluation('12345', [event('reciprocal_interest', 'group:1#1', {
    durableEligible: true
  })], { settings, now: base, personaVersion: 'p1' });
  store.applyEvaluation('12345', [event('reliable_followthrough', 'group:1#2', {
    durableEligible: true
  })], { settings, now: base + day, personaVersion: 'p1' });
  const promoted = store.applyEvaluation('12345', [event('boundary_respect', 'group:1#3', {
    durableEligible: true
  })], { settings, now: base + 2 * day, personaVersion: 'p1' });
  assert.equal(promoted.state.bondLevel, 1);
  assert.equal(promoted.state.bondProgress, 0);
  store.close();
});

test('boundary events override warmth and repair clears boundary without positive bond gain', () => {
  const store = makeStore();
  const now = 1_800_000_000_000;
  const crossed = store.applyEvaluation('54321', [event('boundary_cross', 'private:54321#1')], {
    settings, now, personaVersion: 'p1'
  });
  assert.equal(crossed.state.boundaryState, 'open');
  assert.ok(crossed.state.recentTension > 0.5);
  assert.equal(crossed.state.policy.mode, 'boundary');
  const repaired = store.applyEvaluation('54321', [event('repair', 'private:54321#2')], {
    settings, now: now + 3600000, personaVersion: 'p1'
  });
  assert.equal(repaired.state.boundaryState, 'clear');
  assert.equal(repaired.state.bondLevel, crossed.state.bondLevel);
  assert.ok(repaired.state.recentTension < crossed.state.recentTension);
  store.close();
});

test('conflict resets pending bond progress and only severe conflict lowers the durable level', () => {
  const store = makeStore();
  try {
    const day = Date.UTC(2026, 0, 1);
    store.applyEvaluation('10004', [{
      type: 'reciprocal_interest', strength: 0.8, confidence: 0.9,
      durableEligible: true, evidenceIds: ['p1'], sourceChatKeys: ['private:10004']
    }], { settings, now: day });
    assert.ok(store.getState('10004', settings, day).bondProgress > 0);

    store.applyEvaluation('10004', [{
      type: 'conflict', strength: 0.6, confidence: 0.9,
      durableEligible: false, evidenceIds: ['c1'], sourceChatKeys: ['private:10004']
    }], { settings, now: day + 86400000 });
    let state = store.getState('10004', settings, day + 86400000);
    assert.equal(state.bondLevel, 0);
    assert.equal(state.bondProgress, 0);
    assert.ok(state.recentTension > 0);

    store.applyEvaluation('10004', [{
      type: 'conflict', strength: 1, confidence: 0.9,
      durableEligible: false, evidenceIds: ['c2'], sourceChatKeys: ['private:10004']
    }], { settings, now: day + 2 * 86400000 });
    state = store.getState('10004', settings, day + 2 * 86400000);
    assert.equal(state.bondLevel, -1);
    assert.equal(state.bondProgress, 0);
  } finally {
    store.close();
  }
});

test('job queue is durable, idempotent and recovers interrupted work', () => {
  const store = makeStore();
  const job = store.enqueueJob({
    uin: '12345', triggerKind: 'manual', fromTs: 1000, toTs: 2000,
    personaVersion: 'p1', model: 'test'
  });
  const duplicate = store.enqueueJob({
    uin: '12345', triggerKind: 'manual', fromTs: 1000, toTs: 2000,
    personaVersion: 'p1', model: 'test'
  });
  assert.equal(duplicate.id, job.id);
  assert.equal(duplicate.duplicate, true);
  assert.equal(store.hasActiveJob('12345'), true);
  assert.equal(store.evaluationsSince(0), 1);
  assert.equal(store.claimNextJob().status, 'running');
  assert.equal(store.recoverInterruptedJobs(), 1);
  assert.equal(store.claimNextJob().id, job.id);
  store.close();
});

test('policy precedence never combines boundary and warmth into a friendly mode', () => {
  const policy = compileRelationshipV2Policy({
    bondLevel: 3,
    bondConfidence: 1,
    familiarity: 1,
    warmth: 1,
    tension: 0,
    boundaryState: 'open'
  });
  assert.equal(policy.mode, 'boundary');
  assert.equal(policy.warmthStep, 0);
  assert.equal(policy.banterAllowed, false);
});
