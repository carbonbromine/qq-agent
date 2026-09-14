import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const {
  IncidentPilotManager,
  incidentDatabasePath
} = await import('../src/incident-pilot.js');

function fixture(t, patch = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-incident-pilot-'));
  const cfg = {
    incidentPilot: {
      enabled: true,
      graduated: false,
      ownerUin: '2948771712',
      notifyWarnings: true,
      duplicateWindowMinutes: 10,
      unknownWritesBlockChat: false,
      retentionDays: 90
    }
  };
  let notifyAvailable = patch.notifyAvailable ?? true;
  const notifications = [];
  const manager = new IncidentPilotManager({
    dataDir,
    config: () => cfg,
    notifyAvailable: () => notifyAvailable,
    notify: patch.notify || (async (incident, ownerUin) => {
      notifications.push({ incident, ownerUin });
    }),
    now: patch.now || (() => Date.now()),
    emit: () => {},
    log: () => {}
  });
  t.after(async () => {
    await manager.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    cfg,
    manager,
    notifications,
    setNotifyAvailable(value) { notifyAvailable = value; }
  };
}

test('disabled incident pilot creates no database and has no runtime effects', async (t) => {
  const f = fixture(t);
  f.cfg.incidentPilot.enabled = false;
  assert.equal(f.manager.start().active, false);
  assert.equal(f.manager.capture(new Error('ignored')), null);
  assert.equal(fs.existsSync(incidentDatabasePath(f.dataDir)), false);
  assert.deepEqual(f.manager.chatDecision('group:1', { held: 1 }), {
    allowed: false,
    mode: 'legacy',
    effectiveState: 'blocked',
    reason: '存在发送结果待确认',
    control: {
      chatKey: 'group:1',
      mode: 'auto',
      reason: '',
      updatedAt: 0,
      updatedBy: '',
      version: 0
    }
  });
});

test('captures, redacts, deduplicates, notifies, resolves and deletes incidents', async (t) => {
  let now = Date.parse('2026-09-14T12:00:00Z');
  const f = fixture(t, { now: () => now });
  f.manager.start();
  const first = f.manager.capture(new Error(
    'request failed?token=secret-value Authorization=Bearer abcdefghijklmnop'
  ), {
    source: 'sender',
    category: 'external_write',
    severity: 'error',
    chatKey: 'group:1',
    sessionId: 'session-1',
    details: { apiKey: 'secret', operation: 'send_message' }
  });
  await f.manager.waitForIdle();
  assert.equal(f.notifications.length, 1);
  assert.equal(f.notifications[0].ownerUin, '2948771712');
  assert.doesNotMatch(first.message, /secret-value|abcdefghijklmnop/);
  assert.equal(first.details.apiKey, '[redacted]');

  now += 1000;
  const duplicate = f.manager.capture(new Error(
    'request failed?token=secret-value Authorization=Bearer abcdefghijklmnop'
  ), {
    source: 'sender',
    category: 'external_write',
    severity: 'error',
    chatKey: 'group:1'
  });
  await f.manager.waitForIdle();
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.count, 2);
  assert.equal(f.notifications.length, 1);
  assert.throws(() => f.manager.delete(first.id), /只能删除已解决/);
  assert.equal(f.manager.acknowledge(first.id).state, 'acknowledged');
  assert.equal(f.manager.resolve(first.id, '已修复').state, 'resolved');
  assert.equal(f.manager.delete(first.id), true);
  assert.equal(f.manager.get(first.id), null);
});

test('pending notifications resume once while unknown notification results never retry', async (t) => {
  const f = fixture(t, { notifyAvailable: false });
  f.manager.start();
  const pending = f.manager.capture(new Error('offline alert'), {
    source: 'process',
    severity: 'critical'
  });
  await f.manager.waitForIdle();
  assert.equal(f.manager.get(pending.id).notifyState, 'pending');
  f.setNotifyAvailable(true);
  f.manager.resumeNotifications();
  await f.manager.waitForIdle();
  assert.equal(f.notifications.length, 1);
  assert.equal(f.manager.get(pending.id).notifyState, 'sent');

  let attempts = 0;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-incident-unknown-'));
  const cfg = structuredClone(f.cfg);
  const manager = new IncidentPilotManager({
    dataDir,
    config: () => cfg,
    notifyAvailable: () => true,
    notify: async () => {
      attempts++;
      throw Object.assign(new Error('response lost'), { outcome: 'unknown' });
    },
    emit: () => {},
    log: () => {}
  });
  t.after(async () => {
    await manager.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  manager.start();
  const unknown = manager.capture(new Error('critical write'), {
    source: 'sender',
    severity: 'critical',
    outcome: 'unknown'
  });
  await manager.waitForIdle();
  assert.equal(manager.get(unknown.id).notifyState, 'unknown');
  manager.resumeNotifications();
  await manager.waitForIdle();
  assert.equal(attempts, 1);
});

test('chat controls are versioned and separate unknown writes from chat blocking', (t) => {
  const f = fixture(t);
  f.manager.start();
  assert.equal(f.manager.chatDecision('group:1', { held: 1 }).allowed, true);
  assert.equal(f.manager.chatDecision('group:1', { held: 1 }).effectiveState, 'degraded');
  assert.match(f.manager.contextForChat('group:1', { held: 1 }), /不要重试/);

  const blocked = f.manager.setChatControl('group:1', {
    mode: 'blocked',
    reason: '人工检查',
    expectedVersion: 0
  });
  assert.equal(blocked.version, 1);
  assert.equal(f.manager.chatDecision('group:1', { held: 0 }).allowed, false);
  assert.throws(() => f.manager.setChatControl('group:1', {
    mode: 'continue',
    expectedVersion: 0
  }), /已被其他操作更新/);
  const continued = f.manager.setChatControl('group:1', {
    mode: 'continue',
    expectedVersion: 1
  });
  assert.equal(continued.version, 2);
  assert.equal(f.manager.chatDecision('group:1', { held: 1 }).allowed, true);

  f.cfg.incidentPilot.unknownWritesBlockChat = true;
  f.manager.setChatControl('group:1', { mode: 'auto', expectedVersion: 2 });
  assert.equal(f.manager.chatDecision('group:1', { held: 1 }).allowed, false);
});

test('disabled existing pilot remains readable but cannot mutate or capture', async (t) => {
  const f = fixture(t);
  f.manager.start();
  const incident = f.manager.capture(new Error('saved'), {
    source: 'test',
    severity: 'info'
  });
  await f.manager.stop();
  f.cfg.incidentPilot.enabled = false;

  const reader = new IncidentPilotManager({
    dataDir: f.dataDir,
    config: () => f.cfg,
    emit: () => {},
    log: () => {}
  });
  t.after(() => reader.stop());
  const status = reader.openExisting();
  assert.equal(status.active, false);
  assert.equal(status.exists, true);
  assert.equal(reader.list().length, 1);
  assert.equal(reader.get(incident.id).message, 'saved');
  assert.equal(reader.capture(new Error('ignored')), null);
  assert.throws(() => reader.setChatControl('group:1', { mode: 'blocked' }), /未启用/);
});
