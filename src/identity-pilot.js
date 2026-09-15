import { IdentityPilotManager as CoreIdentityPilotManager } from './identity-pilot-core.js';
import { chatCompletionWithRetry, cachedTokensOfUsage } from './llm.js';

export { inactiveIdentityPilotStatus } from './identity-pilot-core.js';

function cloneAuditMessages(messages) {
  return structuredClone(Array.isArray(messages) ? messages : []);
}

function buildCallUsage(response) {
  const usage = response?.usage || {};
  const promptTokens = Number(usage.prompt_tokens) || 0;
  const cachedTokens = Math.min(promptTokens, cachedTokensOfUsage(usage));
  return {
    round: 1,
    promptTokens,
    cachedTokens,
    cacheHitRate: promptTokens ? Math.min(1, cachedTokens / promptTokens) : 0,
    completionTokens: Number(usage.completion_tokens) || 0,
    totalTokens: Number(usage.total_tokens) || 0
  };
}

function normalizeFriendReviewSession(session, audit) {
  if (!session || session.kind !== 'friend-review' || !audit?.response) return;
  const response = audit.response;
  const message = response?.message || {};
  const lastIndex = session.messages.length - 1;
  const last = lastIndex >= 0 ? session.messages[lastIndex] : null;

  // Core implementation historically stored { assistant, toolCalls } here. Convert that
  // legacy shape into the same OpenAI-compatible audit shape used by normal agent sessions.
  if (last && !last.role && ('assistant' in last || 'toolCalls' in last)) {
    session.messages[lastIndex] = {
      role: 'assistant',
      content: message.content ?? null,
      ...(typeof message.reasoning_content === 'string' && message.reasoning_content
        ? { reasoning_content: message.reasoning_content }
        : {}),
      ...(Array.isArray(message.tool_calls) && message.tool_calls.length
        ? { tool_calls: structuredClone(message.tool_calls) }
        : {}),
      raw: response.raw ?? null
    };
  }

  session.inputMessages = cloneAuditMessages(audit.messages);
  session.inputTools = structuredClone(audit.tools);
  session.inputRequestOptions = {
    toolChoice: audit.toolChoice,
    temperature: audit.temperature,
    maxTokens: audit.maxTokens
  };
  session.inputRound = 1;
  session.inputPayloadChars = JSON.stringify({
    messages: audit.messages,
    tools: audit.tools
  }).length;
  session.finishReason = response.finishReason ?? null;
  session.model = response.model || session.model || '';
  session.callUsage = [buildCallUsage(response)];
}

function wrapSessions(sessions, takeAudit) {
  if (!sessions) return sessions;
  const live = new Map();

  return new Proxy(sessions, {
    get(target, prop) {
      if (prop === 'create') {
        return (...args) => {
          const session = target.create(...args);
          if (session?.id) live.set(session.id, session);
          return session;
        };
      }
      if (prop === 'update') {
        return (id, ...args) => {
          const session = live.get(id);
          if (session?.kind === 'friend-review') {
            const audit = takeAudit(false);
            if (audit) normalizeFriendReviewSession(session, audit);
          }
          return target.update(id, ...args);
        };
      }
      if (prop === 'finish') {
        return (id, ...args) => {
          const session = live.get(id);
          if (session?.kind === 'friend-review') {
            const audit = takeAudit(true);
            if (audit) normalizeFriendReviewSession(session, audit);
          }
          const result = target.finish(id, ...args);
          live.delete(id);
          return result;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

export class IdentityPilotManager extends CoreIdentityPilotManager {
  constructor(options = {}) {
    let pendingAudit = null;
    const originalComplete = options.complete || chatCompletionWithRetry;
    const complete = async (args, ...rest) => {
      const response = await originalComplete(args, ...rest);
      pendingAudit = {
        messages: cloneAuditMessages(args?.messages),
        tools: structuredClone(Array.isArray(args?.tools) ? args.tools : []),
        toolChoice: args?.toolChoice ?? 'auto',
        temperature: args?.temperature ?? null,
        maxTokens: args?.maxTokens ?? null,
        response
      };
      return response;
    };
    const takeAudit = (consume) => {
      const audit = pendingAudit;
      if (consume) pendingAudit = null;
      return audit;
    };

    super({
      ...options,
      complete,
      sessions: wrapSessions(options.sessions, takeAudit)
    });
  }
}
