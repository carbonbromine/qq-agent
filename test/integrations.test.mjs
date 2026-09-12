import assert from 'node:assert/strict';
import test from 'node:test';

import {
  integrationStatus,
  updateSnowLumaPassword
} from '../src/integrations.js';

function response(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; }
  };
}

test('integrationStatus reports each fixed service independently', async () => {
  const result = await integrationStatus({
    endpoints: {
      dsh: 'http://dsh',
      bridge: 'http://bridge',
      snowluma: 'http://snowluma',
      novnc: 'http://novnc'
    },
    fetchFn: async (url) => {
      if (url === 'http://novnc') throw new Error('offline');
      if (url === 'http://bridge') return response(401);
      return response(200);
    }
  });

  assert.deepEqual(
    Object.fromEntries(result.services.map((item) => [item.id, item.online])),
    {
      agent: true,
      dsh: true,
      bridge: true,
      snowluma: true,
      novnc: false
    }
  );
});

test('updateSnowLumaPassword validates locally before any request', async () => {
  let calls = 0;
  await assert.rejects(
    updateSnowLumaPassword({
      currentPassword: 'Current!Pass1',
      newPassword: 'weak',
      confirmPassword: 'weak',
      fetchFn: async () => { calls += 1; }
    }),
    /至少 10 位/
  );
  assert.equal(calls, 0);
});

test('updateSnowLumaPassword performs login and change without returning secrets', async () => {
  const calls = [];
  const result = await updateSnowLumaPassword({
    currentPassword: 'Current!Pass1',
    newPassword: 'New!SecurePass2',
    confirmPassword: 'New!SecurePass2',
    baseUrl: 'http://snowluma',
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/api/login')) {
        return response(200, { success: true, token: 'session-token' });
      }
      return response(200, { success: true });
    }
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://snowluma/api/login');
  assert.equal(calls[1].url, 'http://snowluma/api/auth/change-password');
  assert.equal(calls[1].options.headers.authorization, 'Bearer session-token');
  assert.equal(JSON.stringify(result).includes('SecurePass'), false);
});

test('updateSnowLumaPassword requires native SnowLuma flow when TOTP is enabled', async () => {
  await assert.rejects(
    updateSnowLumaPassword({
      currentPassword: 'Current!Pass1',
      newPassword: 'New!SecurePass2',
      confirmPassword: 'New!SecurePass2',
      fetchFn: async () => response(200, {
        success: false,
        needsTotp: true,
        tempToken: 'temporary'
      })
    }),
    (error) => error.httpStatus === 409 && /二次验证/.test(error.message)
  );
});
