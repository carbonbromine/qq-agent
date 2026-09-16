import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  gitTransportPrefix,
  isRetryableUpdateNetworkError,
  normalizeUpdateNetworkSettings,
  retryUpdateOperation
} from '../src/update-network.js';

test('network settings are bounded and keep backward-compatible defaults', () => {
  assert.deepEqual(normalizeUpdateNetworkSettings({}), {
    networkRetries: 4,
    retryBaseMs: 1500,
    retryMaxMs: 15000,
    connectivityTimeoutSeconds: 20,
    fetchTimeoutSeconds: 300,
    forceHttp11: true,
    disableOnFailure: true
  });
  assert.deepEqual(normalizeUpdateNetworkSettings({
    networkRetries: 99,
    retryBaseMs: 5,
    retryMaxMs: 100,
    connectivityTimeoutSeconds: 1,
    fetchTimeoutSeconds: 99999,
    forceHttp11: false,
    disableOnFailure: false
  }), {
    networkRetries: 10,
    retryBaseMs: 100,
    retryMaxMs: 500,
    connectivityTimeoutSeconds: 3,
    fetchTimeoutSeconds: 1800,
    forceHttp11: false,
    disableOnFailure: false
  });
});

test('retry operation uses exponential backoff and stops after success', async () => {
  const delays = [];
  let calls = 0;
  const result = await retryUpdateOperation(async () => {
    calls += 1;
    if (calls < 3) {
      throw Object.assign(new Error('GnuTLS recv error (-110)'), { retryable: true });
    }
    return 'ok';
  }, {
    retries: 4,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    sleep: async (ms) => { delays.push(ms); }
  });
  assert.equal(result.value, 'ok');
  assert.equal(result.attempts, 3);
  assert.deepEqual(delays, [100, 200]);
});

test('non-transient branch/auth errors fail without retry', async () => {
  let calls = 0;
  await assert.rejects(
    retryUpdateOperation(async () => {
      calls += 1;
      throw new Error("fatal: couldn't find remote ref refs/heads/missing");
    }, {
      retries: 5,
      sleep: async () => { throw new Error('should not sleep'); }
    }),
    /couldn't find remote ref/
  );
  assert.equal(calls, 1);
  assert.equal(isRetryableUpdateNetworkError(new Error('GnuTLS recv error (-110)')), true);
  assert.equal(isRetryableUpdateNetworkError(new Error('fatal: the requested URL returned error: 502')), true);
  assert.equal(isRetryableUpdateNetworkError(new Error('Authentication failed')), false);
});

test('Git transport defaults to HTTP/1.1 and can be disabled', () => {
  const args = gitTransportPrefix({ forceHttp11: true, connectivityTimeoutSeconds: 20 });
  assert.ok(args.includes('http.version=HTTP/1.1'));
  assert.ok(args.some((value) => String(value).startsWith('http.lowSpeedTime=')));
  assert.deepEqual(gitTransportPrefix({ forceHttp11: false }), []);
});
