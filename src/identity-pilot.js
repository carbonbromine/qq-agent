import fs from 'node:fs';
import {
  DATA_DIR,
  getConfig,
  identityPilotEnabled
} from './config.js';
import { chatAllowed } from './access.js';
import {
  IdentityStore,
  identityDatabasePath,
  readLegacyIdentityMemories
} from './identity-store.js';

const DB_DISPLAY_NAME = 'identity-pilot.sqlite';

function sourceAllowed(chatKey, userId, cfg = getConfig()) {
  if (!chatAllowed(chatKey, cfg)) return false;
  const [kind, id] = String(chatKey || '').split(':');
  if (kind === 'group' && (cfg.blocklist?.[id] || []).map(String).includes(String(userId))) {
    return false;
  }
  return true;
}

export class IdentityPilotManager {
  constructor({
    store,
    onebot,
    dataDir = DATA_DIR,
    config = getConfig,
    log = console.log
  }) {
    this.store = store;
    this.onebot = onebot;
    this.dataDir = dataDir;
    this.config = config;
    this.log = log;
    this.identityStore = null;
    this.starting = null;
    this.lastError = '';
    this.friendSyncError = '';
  }

  get active() {
    return Boolean(this.identityStore);
  }

  async start() {
    if (!identityPilotEnabled(this.config())) return this.status();
    if (this.identityStore) return this.status();
    if (this.starting) return this.starting;
    this.starting = this.#start();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async #start() {
    let db = null;
    try {
      db = new IdentityStore({ dataDir: this.dataDir });
      this.store.ensureIdentityLookupIndex();
      const cfg = this.config();
      const allowSource = (chatKey, userId) => sourceAllowed(chatKey, userId, cfg);
      let friends = [];
      this.friendSyncError = '';
      try {
        const result = await this.onebot.call('get_friend_list');
        friends = Array.isArray(result) ? result : [];
      } catch (error) {
        this.friendSyncError = String(error?.message ?? error);
        this.log(`[identity-pilot] 好友列表读取失败，先按消息与旧记忆建库：${this.friendSyncError}`);
      }
      // 远程好友请求可能等待数秒；最后再截取本地消息，避免等待期间的新消息漏索引。
      const activityRows = this.store.identityActivityRows()
        .filter((row) => allowSource(row.chatKey, row.userId));
      const legacyMemories = readLegacyIdentityMemories(this.dataDir, { allowSource });
      db.rebuild({ activityRows, legacyMemories, friends });
      if (!identityPilotEnabled(this.config())) {
        db.close();
        return this.status();
      }
      this.identityStore = db;
      this.lastError = '';
      return this.status();
    } catch (error) {
      try { db?.close(); } catch { /* ignore */ }
      this.lastError = String(error?.message ?? error);
      throw error;
    }
  }

  async reindex() {
    if (!this.identityStore || !identityPilotEnabled(this.config())) return this.status();
    const cfg = this.config();
    const allowSource = (chatKey, userId) => sourceAllowed(chatKey, userId, cfg);
    let friends = [];
    this.friendSyncError = '';
    try {
      const result = await this.onebot.call('get_friend_list');
      friends = Array.isArray(result) ? result : [];
    } catch (error) {
      this.friendSyncError = String(error?.message ?? error);
    }
    const activityRows = this.store.identityActivityRows()
      .filter((row) => allowSource(row.chatKey, row.userId));
    const legacyMemories = readLegacyIdentityMemories(this.dataDir, { allowSource });
    this.identityStore.rebuild({ activityRows, legacyMemories, friends });
    return this.status();
  }

  stop() {
    try { this.identityStore?.close(); } catch { /* ignore */ }
    this.identityStore = null;
  }

  observeMessage(chatKey, message) {
    if (!this.identityStore || !identityPilotEnabled(this.config())) return false;
    if (!sourceAllowed(chatKey, message?.senderId, this.config())) return false;
    try {
      return this.identityStore.observe(chatKey, message);
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.log(`[identity-pilot] 增量索引失败：${this.lastError}`);
      return false;
    }
  }

  listPeople(limit = 100) {
    return this.identityStore ? this.identityStore.listPeople(limit) : [];
  }

  status() {
    const base = {
      enabled: identityPilotEnabled(this.config()),
      active: this.active,
      databaseExists: fs.existsSync(identityDatabasePath(this.dataDir)),
      databaseFile: DB_DISPLAY_NAME,
      friendSyncError: this.friendSyncError,
      error: this.lastError
    };
    if (!this.identityStore) {
      return {
        ...base,
        people: 0,
        messages: 0,
        friends: 0,
        aliases: 0,
        sources: 0,
        legacyMemories: 0,
        lastIndexedAt: 0
      };
    }
    return { ...base, ...this.identityStore.status() };
  }
}

export function inactiveIdentityPilotStatus({
  enabled = identityPilotEnabled(),
  dataDir = DATA_DIR,
  error = ''
} = {}) {
  return {
    enabled,
    active: false,
    databaseExists: fs.existsSync(identityDatabasePath(dataDir)),
    databaseFile: DB_DISPLAY_NAME,
    friendSyncError: '',
    error: String(error || ''),
    people: 0,
    messages: 0,
    friends: 0,
    aliases: 0,
    sources: 0,
    legacyMemories: 0,
    lastIndexedAt: 0
  };
}
