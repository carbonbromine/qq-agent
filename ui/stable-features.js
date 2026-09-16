'use strict';

// Production feature UI invariants. app.js is intentionally kept backwards
// compatible with older consoles; this post-render layer removes controls that
// are no longer independently configurable and exposes one global admin QQ.
(function installStableFeatureUi() {
  const replacements = [
    ['启停由“设置 → 实验功能”统一控制', '正式功能，随服务恒定启动'],
    ['启停由「设置 → 实验功能」统一控制', '正式功能，随服务恒定启动'],
    ['异常处理试点运行中', '异常处理基础设施运行中'],
    ['异常处理试点', '异常处理基础设施'],
    ['主动发送实验开关已关闭', '主动好友申请为正式功能'],
    ['统一身份库总开关已关闭', '人物统一印象为正式功能']
  ];

  const retiredExperimentControls = [
    '#cfg-identity-pilot-enabled',
    '#cfg-auto-friend-enabled',
    '#cfg-slang-pilot-enabled',
    '#cfg-incident-pilot-enabled'
  ];

  const legacyOwnerInputs = [
    '#cfg-identity-friend-owner',
    '#cfg-incident-owner',
    '#cfg-slang-owner',
    '#auto-update-owner'
  ];

  let adminValue = '';
  let adminLoaded = false;
  let adminLoading = null;

  function replaceText(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      let next = node.nodeValue || '';
      for (const [from, to] of replacements) next = next.replaceAll(from, to);
      if (next !== node.nodeValue) node.nodeValue = next;
    }
  }

  function setLabel(el, label) {
    if (el && el.textContent !== label) el.textContent = label;
  }

  async function configRequest(method = 'GET', body = null) {
    const response = await fetch('/api/config', {
      method,
      headers: {
        'content-type': 'application/json',
        'x-console-token': 'qq-agent-console'
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data.config || data;
  }

  function syncAdminInputs() {
    const globalInput = document.querySelector('#cfg-global-admin-owner');
    if (globalInput && adminLoaded && document.activeElement !== globalInput) {
      globalInput.value = adminValue;
    }
    document.querySelectorAll('[data-global-admin-mirror="true"]').forEach((input) => {
      if (input.value !== adminValue) input.value = adminValue;
    });
  }

  function loadAdmin() {
    if (adminLoaded) {
      syncAdminInputs();
      return Promise.resolve(adminValue);
    }
    if (adminLoading) return adminLoading;
    adminLoading = configRequest()
      .then((config) => {
        adminValue = String(config?.admin?.ownerUin || '').trim();
        adminLoaded = true;
        syncAdminInputs();
        return adminValue;
      })
      .catch(() => '')
      .finally(() => { adminLoading = null; });
    return adminLoading;
  }

  async function saveAdmin(panel) {
    const input = panel.querySelector('#cfg-global-admin-owner');
    const result = panel.querySelector('[data-global-admin-result]');
    const button = panel.querySelector('[data-global-admin-save]');
    const ownerUin = String(input?.value || '').trim();
    if (ownerUin && !/^\d{5,15}$/.test(ownerUin)) {
      if (result) result.textContent = '管理员 QQ 必须为 5 到 15 位数字。';
      return;
    }
    if (button) button.disabled = true;
    if (result) result.textContent = '正在保存…';
    try {
      const config = await configRequest('POST', { admin: { ownerUin } });
      adminValue = String(config?.admin?.ownerUin || '').trim();
      adminLoaded = true;
      syncAdminInputs();
      if (result) {
        result.textContent = adminValue
          ? `已保存全局管理员 QQ：${adminValue}；已自动加入私聊白名单。`
          : '已清空全局管理员 QQ；基础设施继续运行，但 QQ 通知/审批入口不可用。';
      }
    } catch (error) {
      if (result) result.textContent = `保存失败：${String(error?.message || error)}`;
    } finally {
      if (button) button.disabled = false;
    }
  }

  function installGlobalAdminPanel() {
    const form = document.querySelector('#settings-form');
    if (!form || form.querySelector('[data-global-admin-settings]')) return;

    const panel = document.createElement('section');
    panel.dataset.globalAdminSettings = 'true';
    panel.style.cssText = 'padding-bottom:16px;margin-bottom:18px;border-bottom:1px solid var(--border)';
    panel.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div>
          <h3 style="margin:0 0 4px">全局管理员 QQ</h3>
          <div class="hint">好友审批、异常告警、自动更新等所有管理员能力统一使用此 QQ。保存后会自动加入私聊白名单。</div>
        </div>
        <button type="button" class="btn btn-primary btn-small" data-global-admin-save>保存管理员</button>
      </div>
      <div class="field-row" style="margin-top:12px">
        <div class="field">
          <label for="cfg-global-admin-owner">管理员 QQ</label>
          <input type="text" id="cfg-global-admin-owner" inputmode="numeric" autocomplete="off" placeholder="5 到 15 位 QQ 号" />
        </div>
      </div>
      <div class="hint" data-global-admin-result></div>`;
    panel.querySelector('[data-global-admin-save]')?.addEventListener('click', () => saveAdmin(panel));
    panel.querySelector('#cfg-global-admin-owner')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveAdmin(panel);
      }
    });
    form.prepend(panel);
    if (adminLoaded) syncAdminInputs();
    else loadAdmin();
  }

  function prunePromotedRows() {
    for (const selector of retiredExperimentControls) {
      const control = document.querySelector(selector);
      const row = control?.closest('.control-key-row');
      if (row) row.remove();
    }
    const result = document.querySelector('#experiment-launch-result');
    if (result && !result.closest('.experimental-settings')?.querySelector('.control-key-row')) {
      result.remove();
    }
  }

  function replaceLegacyOwnerInputs() {
    for (const selector of legacyOwnerInputs) {
      const input = document.querySelector(selector);
      if (!input || input.dataset.globalAdminMirror === 'true') continue;
      const hidden = document.createElement('input');
      hidden.type = 'hidden';
      hidden.id = input.id;
      hidden.dataset.globalAdminMirror = 'true';
      hidden.value = adminLoaded ? adminValue : String(input.value || '').trim();
      const wrapper = input.closest('.field') || input.closest('label') || input;
      wrapper.replaceWith(hidden);
    }
    if (adminLoaded) syncAdminInputs();
  }

  function prune() {
    // Keep the Experimental Features page itself: unrelated pilots still live
    // there. Only promoted/retired controls disappear.
    prunePromotedRows();

    document.querySelectorAll('[data-feature-nav="identity"]').forEach((el) => {
      el.classList.remove('hidden');
      setLabel(el, '人物印象');
    });
    document.querySelectorAll('[data-feature-nav="auto-friend"]').forEach((el) => {
      el.classList.remove('hidden');
    });
    document.querySelectorAll('[data-feature-nav="incidents"]').forEach((el) => {
      el.classList.remove('hidden');
      setLabel(el, '异常处理');
    });
    document.querySelectorAll('[data-feature-nav="slang"], #view-slang').forEach((el) => el.remove());

    // "slang" is the manual asset library and remains supported. Only the
    // automated slang-research surface is retired.
    document.querySelectorAll('[data-asset-kind="slang-research"]').forEach((el) => el.remove());

    const dispatch = document.querySelector('#cfg-identity-friend-dispatch');
    const row = dispatch?.closest('.checkbox-row');
    if (row) {
      const note = document.createElement('div');
      note.className = 'hint';
      note.dataset.stableFriendDispatch = 'true';
      note.textContent = '管理员批准后的好友申请发送已固化为正式能力，恒定启用。';
      row.replaceWith(note);
    }

    replaceLegacyOwnerInputs();
    installGlobalAdminPanel();
    replaceText(document.querySelector('#identity-page'));
    replaceText(document.querySelector('#friend-page'));
    replaceText(document.querySelector('#incident-page'));
  }

  prune();
  const observer = new MutationObserver(() => prune());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
