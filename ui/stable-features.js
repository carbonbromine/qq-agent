'use strict';

// Current production UI integration for capabilities that graduated from the
// experiment page. This file deliberately hooks existing render boundaries
// instead of watching every DOM mutation: message/status refreshes must not
// repeatedly delete and recreate controls.
(function installStableFeatureUi() {
  const promotedExperimentControls = [
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

  const textReplacements = [
    ['启停由“设置 → 实验功能”统一控制', '正式功能，随服务恒定启动'],
    ['启停由「设置 → 实验功能」统一控制', '正式功能，随服务恒定启动'],
    ['异常处理试点运行中', '异常处理基础设施运行中'],
    ['异常处理试点', '异常处理基础设施'],
    ['主动发送实验开关已关闭', '主动好友申请为正式功能'],
    ['统一身份库总开关已关闭', '人物统一印象为正式功能']
  ];

  let adminValue = '';
  let adminLoaded = false;
  let adminLoading = null;

  function currentAdminFromState() {
    try {
      return String(state?.config?.admin?.ownerUin || '').trim();
    } catch {
      return '';
    }
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
    const stateValue = currentAdminFromState();
    if (stateValue || !adminLoaded) adminValue = stateValue || adminValue;

    const globalInput = document.querySelector('#cfg-global-admin-owner');
    if (globalInput && document.activeElement !== globalInput) {
      globalInput.value = adminValue;
    }
    document.querySelectorAll('[data-global-admin-mirror="true"]').forEach((input) => {
      input.value = adminValue;
    });
  }

  function loadAdmin() {
    const fromState = currentAdminFromState();
    if (fromState) {
      adminValue = fromState;
      adminLoaded = true;
      syncAdminInputs();
      return Promise.resolve(adminValue);
    }
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

  function replaceText(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      let next = node.nodeValue || '';
      for (const [from, to] of textReplacements) next = next.replaceAll(from, to);
      if (next !== node.nodeValue) node.nodeValue = next;
    }
  }

  function removeControlContainer(control) {
    if (!control) return;
    const container = control.closest('.control-key-row')
      || control.closest('.checkbox-row')
      || control.closest('.field')
      || control.closest('label')
      || control;
    container.remove();
  }

  function stripPromotedExperimentHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    for (const selector of promotedExperimentControls) {
      removeControlContainer(template.content.querySelector(selector));
    }
    // Automated slang research is retired completely. A manually maintained
    // slang asset library is a different feature and remains available.
    removeControlContainer(template.content.querySelector('#cfg-slang-owner'));
    template.content.querySelectorAll('[data-asset-kind="slang-research"]')
      .forEach((node) => node.remove());
    const result = template.content.querySelector('#experiment-launch-result');
    if (result && !template.content.querySelector('.control-key-row')) result.remove();
    return template.innerHTML;
  }

  function replaceLegacyOwnerInput(selector) {
    const input = document.querySelector(selector);
    if (!input || input.dataset.globalAdminMirror === 'true') return;
    const hidden = document.createElement('input');
    hidden.type = 'hidden';
    hidden.id = input.id;
    hidden.dataset.globalAdminMirror = 'true';
    hidden.value = adminValue || currentAdminFromState() || String(input.value || '').trim();
    const wrapper = input.closest('.field') || input.closest('label') || input;
    wrapper.replaceWith(hidden);
  }

  function normalizeFeaturePage(rootSelector) {
    const root = document.querySelector(rootSelector);
    if (!root) return;
    replaceText(root);
    for (const selector of legacyOwnerInputs) replaceLegacyOwnerInput(selector);

    const dispatch = root.querySelector('#cfg-identity-friend-dispatch');
    const dispatchRow = dispatch?.closest('.checkbox-row') || dispatch?.closest('.field');
    if (dispatchRow) {
      const note = document.createElement('div');
      note.className = 'hint';
      note.dataset.stableFriendDispatch = 'true';
      note.textContent = '管理员批准后的好友申请发送为正式能力，恒定启用。';
      dispatchRow.replaceWith(note);
    }
    syncAdminInputs();
  }

  function normalizeNavigation() {
    document.querySelectorAll('[data-feature-nav="identity"]').forEach((el) => {
      el.classList.remove('hidden');
      el.textContent = '人物印象';
    });
    document.querySelectorAll('[data-feature-nav="auto-friend"]').forEach((el) => {
      el.classList.remove('hidden');
    });
    document.querySelectorAll('[data-feature-nav="incidents"]').forEach((el) => {
      el.classList.remove('hidden');
      el.textContent = '异常处理';
    });
    document.querySelectorAll('[data-feature-nav="slang"], #view-slang')
      .forEach((el) => el.remove());
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
      try { if (state?.config) state.config = config; } catch { /* legacy console */ }
      syncAdminInputs();
      if (result) {
        result.textContent = adminValue
          ? `已保存全局管理员 QQ：${adminValue}；已自动加入私聊白名单。`
          : '已清空全局管理员 QQ；人物/好友/异常基础设施继续运行，但 QQ 通知和私聊审批不可用。';
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
    loadAdmin();
  }

  function wrapHtmlRenderer(name, transform) {
    const original = window[name];
    if (typeof original !== 'function' || original.__stableFeatureWrapped) return false;
    const wrapped = function (...args) {
      return transform(original.apply(this, args), args);
    };
    wrapped.__stableFeatureWrapped = true;
    window[name] = wrapped;
    return true;
  }

  function wrapDomRenderer(name, after) {
    const original = window[name];
    if (typeof original !== 'function' || original.__stableFeatureWrapped) return false;
    const wrapped = function (...args) {
      const result = original.apply(this, args);
      after(args);
      return result;
    };
    wrapped.__stableFeatureWrapped = true;
    window[name] = wrapped;
    return true;
  }

  // Remove promoted/retired controls before the experiment section reaches DOM.
  wrapHtmlRenderer('renderExperimentalSettingsSection', stripPromotedExperimentHtml);

  // Settings pages are rebuilt on every section switch, so install the one
  // global administrator entry exactly once per render.
  wrapDomRenderer('renderSettings', () => {
    installGlobalAdminPanel();
    for (const selector of legacyOwnerInputs) replaceLegacyOwnerInput(selector);
    syncAdminInputs();
  });

  // Feature pages have their own render paths outside Settings.
  wrapDomRenderer('renderIdentityFeaturePage', () => normalizeFeaturePage('#identity-page'));
  wrapDomRenderer('renderFriendFeaturePage', () => normalizeFeaturePage('#friend-page'));
  wrapDomRenderer('renderIncidentFeaturePage', () => normalizeFeaturePage('#incident-page'));

  normalizeNavigation();
  // Normalize any content that was rendered synchronously before this script
  // loaded. No observer is installed; future updates go through wrapped renderers.
  normalizeFeaturePage('#identity-page');
  normalizeFeaturePage('#friend-page');
  normalizeFeaturePage('#incident-page');
  installGlobalAdminPanel();
})();
