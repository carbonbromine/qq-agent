export const DEFAULT_MULTIMODAL_CONTEXT_PILOT = Object.freeze({
  enabled: false,
  graduated: false
});

const MAX_SUMMARY_CHARS = 2000;
const MAX_TOPIC_CHARS = 240;
const MAX_NEXT_STEP_CHARS = 600;
const MAX_LIST_ITEMS = 4;
const MAX_LIST_ITEM_CHARS = 320;
const MAX_SOURCE_MESSAGE_IDS = 8;

function cleanText(value, maxChars) {
  return String(value ?? '')
    .replace(/data:image\/[^;,\s]+;base64,[A-Za-z0-9+/=\r\n]+/gi, '[inline image omitted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function cleanList(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => cleanText(item, MAX_LIST_ITEM_CHARS))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
}

export function multimodalContextPilotConfig(cfg = {}) {
  const raw = cfg?.multimodalContextPilot || {};
  return {
    enabled: raw.enabled === true,
    graduated: raw.graduated === true
  };
}

export function recordMultimodalToolResult(session, name, args = {}, result = {}, cfg = {}) {
  if (!multimodalContextPilotConfig(cfg).enabled || !session || result?.isError) return result;
  const hasImages = Array.isArray(result?.content)
    && result.content.some((part) => part?.type === 'image_url');
  if (hasImages && (name === 'get_message_images' || name === 'get_sticker_image')) {
    const source = name === 'get_message_images'
      ? { kind: 'message', id: String(args?.messageId ?? '').trim() }
      : { kind: 'sticker', id: String(args?.stickerId ?? '').trim() };
    if (source.id) {
      const list = Array.isArray(session.multimodalContextSources)
        ? session.multimodalContextSources
        : [];
      const key = `${source.kind}:${source.id}`;
      if (!list.some((item) => `${item?.kind}:${item?.id}` === key)) {
        session.multimodalContextSources = [...list, source].slice(-MAX_SOURCE_MESSAGE_IDS);
      }
    }
  }
  if (name === 'finish' && session.handoffDraft && Array.isArray(session.multimodalContextSources)
    && session.multimodalContextSources.length) {
    session.handoffDraft.multimodalSources = structuredClone(session.multimodalContextSources);
  }
  return result;
}

export function canonicalMultimodalMessages({
  store,
  chatKey = '',
  checkpointState = {},
  sourceMessageIds = []
} = {}) {
  const platformMessageIds = [];
  const seen = new Set();
  for (const localId of (Array.isArray(sourceMessageIds) ? sourceMessageIds : [])) {
    if (platformMessageIds.length >= MAX_SOURCE_MESSAGE_IDS) break;
    const entry = store?.findByLocalId?.(chatKey, localId);
    const mid = entry?.mid;
    if (mid === null || mid === undefined || String(mid).trim() === '') continue;
    const id = String(mid).trim();
    if (seen.has(id)) continue;
    seen.add(id);
    platformMessageIds.push(id);
  }

  const explicitSources = (Array.isArray(checkpointState?.multimodalSources)
    ? checkpointState.multimodalSources
    : [])
    .map((source) => ({
      kind: source?.kind === 'sticker' ? 'sticker' : 'message',
      id: String(source?.id ?? '').trim()
    }))
    .filter((source) => source.id)
    .slice(0, MAX_SOURCE_MESSAGE_IDS);
  for (const source of explicitSources) {
    if (source.kind === 'message' && !seen.has(source.id)) {
      seen.add(source.id);
      platformMessageIds.push(source.id);
    }
  }
  const stickerIds = [...new Set(explicitSources
    .filter((source) => source.kind === 'sticker')
    .map((source) => source.id))];

  const topic = cleanText(checkpointState?.topic, MAX_TOPIC_CHARS);
  const summary = cleanText(checkpointState?.summary, MAX_SUMMARY_CHARS);
  const facts = cleanList(checkpointState?.facts);
  const decisions = cleanList(checkpointState?.decisions);
  const openQuestions = cleanList(checkpointState?.openQuestions);
  const nextStep = cleanText(checkpointState?.nextStep, MAX_NEXT_STEP_CHARS);
  const lastReply = cleanText(checkpointState?.lastReply, MAX_SUMMARY_CHARS);

  const lines = [
    '[生命周期多模态压缩]',
    '上一批包含仅在当时 Agent Session 中可见的图片/表情；原始图片数据未写入持久化 provider transcript。'
  ];
  if (platformMessageIds.length) {
    lines.push(`相关 QQ 消息：${platformMessageIds.map((id) => `#${id}`).join('、')}。后续如果视觉细节仍重要，可再次调用 get_message_images 重新查看。`);
  }
  if (stickerIds.length) {
    lines.push(`相关表情素材：${stickerIds.join('、')}。后续如需重看，可再次调用 get_sticker_image。`);
  }
  if (topic) lines.push(`话题：${topic}`);
  if (summary) lines.push(`交接摘要：${summary}`);
  if (facts.length) lines.push(`已确认：${facts.join('；')}`);
  if (decisions.length) lines.push(`已决定：${decisions.join('；')}`);
  if (openQuestions.length) lines.push(`待确认：${openQuestions.join('；')}`);
  if (nextStep) lines.push(`下一步：${nextStep}`);

  return [
    { role: 'user', content: lines.join('\n') },
    {
      role: 'assistant',
      content: lastReply || '（本轮未向 QQ 发送消息）'
    }
  ];
}

export function rewriteMultimodalLifecycleCommit(store, options = {}, cfg = {}) {
  const settings = multimodalContextPilotConfig(cfg);
  if (!settings.enabled) return options;
  if (options?.forceRollover !== 'multimodal-context') return options;
  if (options?.closeReason) return options;
  if (options?.persistThread === false) return options;

  const messages = canonicalMultimodalMessages({
    store,
    chatKey: options.chatKey,
    checkpointState: options.checkpointState,
    sourceMessageIds: options.sourceMessageIds
  });
  const threshold = Math.min(
    500000,
    Math.max(5000, Number(cfg?.conversation?.lifecycleRolloverInputTokens) || 32000)
  );
  const actualPromptTokens = Math.max(0, Number(options?.threadOptions?.promptTokens) || 0);
  // 图片 token 只属于刚结束的临时多模态请求。把记录值压到阈值以下，
  // 让下一批用“已去图”的真实请求重新测量一次；非多模态批次仍保存 provider 实测值。
  const promptTokens = actualPromptTokens >= threshold
    ? threshold - 1
    : actualPromptTokens;

  return {
    ...options,
    messages,
    forceRollover: '',
    threadOptions: {
      ...(options.threadOptions || {}),
      promptTokens
    }
  };
}
