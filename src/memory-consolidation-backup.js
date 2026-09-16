import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const BACKUP_ROOT = path.join(DATA_DIR, 'memory', 'backups', 'consolidation');

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 在人物长期记忆被 consolidation 覆写前保存完整全局快照。
 * 备份按人物而不是 chatKey 组织，因为人物记忆已经是全局资产；
 * sourceChatKey 仅记录是哪一次会话整理触发了本次快照。
 */
export function backupPersonBeforeConsolidation(person, {
  sourceChatKey = '',
  at = Date.now()
} = {}) {
  const userId = String(person?.userId || '').trim();
  const impressions = Array.isArray(person?.impressions) ? person.impressions : [];
  if (!/^\d{1,15}$/.test(userId) || !impressions.length) return null;

  const when = Number(at) || Date.now();
  const dir = path.join(BACKUP_ROOT, userId);
  const file = path.join(dir, `${when}-${crypto.randomUUID()}.json`);
  writeJsonAtomic(file, {
    version: 1,
    reason: 'consolidation',
    sourceChatKey: String(sourceChatKey || ''),
    backedUpAt: when,
    person: structuredClone(person)
  });
  return file;
}
