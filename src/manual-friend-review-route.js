import crypto from 'node:crypto';
import { getConfig } from './config.js';

const MANUAL_FRIEND_REVIEW_PATH = '/api/identity-pilot/friend-review/manual';

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
