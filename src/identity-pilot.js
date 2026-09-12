import fs from 'node:fs';
import {
  DATA_DIR,
  friendProposalEnabled,
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
    notifyFriendProposal = null,
    log = console.log
  }) {
    this.store = store;
    this.onebot = onebot;
    this.dataDir = dataDir;
    this.config = config;
    this.notifyFriendProposal = notifyFriendProposal;
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

  lookupPerson(userId, { chatKey } = {}) {
    if (!this.identityStore || !identityPilotEnabled(this.config())) return null;
    const source = String(chatKey || '');
    const uin = String(userId ?? '').trim();
    if (!sourceAllowed(source, uin, this.config())) return null;
    if (!this.identityStore.hasSource(uin, source)) return null;
    return this.identityStore.getPerson(uin, { chatKey: source });
  }

  async proposeFriend({
    userId,
    chatKey,
    reasonCode,
    reason,
    verificationMessage = '',
    signal
  }) {
    const cfg = this.config();
    const settings = cfg.identityPilot?.friendProposal || {};
    if (!this.identityStore || !friendProposalEnabled(cfg)) {
      throw new Error('主动好友候选功能当前未启用');
    }
    const ownerUin = String(settings.ownerUin || '').trim();
    if (!/^\d{5,15}$/.test(ownerUin)) {
      throw new Error('尚未配置接收好友审批的管理员 QQ');
    }
    const targetUin = String(userId || '').trim();
    if (targetUin === ownerUin) throw new Error('不能把审批管理员本人列为好友候选');
    const result = this.identityStore.createFriendProposal({
      userId: targetUin,
      sourceChatKey: chatKey,
      reasonCode,
      reason,
      verificationMessage,
      minMessageCount: settings.minMessageCount,
      cooldownDays: settings.cooldownDays,
      maxPending: settings.maxPending
    });
    if (!result.created) {
      return {
        ...result,
        adminNotified: Boolean(result.proposal.notifiedAt),
        protocolDispatchSupported: false
      };
    }
    let adminNotified = false;
    let notifyError = '';
    try {
      if (this.notifyFriendProposal) {
        await this.notifyFriendProposal(result.proposal, ownerUin, signal);
        adminNotified = true;
      } else {
        notifyError = '管理员通知通道未配置';
      }
    } catch (error) {
      notifyError = String(error?.message ?? error);
      this.log(`[identity-pilot] 好友候选 ${result.proposal.id} 通知管理员失败：${notifyError}`);
    }
    const proposal = this.identityStore.markFriendProposalNotification(
      result.proposal.id,
      { notified: adminNotified, error: notifyError }
    );
    return {
      created: true,
      proposal,
      adminNotified,
      protocolDispatchSupported: false
    };
  }

  listFriendProposals(options = {}) {
    return this.identityStore ? this.identityStore.listFriendProposals(options) : [];
  }

  decideFriendProposal(id, decision, { decidedBy = '' } = {}) {
    if (!this.identityStore || !friendProposalEnabled(this.config())) {
      throw new Error('主动好友候选功能当前未启用');
    }
    return {
      proposal: this.identityStore.decideFriendProposal(id, decision, { decidedBy }),
      protocolDispatchSupported: false,
      execution: decision === 'approve' ? 'manual-required' : 'none',
      note: decision === 'approve'
        ? '管理员已批准；当前 OneBot 适配器不支持主动发送好友申请，请在 QQ 客户端手动发起。'
        : '管理员已拒绝该好友候选。'
    };
  }

  markFriendAdded(userId) {
    if (!this.identityStore) return 0;
    return this.identityStore.markFriendAdded(userId);
  }

  status() {
    const cfg = this.config();
    const proposalConfig = cfg.identityPilot?.friendProposal || {};
    const friendProposal = {
      enabled: friendProposalEnabled(cfg),
      ownerConfigured: /^\d{5,15}$/.test(String(proposalConfig.ownerUin || '').trim()),
      protocolDispatchSupported: false,
      protocolNote: '当前 OneBot 适配器未提供主动发起好友申请 action',
      counts: this.identityStore
        ? this.identityStore.friendProposalStats()
        : { total: 0, pending: 0, approvedManual: 0, accepted: 0, rejected: 0 }
    };
    const base = {
      enabled: identityPilotEnabled(this.config()),
      active: this.active,
      databaseExists: fs.existsSync(identityDatabasePath(this.dataDir)),
      databaseFile: DB_DISPLAY_NAME,
      friendSyncError: this.friendSyncError,
      error: this.lastError,
      friendProposal
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
  const proposalConfig = getConfig().identityPilot?.friendProposal || {};
  return {
    enabled,
    active: false,
    databaseExists: fs.existsSync(identityDatabasePath(dataDir)),
    databaseFile: DB_DISPLAY_NAME,
    friendSyncError: '',
    error: String(error || ''),
    friendProposal: {
      enabled: enabled && proposalConfig.enabled === true,
      ownerConfigured: /^\d{5,15}$/.test(String(proposalConfig.ownerUin || '').trim()),
      protocolDispatchSupported: false,
      protocolNote: enabled
        ? '统一身份库未运行'
        : '统一身份库总开关已关闭',
      counts: { total: 0, pending: 0, approvedManual: 0, accepted: 0, rejected: 0 }
    },
    people: 0,
    messages: 0,
    friends: 0,
    aliases: 0,
    sources: 0,
    legacyMemories: 0,
    lastIndexedAt: 0
  };
}
