import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMomentWindows, updateMomentPlan, MOMENT_MIN_GAP_MS } from '../src/moment-schedule.js';

const at = (clock) => Date.parse(`2026-09-14T${clock}+08:00`);
const windows = [{ start: '17:00', end: '18:00', count: 3 }];

test('normalizes multiple windows and rejects invalid schedules', () => {
  assert.equal(normalizeMomentWindows(null), null);
  assert.deepEqual(normalizeMomentWindows(windows), windows);
  assert.equal(normalizeMomentWindows([
    { start: '23:30', end: '00:30', count: 2 },
    { start: '12:00', end: '13:00', count: 1 }
  ]).length, 2);
  for (const value of [
    [], {}, Array(9).fill(windows[0]),
    [{ start: '25:00', end: '18:00', count: 1 }],
    [{ start: '17:00', end: '17:00', count: 1 }],
    [{ start: '17:00', end: '17:04', count: 1 }],
    [{ start: '17:00', end: '18:00', count: 0 }],
    [{ start: '17:00', end: '18:00', count: 1.5 }],
    [{ start: '17:00', end: '18:00', count: 11 }],
    [{ start: '17:00', end: '18:00', count: 1 }, { start: '17:30', end: '19:00', count: 1 }],
    [{ start: '23:30', end: '00:30', count: 1 }, { start: '00:00', end: '01:00', count: 1 }],
    [{ start: '01:00', end: '02:00', count: 10 }, { start: '03:00', end: '04:00', count: 10 }, { start: '05:00', end: '06:00', count: 1 }]
  ]) assert.throws(() => normalizeMomentWindows(value));
});

test('creates bounded separated random slots once and does not redraw on restart', () => {
  const slots = [];
  let calls = 0;
  updateMomentPlan(slots, windows, at('16:00:00'), () => (++calls % 2 ? 0.999999 : 0));
  const today = slots.filter((item) => item.dayKey === '2026-09-14');
  assert.equal(today.length, 3);
  assert.ok(today.every((item) => item.at >= at('17:00:00') && item.at < at('18:00:00')));
  for (let i = 1; i < today.length; i++) assert.ok(today[i].at - today[i - 1].at >= MOMENT_MIN_GAP_MS);
  const saved = structuredClone(slots);
  assert.equal(updateMomentPlan(slots, windows, at('16:30:00'), () => { throw new Error('redraw'); }), false);
  assert.deepEqual(slots, saved);
  assert.equal(calls, 6);
});

test('cross-midnight slots remain associated with their starting date', () => {
  const slots = [];
  updateMomentPlan(slots, [{ start: '23:30', end: '00:30', count: 2 }], at('00:05:00'), () => 0, { catchup: true });
  const previous = slots.filter((item) => item.dayKey === '2026-09-13');
  assert.equal(previous.length, 2);
  assert.equal(previous[1].at, at('00:00:00'));
  assert.ok(previous.every((item) => item.status === 'pending'));
  updateMomentPlan(slots, [{ start: '23:30', end: '00:30', count: 2 }], at('00:30:00'), () => 0);
  assert.ok(previous.every((item) => item.status === 'missed'));
});

test('catchup stays inside the window and disabled catchup skips overdue startup slots', () => {
  for (const catchup of [false, true]) {
    const slots = [];
    updateMomentPlan(slots, windows, at('16:00:00'), () => 0);
    updateMomentPlan(slots, windows, at('17:05:00'), () => 0, { startup: true, catchup });
    assert.equal(slots[0].status, catchup ? 'pending' : 'missed');
    updateMomentPlan(slots, windows, at('18:00:00'), () => 0, { catchup: true });
    assert.equal(slots.filter((item) => item.dayKey === '2026-09-14' && item.status === 'pending').length, 0);
  }
});

test('editing quotas cancels only pending work and never rearms cancelled or finished slots', () => {
  const slots = [];
  updateMomentPlan(slots, windows, at('16:00:00'), () => 0);
  slots[0].status = 'published';
  const originalAt = slots[0].at;
  updateMomentPlan(slots, [{ ...windows[0], count: 1 }], at('16:00:00'), () => 0);
  assert.equal(slots[0].status, 'published');
  assert.equal(slots[1].status, 'cancelled');
  updateMomentPlan(slots, windows, at('16:00:00'), () => 0);
  assert.equal(slots[1].status, 'cancelled');
  assert.equal(slots[0].at, originalAt);
  updateMomentPlan(slots, null, at('16:00:00'), () => 0);
  assert.equal(slots.filter((item) => item.status === 'pending').length, 0);
});
