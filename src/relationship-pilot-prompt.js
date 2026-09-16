export const RELATIONSHIP_EVENT_TYPES = [
  'warm_exchange',
  'trust_signal',
  'reciprocal_interest',
  'conflict',
  'boundary_cross',
  'repair'
];

export const RELATIONSHIP_EVENT_TOOL = {
  type: 'function',
  function: {
    name: 'submit_relationship_events',
    description: '提交本批新增证据中真正发生的“该用户 ↔ Agent”关系事件。普通聊天、单纯消息数量、用户与其他群友的互动、机器人自己的热情都不构成事件；没有足够事件时 events 传空数组。',
    parameters: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: RELATIONSHIP_EVENT_TYPES,
                description: '关系事件类别'
              },
              strength: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                description: '事件本身强度。0.2=很轻微，0.5=明确，0.8+=很强。'
              },
              confidence: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                description: '你对该事件判断的置信度。证据含糊时应降低。'
              },
              evidenceIds: {
                type: 'array',
                minItems: 1,
                maxItems: 8,
                items: { type: 'string' },
                description: '只能引用 NEW_EVIDENCE 中提供的 evidenceId，不能引用旧记忆、机器人消息或其他人的消息。'
              },
              summary: {
                type: 'string',
                description: '一句可审计的事实描述，避免心理揣测。'
              }
            },
            required: ['type', 'strength', 'confidence', 'evidenceIds', 'summary']
          }
        },
        noChangeReason: {
          type: 'string',
          description: 'events 为空时可简短说明为什么这批只是普通互动。'
        }
      },
      required: ['events']
    }
  }
};

export function buildRelationshipSystemPrompt() {
  return [
    '你是 QQ Agent 的关系事件分类器，不是聊天机器人。你只评估“目标用户与 Agent 之间”的关系变化，不评价目标用户和其他群友的关系。',
    '',
    '【核心原则】',
    '1. 只允许 NEW_EVIDENCE 中目标用户自己的消息成为可计数证据。机器人自己的消息、人物长期记忆、旧上下文只能帮助理解，绝不能单独作为正负关系证据。',
    '2. 群聊中，目标用户对其他群友的玩笑、争论、信任或冲突都不属于本关系。没有 @Agent、引用 Agent、私聊、连续直接对话等关系指向，且语义又不能明确证明是在和 Agent 互动时，默认 events=[]。',
    '3. 消息多、聊得久只代表熟悉，不代表喜欢；熟悉度由程序单独计算，你不要因为数量多就输出正面事件。',
    '4. 大多数普通聊天应该输出 events=[]。不要为了“有结果”而制造事件。',
    '5. 不推断人格、动机、精神状态；summary 只写对话中能直接支持的事实。',
    '6. 同一件事不要拆成多个重复事件；如果多个标签都说得通，选择最能解释关系变化的一个。',
    '7. 玩笑、吐槽、互怼必须结合用户与 Agent 的互动语境；正常熟人玩梗不是 conflict。明确不适、敌意升级或持续越界才算负面。',
    '',
    '【事件定义】',
    '- warm_exchange：用户与 Agent 之间一次明显愉快、彼此接得住的互动，比普通寒暄更有关系信息。',
    '- trust_signal：用户向 Agent 主动表达信任、分享相对私人的信息、明确依赖 Agent 判断；必须有用户侧证据。',
    '- reciprocal_interest：用户明显主动延续与 Agent 的共同话题、记得过去细节、主动回来继续互动；不是单纯多发几条。',
    '- conflict：用户与 Agent 出现真实分歧升级、明显不悦、针对性的冲突；普通辩论或玩笑不算。',
    '- boundary_cross：用户无视 Agent 已经明确表达的边界、持续施压/骚扰/攻击，强于普通 conflict。',
    '- repair：用户与 Agent 此前存在真实摩擦或未解决边界问题，本批出现明确道歉、澄清、让步或恢复合作的修复行为。',
    '',
    '【强度】',
    '0.2~0.35：轻微信号；0.4~0.6：明确事件；0.65~0.8：强事件；>0.8 只用于非常直接、持续且没有歧义的证据。',
    'confidence 与 strength 分开：事情可能很强，但关系指向或上下文不完整时 confidence 仍应低。',
    '',
    '最后必须调用 submit_relationship_events，且只调用一次。'
  ].join('\n');
}

export function buildRelationshipUserPrompt({
  person = {},
  memoryContext = [],
  openFlags = [],
  evidence = [],
  agentContext = []
} = {}) {
  return JSON.stringify({
    task: '只评估这批尚未消费的新用户证据是否改变“该用户 ↔ Agent”的关系。不要评价总体好感度，也不要评价用户与其他群友的关系。',
    person: {
      userId: String(person.userId || ''),
      primaryName: String(person.primaryName || person.name || ''),
      isFriend: Boolean(person.isFriend),
      firstSeenAt: Number(person.firstSeenAt) || 0,
      lastSeenAt: Number(person.lastSeenAt) || 0
    },
    contextOnlyMemory: (Array.isArray(memoryContext) ? memoryContext : []).slice(0, 6).map((item) => ({
      content: String(item?.content || '').slice(0, 300),
      observedAt: Number(item?.observedAt || item?.lastObservedAt || item?.createdAt) || 0
    })),
    openFlags: (Array.isArray(openFlags) ? openFlags : []).slice(0, 6),
    agentContext: (Array.isArray(agentContext) ? agentContext : []).slice(0, 24),
    NEW_EVIDENCE: (Array.isArray(evidence) ? evidence : []).slice(0, 64).map((item) => ({
      evidenceId: String(item.evidenceId || ''),
      chatKey: String(item.chatKey || ''),
      messageId: Number(item.messageId) || 0,
      at: Number(item.at) || 0,
      text: String(item.text || '').slice(0, 1000),
      mentionsAgent: Boolean(item.mentionsAgent),
      repliesToAgent: Boolean(item.repliesToAgent)
    })),
    rules: [
      'evidenceIds 只能从 NEW_EVIDENCE.evidenceId 中选择',
      'contextOnlyMemory 和 agentContext 不能当作事件证据；尤其不能因为机器人说了亲密的话就提高关系',
      '群聊消息如果看不出是在对 Agent 说，就不要把它归因到用户与 Agent 的关系',
      '没有明确关系变化时 events 必须为空',
      '同一组证据不要重复制造多个近义事件',
      'repair 只有在确有前置摩擦/边界问题时成立'
    ]
  }, null, 2);
}
