// 统一记忆入口：人物长期记忆全局化；会话 handoff 仍按 chatKey 隔离。
import { MemoryStore as BaseMemoryStore } from './memory-global.js';
import { bindGlobalMemoryStore } from './memory-runtime-integration.js';

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
}
