const DEFAULT_ENDPOINTS = Object.freeze({
  dsh: 'http://127.0.0.1:3080/',
  bridge: 'http://127.0.0.1:3100/api/status',
  snowluma: 'http://127.0.0.1:15099/api/ui/public',
  novnc: 'http://127.0.0.1:16081/'
});

export const SNOWLUMA_WEBUI_URL = String(
  process.env.SNOWLUMA_WEBUI_URL || 'http://127.0.0.1:15099'
).replace(/\/+$/, '');

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function integrationError(message, httpStatus = 502) {
  return Object.assign(new Error(message), { httpStatus });
}

async function probe(fetchFn, url) {
  try {
    const response = await fetchFn(url, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(2_500)
    });
    return response.status > 0 && response.status < 500;
  } catch {
    return false;
  }
}

export async function integrationStatus({
  fetchFn = fetch,
  endpoints = DEFAULT_ENDPOINTS
} = {}) {
  const checks = await Promise.all(
    Object.entries(endpoints).map(async ([id, url]) => ({
      id,
      online: await probe(fetchFn, url)
    }))
  );

  return {
    checkedAt: Date.now(),
    services: [
      { id: 'agent', online: true },
      ...checks
    ]
  };
}

export async function updateSnowLumaPassword({
  currentPassword,
  newPassword,
  confirmPassword,
  fetchFn = fetch,
  baseUrl = SNOWLUMA_WEBUI_URL
}) {
  const current = String(currentPassword ?? '');
  const next = String(newPassword ?? '');
  const confirm = String(confirmPassword ?? '');

  if (!current) throw integrationError('请输入当前 SnowLuma 密钥', 400);
  if (next !== confirm) throw integrationError('两次输入的新密钥不一致', 400);
  if (
    next.length < 10
    || !/[a-z]/.test(next)
    || !/[A-Z]/.test(next)
    || !/[^A-Za-z0-9\s]/.test(next)
    || /\s/.test(next)
  ) {
    throw integrationError(
      '新密钥至少 10 位，且需包含大小写字母和特殊符号',
      400
    );
  }
  if (current === next) throw integrationError('新密钥不能与当前密钥相同', 400);

  let login;
  try {
    login = await fetchFn(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: current }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw integrationError('SnowLuma WebUI 不可达');
  }

  const loginBody = await responseJson(login);
  if (loginBody.needsTotp) {
    throw integrationError(
      'SnowLuma 已启用二次验证，请在 SnowLuma WebUI 内修改密钥',
      409
    );
  }
  if (!login.ok || loginBody.success !== true) {
    throw integrationError(
      login.status === 401 ? '当前 SnowLuma 密钥不正确' : 'SnowLuma 登录验证失败',
      login.status === 401 ? 403 : 502
    );
  }
  if (!loginBody.token) throw integrationError('SnowLuma 未返回登录会话');

  let changed;
  try {
    changed = await fetchFn(`${baseUrl}/api/auth/change-password`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${loginBody.token}`
      },
      body: JSON.stringify({
        oldPassword: current,
        newPassword: next
      }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw integrationError('SnowLuma 密钥更新请求失败');
  }

  const changedBody = await responseJson(changed);
  if (!changed.ok || changedBody.success !== true) {
    throw integrationError(
      String(changedBody.message || 'SnowLuma 密钥更新失败'),
      changed.status >= 400 && changed.status < 500 ? changed.status : 502
    );
  }

  return { ok: true };
}
