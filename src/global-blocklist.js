const QQ_UIN_RE = /^\d{5,15}$/;

export function normalizeGlobalBlocklist(values, { strict = false } = {}) {
  const input = Array.isArray(values) ? values : [];
  const out = [];
  const seen = new Set();
  for (const value of input) {
    const uin = String(value ?? '').trim();
    if (!uin) continue;
    if (!QQ_UIN_RE.test(uin)) {
      if (strict) throw new Error(`黑名单 QQ 必须为 5 到 15 位数字：${uin}`);
      continue;
    }
    if (seen.has(uin)) continue;
    seen.add(uin);
    out.push(uin);
  }
  return out;
}

export function globalBlockedUsers(cfg = {}) {
  return normalizeGlobalBlocklist(cfg?.deny?.users);
}

/**
 * 返回仅供运行时访问控制使用的配置视图。
 *
 * 现有入站链路已经有两层过滤：
 * - private 会话：allowed() 读取 cfg.deny.private
 * - group 消息/拍一拍：读取 cfg.blocklist[groupId]
 *
 * 全局黑名单复用这两个成熟入口：
 * - deny.users 动态并入 deny.private
 * - deny.users 动态并入任意 groupId 的 blocklist
 *
 * Proxy 的 toJSON 始终返回原始对象，因此 /api/config、配置落盘和前端群级
 * blocklist 编辑看到的仍是原始数据，不会把全局黑名单复制进每个群。
 */
export function withGlobalBlocklistRuntimeView(cfg = {}) {
  const users = globalBlockedUsers(cfg);
  if (!users.length) return cfg;

  const rawDeny = cfg.deny && typeof cfg.deny === 'object' ? cfg.deny : {};
  const rawBlocklist = cfg.blocklist && typeof cfg.blocklist === 'object' ? cfg.blocklist : {};

  const deny = new Proxy(rawDeny, {
    get(target, prop, receiver) {
      if (prop === 'toJSON') return () => target;
      if (prop === 'private') {
        return [...new Set([
          ...(Array.isArray(target.private) ? target.private.map(String) : []),
          ...users
        ])];
      }
      return Reflect.get(target, prop, receiver);
    }
  });

  const blocklist = new Proxy(rawBlocklist, {
    get(target, prop, receiver) {
      if (prop === 'toJSON') return () => target;
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        return [...new Set([
          ...(Array.isArray(target[prop]) ? target[prop].map(String) : []),
          ...users
        ])];
      }
      return Reflect.get(target, prop, receiver);
    }
  });

  return {
    ...cfg,
    deny,
    blocklist
  };
}
