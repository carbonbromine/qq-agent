import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import http from 'node:http';
import { chatCompletion, chatCompletionWithRetry, isRetryableError } from '../src/llm.js';
import { DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';

describe('LLM client', () => {
  it('strips local trace fields but preserves provider reasoning required by tool loops', async (t) => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.equal(body.messages[0].raw, undefined);
      assert.equal(body.messages[0].reasoning_content, 'private provider state');
      return Response.json({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 25 } });
    };
    const result = await chatCompletion({ messages: [{
      role: 'assistant',
      content: 'hello',
      reasoning_content: 'private provider state',
      raw: { large: true }
    }],
      overrides: { baseUrl: 'https://example.com/v1', model: 'mock' } });
    assert.equal(result.usage.total_tokens, 25);
  });

  it('adds a cache routing key only for official OpenAI-compatible hosts', async (t) => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const bodies = [];
    globalThis.fetch = async (_url, request) => {
      bodies.push(JSON.parse(request.body));
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    };
    await chatCompletion({
      messages: [{ role: 'user', content: 'hello' }],
      cacheKey: 'stable-prefix',
      overrides: { baseUrl: 'https://api.openai.com/v1', model: 'mock' }
    });
    await chatCompletion({
      messages: [{ role: 'user', content: 'hello' }],
      cacheKey: 'stable-prefix',
      overrides: { baseUrl: 'https://gateway.invalid/v1', model: 'mock' }
    });
    assert.equal(bodies[0].prompt_cache_key, 'stable-prefix');
    assert.equal(bodies[1].prompt_cache_key, undefined);
  });

  it('cancels while reading a stalled response body after receiving headers', async (t) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"choices":');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Run cancelled')), 100);
    t.after(() => clearTimeout(timer));
    await assert.rejects(chatCompletion({ messages: [], signal: controller.signal,
      overrides: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'mock' } }), /Run cancelled/);
  });

  it('does not retry authentication errors or explicitly cancelled requests', async (t) => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.api.baseUrl = 'https://example.com/v1';
    setRuntimeConfig(cfg);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('unauthorized', { status: 401 }); };
    await assert.rejects(chatCompletionWithRetry({ messages: [] }), /401/);
    assert.equal(calls, 1);
    const signal = AbortSignal.abort(new Error('Run cancelled'));
    await assert.rejects(chatCompletionWithRetry({ messages: [], signal }), /cancelled/);
    assert.equal(calls, 1);
    assert.equal(isRetryableError(new Error('HTTP 503')), true);
    assert.equal(isRetryableError(new Error('HTTP 400')), false);
  });
});
