import { AsyncLocalStorage } from 'node:async_hooks';
import { getConfig, onTimeControlChange } from './config.js';
import { timeControlState } from './time-control.js';

const scope = new AsyncLocalStorage();

export class TimeControlError extends Error {
  constructor(chatKey = '') {
    super(`非活跃时间，仅记录、不调用 AI${chatKey ? `：${chatKey}` : ''}`);
    this.code = 'TIME_CONTROL_INACTIVE';
  }
}

export function isTimeActive(chatKey = '', now = Date.now()) {
  return timeControlState(getConfig().timeControl, chatKey, now).active;
}

export function withTimeScope(chatKeys, task) {
  const keys = Array.isArray(chatKeys) ? chatKeys : [chatKeys || ''];
  return scope.run(keys, task);
}

export function assertTimeAllowed(chatKeys = scope.getStore() || ['']) {
  const keys = Array.isArray(chatKeys) ? chatKeys : [chatKeys];
  const cfg = getConfig();
  if (cfg.timeControl?.enabled !== true) return;
  const now = Date.now();
  for (const key of keys) {
    if (!timeControlState(cfg.timeControl, key, now).active) throw new TimeControlError(key);
  }
}

// One timer per in-flight operation; no timers while the master switch is off.
// Configuration changes re-evaluate running requests as well as future requests.
export function watchTimeWindow(onInactive, chatKeys = scope.getStore() || ['']) {
  const keys = Array.isArray(chatKeys) ? chatKeys : [chatKeys];
  let timer;
  let stopped = false;
  let unsubscribe = () => {};
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
  };
  const check = () => {
    if (stopped) return;
    clearTimeout(timer);
    const cfg = getConfig();
    if (cfg.timeControl?.enabled !== true) return;
    const now = Date.now();
    let next = 0;
    for (const key of keys) {
      const state = timeControlState(cfg.timeControl, key, now);
      if (!state.active) {
        stop();
        onInactive(new TimeControlError(key));
        return;
      }
      if (state.nextChangeAt && (!next || state.nextChangeAt < next)) next = state.nextChangeAt;
    }
    if (next) {
      timer = setTimeout(check, Math.max(1, Math.min(next - now, 2147483647)));
      timer.unref?.();
    }
  };
  unsubscribe = onTimeControlChange(check);
  check();
  return stop;
}

export async function withTimeWindow(task, parentSignal) {
  assertTimeAllowed();
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener('abort', abort, { once: true });
  const release = watchTimeWindow((error) => controller.abort(error));
  try {
    controller.signal.throwIfAborted();
    return await task(controller.signal);
  } finally {
    release();
    parentSignal?.removeEventListener('abort', abort);
  }
}
