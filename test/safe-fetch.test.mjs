import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
const { safeFetchBinary } = await import('../src/safe-fetch.js');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('safeFetchBinary rejects an oversized response instead of returning truncated bytes', async (t) => {
  setRuntimeConfig({
    ...structuredClone(DEFAULT_CONFIG),
    security: { allowPrivateImageHosts: true }
  });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from([1, 2, 3, 4, 5]));
  });
  const port = await listen(server);
  t.after(() => server.close());

  await assert.rejects(
    safeFetchBinary(`http://127.0.0.1:${port}/image`, 4),
    /超过 4 字节限制/
  );
});

test('safeFetchBinary accepts a response exactly at the byte limit', async (t) => {
  setRuntimeConfig({
    ...structuredClone(DEFAULT_CONFIG),
    security: { allowPrivateImageHosts: true }
  });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from([1, 2, 3, 4]));
  });
  const port = await listen(server);
  t.after(() => server.close());

  const result = await safeFetchBinary(`http://127.0.0.1:${port}/image`, 4);
  assert.deepEqual(result.buffer, Buffer.from([1, 2, 3, 4]));
});
