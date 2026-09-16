// 统一记忆入口：人物长期记忆全局化；会话 handoff 仍按 chatKey 隔离。
import { MemoryStore as BaseMemoryStore } from './memory-global.js';
import { bindGlobalMemoryStore } from './memory-runtime-integration.js';
import { backupPersonBeforeConsolidation } from './memory-consolidation-backup.js';
import './relationship-runtime-integration.js';

export class MemoryStore extends BaseMemoryStore {
  constructor(...args) {
    super(...args);
    // 启动时立即完成旧人物记忆迁移，确保 IdentityStore 随后的 rebuild
    // 看不到旧 group_*/<QQ>.json，从而不再维护第二份 legacy_memory_refs 内容。
    this.people.listSourceChats();
    bindGlobalMemoryStore(this);
  }

  /** 全局人物列表：不再按 chatKey 过滤。 */
  globalMembers() {
    return this.people.members();
  }

  /**
   * memory_query 的底层查询改为全局人物记忆。
   * chatKey 参数仅为兼容旧调用签名，不再参与人物记忆过滤。
   */
  query(_chatKey, category = '') {
    if (category && category !== 'memberImpression') return { [category]: [] };
    const memberImpression = [];
    for (const member of this.people.members()) {
      for (const entry of member.impressions || []) {
        memberImpression.push({
          userId: String(member.userId || ''),
          target: String(member.name || member.userId || '某人'),
          content: entry.content,
          createdAt: entry.createdAt,
          lastObservedAt: entry.lastObservedAt,
          sourceChatKeys: Array.isArray(entry.sourceChatKeys) ? [...entry.sourceChatKeys] : []
        });
      }
    }
    memberImpression.sort((a, b) =>
      (Number(b.lastObservedAt) || Number(b.createdAt) || 0)
      - (Number(a.lastObservedAt) || Number(a.createdAt) || 0));
    return { memberImpression };
  }

  /**
   * 真实的逐人物 consolidation 写路径。
   * Orchestrator 整理完一个人的印象后必须走这里：先保存完整全局人物快照，
   * 再执行破坏性 replace。普通手动编辑/身份回写仍走 replaceMember，不产生整理备份。
   */
  replaceMemberForConsolidation(chatKey, userId, name, contents) {
    const person = this.getMember('', userId);
    backupPersonBeforeConsolidation(person, {
      sourceChatKey: chatKey,
      at: Date.now()
    });
    return super.replaceMember(chatKey, userId, name, contents);
  }

  /**
   * 兼容批量 replaceConsolidated 调用：同样保证每个人在破坏性写入前有快照。
   * 当前 Orchestrator 的逐人物整理主要走 replaceMemberForConsolidation。
   */
  replaceConsolidated(chatKey, next) {
    const userIds = [...new Set((Array.isArray(next?.memberImpression) ? next.memberImpression : [])
      .map((item) => String(item?.userId || '').trim())
      .filter((userId) => /^\d{1,15}$/.test(userId)))];
    const at = Date.now();
    for (const userId of userIds) {
      const person = this.getMember('', userId);
      backupPersonBeforeConsolidation(person, { sourceChatKey: chatKey, at });
    }
    return super.replaceConsolidated(chatKey, next);
  }
}
