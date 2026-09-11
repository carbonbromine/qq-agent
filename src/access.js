import { getConfig } from './config.js';

export function chatAllowed(chatKey, cfg = getConfig()) {
  const [kind, id] = String(chatKey).split(':');
  if (!['group', 'private'].includes(kind) || !/^\d+$/.test(id || '')) return false;
  const field = kind === 'group' ? 'groups' : 'private';
  if ((cfg.deny?.[field] || []).map(String).includes(id)) return false;
  const allow = (cfg.allow?.[field] || []).map(String);
  return allow.length ? allow.includes(id) : cfg.allowAllWhenEmpty === true;
}

export function canRun(chatKey) {
  const cfg = getConfig();
  return cfg.runtime?.mode === 'active' && !cfg.runtime?.paused && chatAllowed(chatKey, cfg);
}

export function assertCanSend(chatKey, signal) {
  signal?.throwIfAborted();
  if (!canRun(chatKey)) throw new Error('Send blocked: observe/paused mode or chat not allowed');
}
