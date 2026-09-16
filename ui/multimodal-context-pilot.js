'use strict';

// 多模态生命周期续接仍处于实验阶段，不占用独立产品页；只在“设置 → 实验功能”里挂开关。
// 关闭时后端保持当前 multimodal-context rollover 行为。
(function multimodalContextPilotSettings() {
  const MARKER = 'qq-agent-console';
  let rendering = false;
  let timer = null;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: {
        'content-type': 'application/json',
        'x-console-token': MARKER,
        ...(options.headers || {})
      },
      ...options
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function setState(row, config) {
    const pilot = config?.multimodalContextPilot || {};
    const enabled = pilot.enabled === true;
    const graduated = pilot.graduated === true;
    const toggle = row.querySelector('#cfg-multimodal-context-pilot-enabled');
    const status = row.querySelector('#experiment-multimodal-context-state');
    if (toggle) toggle.checked = enabled;
    if (status) {
      status.textContent = enabled
        ? `已启用 · 图片仅当前 Session 可见 · 文本化续接${graduated ? ' · 已固化' : ' · 实验中'}`
        : '已停用 · 保持当前 multimodal-context rollover 行为';
    }
  }

  async function save(row) {
    const toggle = row.querySelector('#cfg-multimodal-context-pilot-enabled');
    const status = row.querySelector('#experiment-multimodal-context-state');
    if (status) status.textContent = '保存中…';
    try {
      const current = await api('/api/config');
      const response = await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({
          multimodalContextPilot: {
            enabled: toggle?.checked === true,
            graduated: current?.multimodalContextPilot?.graduated === true
          }
        })
      });
      setState(row, response.config || current);
    } catch (error) {
      if (status) status.textContent = `保存失败：${error?.message || error}`;
    }
  }

  async function ensureRow() {
    if (rendering || document.getElementById('experiment-multimodal-context-row')) return;
    const heading = document.getElementById('settings-experiments');
    const section = heading?.closest('.experimental-settings');
    const list = section?.querySelector('.control-key-list');
    if (!list) return;
    rendering = true;
    try {
      const config = await api('/api/config');
      if (!document.body.contains(list) || document.getElementById('experiment-multimodal-context-row')) return;
      const row = document.createElement('div');
      row.className = 'control-key-row';
      row.id = 'experiment-multimodal-context-row';
      row.innerHTML = `
        <span>
          <strong>多模态上下文续接</strong>
          <small id="experiment-multimodal-context-state">读取中…</small>
          <small>图片/表情仍由当前视觉请求直接查看；跨 Session 不保存 base64，而以检查点摘要和可重新取图的 QQ 消息 ID 续接，避免仅因图片清空生命周期前缀缓存。</small>
        </span>
        <span class="settings-actions" style="margin:0;align-items:center">
          <label class="checkbox-row" style="margin:0">
            <input type="checkbox" id="cfg-multimodal-context-pilot-enabled" />
            <span>启用</span>
          </label>
        </span>`;
      list.appendChild(row);
      setState(row, config);
      row.querySelector('#cfg-multimodal-context-pilot-enabled')?.addEventListener('change', () => save(row));
    } catch {
      // 实验增强失败不能影响正常设置页。
    } finally {
      rendering = false;
    }
  }

  function scheduleEnsure() {
    clearTimeout(timer);
    timer = setTimeout(() => ensureRow().catch(() => {}), 20);
  }

  const observer = new MutationObserver(scheduleEnsure);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', scheduleEnsure, { once: true });
  scheduleEnsure();
})();
