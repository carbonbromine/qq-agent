import { shanghaiDayStart, todayKey } from './util.js';

export const MOMENT_DAY_MS = 86400000;
export const MOMENT_MIN_GAP_MS = 5 * 60000;

function clockMinutes(value) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''))) {
    throw new Error('动态时间范围必须使用 HH:MM 格式');
  }
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

export function normalizeMomentWindows(value) {
  if (value == null) return null; // Existing fixed-time installations stay fixed.
  if (!Array.isArray(value) || !value.length || value.length > 8) {
    throw new Error('每日动态需要配置 1 至 8 个时间范围');
  }
  const windows = value.map((item) => {
    const start = clockMinutes(item?.start);
    const end = clockMinutes(item?.end);
    const count = Number(item?.count);
    if (!Number.isInteger(count) || count < 1 || count > 10) {
      throw new Error('每个时间范围的动态条数必须为 1 至 10');
    }
    const duration = (end - start + 1440) % 1440;
    if (duration * 60000 < count * MOMENT_MIN_GAP_MS) {
      throw new Error('每条动态至少预留 5 分钟；开始和结束时间不能相同');
    }
    return { start: item.start, end: item.end, count };
  });
  if (windows.reduce((sum, item) => sum + item.count, 0) > 20) {
    throw new Error('每天最多安排 20 条定时动态');
  }
  const occupied = new Set();
  for (const window of windows) {
    const start = clockMinutes(window.start);
    const end = clockMinutes(window.end);
    const duration = (end - start + 1440) % 1440;
    for (let offset = 0; offset < duration; offset++) {
      const minute = (start + offset) % 1440;
      if (occupied.has(minute)) throw new Error('动态时间范围不能重叠（包括跨午夜范围）');
      occupied.add(minute);
    }
  }
  return windows;
}

export function momentWindowKey(window) {
  return `${window.start}-${window.end}`;
}

// Slots are durable identities. Counts can change without rearming finished slots.
export function updateMomentPlan(slots, windows, now, random = Math.random, { startup = false, catchup = false } = {}) {
  const dayStart = shanghaiDayStart(now);
  const configured = new Map((windows || []).map((window) => [momentWindowKey(window), window]));
  let changed = false;
  for (const slot of slots) {
    if (slot.status !== 'pending') continue;
    const window = configured.get(slot.windowKey);
    if (!window || slot.index >= window.count) {
      Object.assign(slot, { status: 'cancelled', reason: '时间范围已修改或移除' });
      changed = true;
    } else if (now >= slot.endAt || (startup && !catchup && slot.at < now)) {
      Object.assign(slot, {
        status: 'missed',
        reason: now >= slot.endAt ? '已错过允许发布时间范围' : '启动时已错过随机时间，未开启窗口内补跑'
      });
      changed = true;
    }
  }
  const ids = new Set(slots.map((slot) => slot.id));
  for (const offset of [-1, 0, 1]) {
    const startOfDay = dayStart + offset * MOMENT_DAY_MS;
    const dayKey = todayKey(startOfDay);
    for (const window of windows || []) {
      const windowKey = momentWindowKey(window);
      const start = clockMinutes(window.start);
      const end = clockMinutes(window.end);
      const startAt = startOfDay + start * 60000;
      const endAt = startOfDay + (end <= start ? end + 1440 : end) * 60000;
      if (offset === -1 && endAt <= now) continue;
      const bucket = (endAt - startAt) / window.count;
      for (let index = 0; index < window.count; index++) {
        const id = `${dayKey}/${windowKey}/${index + 1}`;
        if (ids.has(id)) continue;
        const sample = Math.max(0, Math.min(0.999999999, Number(random()) || 0));
        const at = Math.floor(startAt + index * bucket + sample * (bucket - MOMENT_MIN_GAP_MS));
        const missed = now >= endAt || (at < now && !catchup);
        slots.push({
          id, dayKey, windowKey, index, at, endAt,
          status: missed ? 'missed' : 'pending',
          reason: missed ? '计划建立时已错过时间，未补跑' : '',
          recordId: ''
        });
        ids.add(id);
        changed = true;
      }
    }
  }
  slots.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const retained = slots.filter((slot) => slot.endAt >= dayStart - 7 * MOMENT_DAY_MS);
  if (retained.length !== slots.length) {
    slots.splice(0, slots.length, ...retained);
    changed = true;
  }
  return changed;
}
