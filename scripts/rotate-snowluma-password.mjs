import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    current: { type: 'string' },
    next: { type: 'string' },
    totp: { type: 'string' }
  }
});

const baseUrl = String(values.url || '').replace(/\/+$/, '');
if (!baseUrl) throw new Error('--url is required');
if (!values.current) throw new Error('--current is required');
if (!values.next) throw new Error('--next is required');

async function post(route, body, token = '') {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  let result = {};
  try {
    result = await response.json();
  } catch {
    // The status below still provides an actionable failure.
  }
  return { response, result };
}

const login = await post('/api/login', {
  password: values.current,
  ...(values.totp ? { totp: values.totp } : {})
});
if (login.result?.needsTotp) {
  throw new Error('SnowLuma has 2FA enabled; rerun with --snowluma-totp');
}
if (!login.response.ok || login.result?.success !== true || !login.result?.token) {
  throw new Error(login.result?.message || `SnowLuma login failed with HTTP ${login.response.status}`);
}

const changed = await post('/api/auth/change-password', {
  oldPassword: values.current,
  newPassword: values.next
}, login.result.token);
if (!changed.response.ok || changed.result?.success !== true) {
  throw new Error(changed.result?.message || `SnowLuma password change failed with HTTP ${changed.response.status}`);
}

console.log(JSON.stringify({ changed: true }));
