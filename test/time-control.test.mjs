import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TIME_CONTROL, normalizeTimeControl, timeControlState } from '../src/time-control.js';

const offPeak = { ...DEFAULT_TIME_CONTROL, enabled: true };
const at = (time, config = offPeak, chat = '') =>
  timeControlState(config, chat, Date.parse(time));

test('master-off ignores all schedules and overrides', () => {
  const config = {
    enabled: false, schedule: { mode: 'custom', windows: [] },
    overrides: { 'group:1': { mode: 'custom', windows: [] } }
  };
  for (const key of ['', 'group:1', 'private:2']) {
    assert.deepEqual(at('2026-09-14T02:00:00Z', config, key), timeControlState(undefined));
  }
});

test('DeepSeek off-peak windows include lunch, evenings, and Shanghai weekends', () => {
  const checks = [
    ['2026-09-14T00:59:59.999Z', true],
    ['2026-09-14T01:00:00Z', false],
    ['2026-09-14T03:59:59Z', false],
    ['2026-09-14T04:00:00Z', true],
    ['2026-09-14T06:00:00Z', false],
    ['2026-09-14T10:00:00Z', true],
    ['2026-09-11T16:00:00Z', true],
    ['2026-09-12T06:00:00Z', true],
    ['2026-09-13T06:00:00Z', true],
    ['2026-09-13T16:00:00Z', true]
  ];
  for (const [time, expected] of checks) assert.equal(at(time).active, expected, time);
  assert.equal(at('2026-09-14T02:00:00Z').nextActiveAt, Date.parse('2026-09-14T04:00:00Z'));
  assert.equal(at('2026-09-11T10:00:00Z').nextChangeAt, Date.parse('2026-09-14T01:00:00Z'));
});

test('custom windows support overnight days, week wrap and half-open boundaries', () => {
  const config = normalizeTimeControl({
    enabled: true,
    schedule: { mode: 'custom', windows: [{ days: [7], start: '22:00', end: '02:00' }] }
  });
  assert.equal(at('2026-09-13T13:59:59Z', config).active, false);
  assert.equal(at('2026-09-13T14:00:00Z', config).active, true);
  assert.equal(at('2026-09-13T17:59:59Z', config).active, true);
  assert.equal(at('2026-09-13T18:00:00Z', config).active, false);
  assert.equal(at('2026-09-13T14:00:00Z', config).nextChangeAt, Date.parse('2026-09-13T18:00:00Z'));
  assert.equal(at('2026-09-13T18:00:00Z', config).nextActiveAt, Date.parse('2026-09-20T14:00:00Z'));
});

test('overlapping windows merge and full-week coverage has no false boundary', () => {
  const config = normalizeTimeControl({
    enabled: true,
    schedule: { mode: 'custom', windows: [
      { days: [1], start: '08:00', end: '10:00' },
      { days: [1], start: '09:00', end: '12:00' }
    ] }
  });
  assert.equal(at('2026-09-14T00:30:00Z', config).nextChangeAt, Date.parse('2026-09-14T04:00:00Z'));
  config.schedule.windows = [{ days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '24:00' }];
  assert.equal(at('2026-09-13T23:59:59Z', config).nextChangeAt, 0);
});

test('per-chat schedules override the default without affecting other chats', () => {
  const config = normalizeTimeControl({
    enabled: true, schedule: { mode: 'custom', windows: [] },
    overrides: {
      'group:1': { mode: 'always' },
      'private:2': { mode: 'deepseek-offpeak' },
      'private:3': { mode: 'inherit' }
    }
  });
  assert.equal(at('2026-09-12T02:00:00Z', config, 'group:1').active, true);
  assert.equal(at('2026-09-12T02:00:00Z', config, 'private:2').active, true);
  assert.equal(at('2026-09-12T02:00:00Z', config, 'private:3').active, false);
  assert.equal(at('2026-09-12T02:00:00Z', config, '').active, false);
  assert.equal(at('2026-09-12T02:00:00Z', config, 'group:1').source, 'override');
  assert.equal(config.overrides['private:3'], undefined);
});

test('invalid rules are rejected rather than silently expanding active hours', () => {
  const invalid = [
    { days: [], start: '09:00', end: '10:00' },
    { days: [0], start: '09:00', end: '10:00' },
    { days: [1], start: '24:00', end: '10:00' },
    { days: [1], start: '09:00', end: '09:00' },
    { days: [1], start: '9:00', end: '10:00' },
    { days: [1], start: '09:00', end: '24:01' }
  ];
  for (const window of invalid) assert.throws(() =>
    normalizeTimeControl({ enabled: true, schedule: { mode: 'custom', windows: [window] } })
  );
  assert.throws(() => normalizeTimeControl({ enabled: 'false' }));
  assert.throws(() => normalizeTimeControl({ enabled: true, overrides: { 'group:bad': { mode: 'always' } } }));
});
