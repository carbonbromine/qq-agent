import crypto from 'node:crypto';
import { getConfig } from './config.js';

const MANUAL_FRIEND_REVIEW_PATH = '/api/identity-pilot/friend-review/manual';
const MANUAL_ARGUMENT_NORMALIZER = Symbol('manualFriendReviewArgumentNormalizer');

function sameSecret(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue ?? ''));
  const right = Buffer.from(String(rightValue ?? ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authorize(req) {
  const token = String(getConfig().server?.token ?? '');
  const origin = String(req.headers.origin || '');
  if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) {
    return false;
  }
  if (!token) {
    return /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host || '');
  }
  const url = new URL(req.url, 'http://127.0.0.1');
  const cookie = String(req.headers.cookie || '')
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith('qq_agent_token='));
  const cookieValue = cookie?.slice('qq_agent_token='.length) || '';
  return sameSecret(req.headers['x-console-token'], token)
    || sameSecret(url.searchParams.get('token'), token)
    || sameSecret(cookieValue, encodeURIComponent(token));
}

async function readJsonBody(req, maxBytes = 32 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    throw new Error('请求体必须是 JSON');
  }
}

function json(res, status, value) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(value));
}

/**
 * OpenAI-compatible 网关并不都严格遵循 function.arguments:string：
 * 有些会直接返回已经解码的对象；另一些模型偶尔会把 JSON 包在代码块中，
 * 或输出一个 harmless trailing comma。好友评估的下游校验仍要求标准 JSON，
 * 所以这里只做保守的“转成标准 JSON 字符串”，绝不 eval 任意文本。
 */
export function normalizeManualToolArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return JSON.stringify(raw);
  }
  if (typeof raw !== 'string') return raw;

  const original = raw.trim();
  const unfenced = original
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const firstBrace = unfenced.indexOf('{');
  const lastBrace = unfenced.lastIndexOf('}');
  const extracted = firstBrace >= 0 && lastBrace > firstBrace
    ? unfenced.slice(firstBrace, lastBrace + 1)
    : unfenced;
  const candidates = [...new Set([original, unfenced, extracted])].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return JSON.stringify(value);
      }
    } catch { /* try the next conservative repair */ }

    const withoutTrailingComma = candidate.replace(/,\s*([}\]])/g, '$1');
    if (withoutTrailingComma === candidate) continue;
    try {
      const value = JSON.parse(withoutTrailingComma);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return JSON.stringify(value);
      }
    } catch { /* leave the original value for the strict downstream validator */ }
  }
  return raw;
}

function normalizeManualReviewResponse(response) {
  const message = response?.message;
  if (!message || !Array.isArray(message.tool_calls)) return response;
  return {
    ...response,
    message: {
      ...message,
      tool_calls: message.tool_calls.map((call) => {
        if (!call?.function) return call;
        return {
          ...call,
          function: {
            ...call.function,
            arguments: normalizeManualToolArguments(call.function.arguments)
          }
        };
      })
    }
  };
}

function ensureManualArgumentNormalizer(manager) {
  if (!manager || manager[MANUAL_ARGUMENT_NORMALIZER]) return;
  const complete = manager.manualFriendReviewComplete;
  if (typeof complete !== 'function') return;
  manager.manualFriendReviewComplete = async (...args) =>
    normalizeManualReviewResponse(await complete(...args));
  Object.defineProperty(manager, MANUAL_ARGUMENT_NORMALIZER, {
    value: true,
    enumerable: false,
    configurable: false
  });
}

async function handleManualFriendReview(app, req, res) {
  if (!authorize(req)) {
    json(res, 401, { error: '未授权' });
    return;
  }
  const manager = app.identityPilot;
  if (!manager?.active || typeof manager.manualFriendReview !== 'function') {
    json(res, 409, { error: '主动好友候选功能未启用' });
    return;
  }
  ensureManualArgumentNormalizer(manager);
  try {
    const body = await readJsonBody(req);
    const result = await manager.manualFriendReview({
      userId: body.userId,
      chatKey: body.chatKey,
      requestedBy: 'console'
    });
    json(res, 200, result);
  } catch (error) {
    json(res, 409, { error: String(error?.message ?? error) });
  }
}

/**
 * createApp() owns the main HTTP request handler. To keep the large app.js untouched,
 * replace its single request listener with a tiny dispatcher that intercepts only the
 * manual friend-review endpoint and delegates every other request unchanged.
 */
export function installManualFriendReviewRoute(app) {
  const server = app?.server;
  if (!server) throw new Error('manual friend review route requires app.server');
  const existing = server.listeners('request');
  if (existing.length !== 1) {
    throw new Error(`expected one HTTP request listener, got ${existing.length}`);
  }
  const baseHandler = existing[0];
  server.removeListener('request', baseHandler);
  server.on('request', (req, res) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
      return baseHandler(req, res);
    }
    if (req.method === 'POST' && pathname === MANUAL_FRIEND_REVIEW_PATH) {
      handleManualFriendReview(app, req, res).catch((error) => {
        json(res, 500, { error: String(error?.message ?? error) });
      });
      return;
    }
    baseHandler(req, res);
  });
  return app;
}
