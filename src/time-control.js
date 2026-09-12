import { PEAK_WINDOWS } from './model-prices.js';

export const TIME_ZONE = 'Asia/Shanghai';
export const DEFAULT_TIME_CONTROL = {
  enabled: false,
  schedule: { mode: 'deepseek-offpeak', windows: [] },
  overrides: {}
};

const DAY = 1440;
const WEEK = DAY * 7;
const MINUTE_MS = 60000;
const OFFSET_MS = 8 * 60 * MINUTE_MS;
const MODES = new Set(['deepseek-offpeak', 'custom', 'always']);

function minuteOf(value, end = false) {
  if (end && value === '24:00') return DAY;
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error('时间必须为 HH:mm，结束时间可为 24:00');
  }
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function normalizeSchedule(raw) {
  if (!raw || typeof raw !== 'object' || !MODES.has(raw.mode)) {
    throw new Error('无效的时间规则模式');
  }
  if (!Array.isArray(raw.windows ?? []) || (raw.windows?.length || 0) > 32) {
    throw new Error('时间段必须为数组，最多 32 项');
  }
  const windows = (raw.windows || []).map((window) => {
    if (!window || !Array.isArray(window.days) || !window.days.length
      || window.days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      throw new Error('每个时间段至少选择一天（1=周一，7=周日）');
    }
    const start = minuteOf(window.start);
    const end = minuteOf(window.end, true);
    if (start === end) throw new Error('开始和结束不能相同；全天请填写 00:00–24:00');
    return {
      days: [...new Set(window.days)].sort((a, b) => a - b),
      start: window.start,
      end: window.end
    };
  });
  return { mode: raw.mode, windows };
}

export function normalizeTimeControl(raw = DEFAULT_TIME_CONTROL) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || typeof raw.enabled !== 'boolean') throw new Error('时间控制开关必须为布尔值');
  const overrides = raw.overrides ?? {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
    || Object.keys(overrides).length > 1000) throw new Error('无效的逐会话时间配置');
  const normalized = {};
  for (const [key, schedule] of Object.entries(overrides)) {
    if (!/^(group|private):[1-9]\d{0,14}$/.test(key)) throw new Error(`无效的会话标识：${key}`);
    if (schedule?.mode === 'inherit') continue;
    normalized[key] = normalizeSchedule(schedule);
  }
  return {
    enabled: raw.enabled,
    schedule: normalizeSchedule(raw.schedule ?? DEFAULT_TIME_CONTROL.schedule),
    overrides: normalized
  };
}

function intervalsFor(schedule) {
  if (schedule.mode === 'always') return [[0, WEEK]];
  const ranges = [];
  if (schedule.mode === 'deepseek-offpeak') {
    for (let day = 0; day < 5; day++) {
      let start = 0;
      for (const peak of PEAK_WINDOWS) {
        ranges.push([day * DAY + start, day * DAY + peak.from * 60]);
        start = peak.to * 60;
      }
      ranges.push([day * DAY + start, (day + 1) * DAY]);
    }
    ranges.push([5 * DAY, WEEK]);
  } else if (schedule.mode === 'custom') {
    for (const window of schedule.windows || []) {
      const from = minuteOf(window.start);
      const to = minuteOf(window.end, true);
      for (const day of window.days) {
        const start = (day - 1) * DAY + from;
        const end = (day - 1) * DAY + to + (to < from ? DAY : 0);
        ranges.push([start, Math.min(end, WEEK)]);
        if (end > WEEK) ranges.push([0, end - WEEK]);
      }
    }
  }
  const merged = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    if (start >= end) continue;
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(end, last[1]);
    else merged.push([start, end]);
  }
  return merged;
}

export function timeControlState(timeControl, chatKey = '', now = Date.now()) {
  // Master-off bypasses even per-chat overrides and performs no date calculation.
  if (timeControl?.enabled !== true) {
    return { enabled: false, active: true, source: 'disabled', nextChangeAt: 0, nextActiveAt: 0 };
  }
  const override = timeControl.overrides?.[chatKey];
  const schedule = override && override.mode !== 'inherit'
    ? override : (timeControl.schedule ?? DEFAULT_TIME_CONTROL.schedule);
  const local = new Date(now + OFFSET_MS);
  const weekday = (local.getUTCDay() + 6) % 7;
  const monday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
    - OFFSET_MS - weekday * DAY * MINUTE_MS;
  const minute = (now - monday) / MINUTE_MS;
  let ranges;
  try { ranges = intervalsFor(schedule); } catch { ranges = []; }
  const activeAt = (at) => ranges.some(([start, end]) => at >= start && at < end);
  const active = activeAt(minute);
  let nextChangeAt = 0;
  const boundaries = [...new Set([0, ...ranges.flat()])].sort((a, b) => a - b);
  for (const week of [0, 1]) {
    for (const boundary of boundaries) {
      const absolute = week * WEEK + boundary;
      if (absolute <= minute) continue;
      const after = activeAt(absolute % WEEK);
      if (after !== active) {
        nextChangeAt = monday + absolute * MINUTE_MS;
        break;
      }
    }
    if (nextChangeAt) break;
  }
  return {
    enabled: true,
    active,
    source: override && override.mode !== 'inherit' ? 'override' : 'global',
    mode: schedule.mode,
    timeZone: TIME_ZONE,
    nextChangeAt,
    nextActiveAt: active ? now : nextChangeAt
  };
}
