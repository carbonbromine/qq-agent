import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatClockTime,
  formatFullTime,
  formatShortTime,
  shanghaiDayStart,
  todayKey
} from '../src/util.js';

describe('Shanghai reporting day', () => {
  it('formats model and session timestamps in Asia/Shanghai', () => {
    const ts = Date.parse('2026-09-11T14:53:07Z');
    assert.equal(formatFullTime(ts), '2026-09-11 22:53:07（周五）');
    assert.equal(formatShortTime(ts), '09-11 22:53');
    assert.equal(formatClockTime(ts), '22:53:07');
  });

  it('changes date at midnight in Asia/Shanghai', () => {
    assert.equal(todayKey(Date.parse('2026-09-11T15:59:59Z')), '2026-09-11');
    assert.equal(todayKey(Date.parse('2026-09-11T16:00:00Z')), '2026-09-12');
  });

  it('returns the UTC instant for Shanghai midnight', () => {
    assert.equal(
      shanghaiDayStart(Date.parse('2026-09-11T23:00:00Z')),
      Date.parse('2026-09-11T16:00:00Z')
    );
  });
});
