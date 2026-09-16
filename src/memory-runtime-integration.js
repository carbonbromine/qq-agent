import { IdentityStore } from './identity-store.js';

let activeMemoryStore = null;
let patched = false;

function normalizeMemoryView(userId, maxMemories = 6) {
  if (!activeMemoryStore) {
    return {
      globalMemories: [],
      globalMemoryCount: 0,
      memorySourceChatKeys: []
    };
  }

  const member = activeMemoryStore.getMember('', String(userId || ''));
  const impressions = Array.isArray(member?.impressions) ? member.impressions : [];
  const sorted = [...impressions]
    .sort((a, b) => (Number(b.lastObservedAt) || Number(b.createdAt) || 0)
      - (Number(a.lastObservedAt) || Number(a.createdAt) || 0));
  const limit = Math.min(20, Math.max(1, Number(maxMemories) || 6));
  const globalMemories = sorted.slice(0, limit).map((item) => ({
    content: String(item?.content || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    observedAt: Number(item?.lastObservedAt) || Number(item?.createdAt) || 0,
    sourceChatKeys: [...new Set((Array.isArray(item?.sourceChatKeys) ? item.sourceChatKeys : [])
      .map(String)
      .filter(Boolean))]
  })).filter((item) => item.content);

  const memorySourceChatKeys = [...new Set([
    ...(Array.isArray(member?.sourceChatKeys) ? member.sourceChatKeys : []),
    ...globalMemories.flatMap((item) => item.sourceChatKeys)
  ].map(String).filter(Boolean))];

  return {
    globalMemories,
    globalMemoryCount: impressions.length,
    memorySourceChatKeys
  };
}

function attachGlobalMemory(person, maxMemories = 6) {
  if (!person) return person;
  const memory = normalizeMemoryView(person.userId, maxMemories);
  return {
    ...person,
    // 统一记忆字段：IdentityStore 只负责身份；人物长期记忆只从 MemoryStore 读取。
    globalMemories: memory.globalMemories,
    globalMemoryCount: memory.globalMemoryCount,
    memorySourceChatKeys: memory.memorySourceChatKeys,

    // 兼容旧的好友评估/工具消费方。语义已经变为“全局人物记忆”，不再是当前群记忆。
    currentContextMemories: memory.globalMemories.map((item) => ({
      content: item.content,
      observedAt: item.observedAt,
      sourceChatKeys: item.sourceChatKeys
    })),
    currentMemoryCount: memory.globalMemoryCount,
    otherContextMemoryCount: 0,
    legacyMemoryCount: 0
  };
}

function patchIdentityStore() {
  if (patched) return;
  patched = true;

  const originalGetPerson = IdentityStore.prototype.getPerson;
  if (typeof originalGetPerson === 'function') {
    IdentityStore.prototype.getPerson = function getPersonWithGlobalMemory(userId, options = {}) {
      const person = originalGetPerson.call(this, userId, options);
      return attachGlobalMemory(person, options?.maxMemories);
    };
  }

  const originalListPeople = IdentityStore.prototype.listPeople;
  if (typeof originalListPeople === 'function') {
    IdentityStore.prototype.listPeople = function listPeopleWithGlobalMemory(...args) {
      const people = originalListPeople.apply(this, args);
      return Array.isArray(people)
        ? people.map((person) => attachGlobalMemory(person, 6))
        : people;
    };
  }
}

export function bindGlobalMemoryStore(store) {
  activeMemoryStore = store || null;
  patchIdentityStore();
}

export function globalMemoryStoreForIdentity() {
  return activeMemoryStore;
}
