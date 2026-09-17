import crypto from 'node:crypto';

export const RELATIONSHIP_V2_EVENT_TYPES = Object.freeze([
  'pleasant_moment',
  'reciprocal_interest',
  'reliable_followthrough',
  'boundary_respect',
  'conflict',
  'boundary_cross',
  'repair'
]);

export const RELATIONSHIP_V2_EVENT_TOOL = {
  type: 'function',
  function: {
    name: 'submit_relationship_v2_events',
    description: '提交目标用户与 Agent 之间本证据窗口内真实发生的关系事件；普通聊天必须提交空数组。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        events: {
          type: 'array',
          maxItems: 4,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', enum: RELATIONSHIP_V2_EVENT_TYPES },
              strength: { type: 'number', minimum: 0, maximum: 1 },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              durableEligible: {
                type: 'boolean',
                description: '只有跨时间兑现、持续尊重边界或可靠投入等难以靠一次对话伪造的行为才可为 true。'
              },
              evidenceIds: {
                type: 'array', minItems: 1, maxItems: 8,
                items: { type: 'string' }
              },
              personaBasisIds: {
                type: 'array', maxItems: 6,
                items: { type: 'string' }
              },
              summary: { type: 'string', maxLength: 240 }
            },
            required: [
              'type', 'strength', 'confidence', 'durableEligible',
              'evidenceIds', 'personaBasisIds', 'summary'
            ]
          }
        },
        noChangeReason: { type: 'string', maxLength: 300 }
      },
      required: ['events']
    }
  }
};

const clean = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

export function personaRelationshipProfile(persona = {}) {
  const roleText = String(persona.roleText || '').trim().slice(0, 8000);
  const customRules = String(persona.customRules || '').trim().slice(0, 2000);
  const basis = [
    ...roleText.split(/\r?\n+/).map((text, index) => ({ id: `role:${index + 1}`, text: clean(text, 600) })),
    ...customRules.split(/\r?\n+/).map((text, index) => ({ id: `rule:${index + 1}`, text: clean(text, 600) }))
  ].filter((item) => item.text).slice(0, 30);
  const version = crypto.createHash('sha256')
    .update(String(persona.botName || ''))
    .update('\0')
    .update(String(persona.behaviorProfile || ''))
    .update('\0')
    .update(roleText)
    .update('\0')
    .update(customRules)
    .digest('hex')
    .slice(0, 16);
  return {
    version: `persona-${version}`,
    botName: clean(persona.botName || 'Agent', 80),
    behaviorProfile: clean(persona.behaviorProfile || 'legacy', 40),
    roleText,
    customRules,
    basis
  };
}

export function buildRelationshipV2SystemPrompt(profile) {
  return [
    '你是关系事件审计器，不是聊天机器人。只判断“目标用户与 Agent”之间的互动事件。',
    'Agent 人格参与判断，但人格只提供价值、偏好和边界；不要模仿口吻，不要替 Agent 编造情绪。',
    '只有标记 countableEvidence=true 的目标用户消息可以成为事件证据；其余消息只用于消歧。',
    '消息数量、寒暄、夸奖、单次聊得开心、Agent 自己表现热情，都不能成为长期关系证据。',
    'durableEligible=true 的门槛极高：必须是跨时间兑现、持续尊重边界、可靠投入或明确修复。',
    '普通愉快互动只能是 pleasant_moment 且 durableEligible=false。',
    '普通意见不同不是 conflict；群友之间的互动不是用户与 Agent 的关系事件。',
    'repair 只修复已有问题，不能被解释为额外的正向关系收益。',
    '不确定时输出 events=[]。最后必须且只能调用 submit_relationship_v2_events。',
    '',
    `【Agent 人格版本】${profile.version}`,
    `【Agent 名称】${profile.botName}`,
    `【行为基线】${profile.behaviorProfile}`,
    '【角色设定】',
    profile.roleText || '（未配置）',
    ...(profile.customRules ? ['【管理员附加规则】', profile.customRules] : []),
    '【可引用的人格依据 ID】',
    ...(profile.basis.length ? profile.basis.map((item) => `${item.id}: ${item.text}`) : ['（无）'])
  ].join('\n');
}

export function buildRelationshipV2UserPrompt({
  userId,
  person = {},
  evidence = [],
  openBoundary = false
} = {}) {
  return JSON.stringify({
    task: '评估本窗口是否包含目标用户与 Agent 之间新的关系事件。不要输出总体好感分。',
    target: {
      userId: String(userId || ''),
      name: clean(person.primaryName || person.name || '', 120),
      isFriend: Boolean(person.isFriend)
    },
    openBoundary: Boolean(openBoundary),
    evidence: evidence.slice(0, 120).map((item) => ({
      evidenceId: String(item.evidenceId || ''),
      chatKey: String(item.chatKey || ''),
      at: Number(item.at) || 0,
      speaker: String(item.speaker || 'other'),
      text: clean(item.text, 1000),
      countableEvidence: item.countableEvidence === true,
      directToAgent: item.directToAgent === true
    }))
  }, null, 2);
}
