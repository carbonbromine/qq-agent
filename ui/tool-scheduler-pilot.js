'use strict';

// 工具调度器仍处于实验阶段，不占用独立产品页；只在“设置 → 实验功能”里挂一个开关。
// 关闭时后端直接走 tools-core.js，前端也不触碰正常会话逻辑。
(function toolSchedulerPilotSettings() {
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

  const clampParallel = (value) => Math.min(8, Math.max(2, Number(value) || 4));

  function setState(row, config) {
    const pilot = config?.toolSchedulerPilot || {};
    const enabled = pilot.enabled === true;
    const parallel = clampParallel(pilot.maxParallelReads);
    const toggle = row.querySelector('#cfg-tool-scheduler-pilot-enabled');
    const limit = row.querySelector('#cfg-tool-scheduler-pilot-parallel');
    const status = row.querySelector('#experiment-tool-scheduler-state');
    if (toggle) toggle.checked = enabled;
    if (limit) limit.value = String(parallel);
    if (status) {
      status.textContent = enabled
        ? `已启用 · finish 终止屏障 · 只读并发上限 ${parallel}`
        : '已停用 · 使用当前串行工具路径';
    }
  }

  async function save(row) {
    const toggle = row.querySelector('#cfg-tool-scheduler-pilot-enabled');
    const limit = row.querySelector('#cfg-tool-scheduler-pilot-parallel');
    const status = row.querySelector('#experiment-tool-scheduler-state');
    const patch = {
      toolSchedulerPilot: {
        enabled: toggle?.checked === true,
        maxParallelReads: clampParallel(limit?.value)
      }
    };
    if (status) status.textContent = '保存中…';
    try {
      const response = await api('/api/config', {
        method: 'POST',
        body: JSON.stringify(patch)
      });
      setState(row, response.config || patch);
    } catch (error) {
      if (status) status.textContent = `保存失败：${error?.message || error}`;
    }
  }

  async function ensureRow() {
    if (rendering || document.getElementById('experiment-tool-scheduler-row')) return;
    const heading = document.getElementById('settings-experiments');
    const section = heading?.closest('.experimental-settings');
    const list = section?.querySelector('.control-key-list');
    if (!list) return;
    rendering = true;
    try {
      const config = await api('/api/config');
      if (!document.body.contains(list) || document.getElementById('experiment-tool-scheduler-row')) return;
      const row = document.createElement('div');
      row.className = 'control-key-row';
      row.id = 'experiment-tool-scheduler-row';
      row.innerHTML = `
        <span>
          <strong>工具调度器</strong>
          <small id="experiment-tool-scheduler-state">读取中…</small>
          <small>仅并行明确只读工具；发送/写入仍串行。关闭后工具 schema、执行顺序和 finish 行为均回到当前实现。</small>
        </span>
        <span class="settings-actions" style="margin:0;align-items:center">
          <label class="field" style="margin:0;min-width:110px">
            <span class="muted">只读并发</span>
            <input id="cfg-tool-scheduler-pilot-parallel" type="number" min="2" max="8" step="1" style="width:64px" />
          </label>
          <label class="checkbox-row" style="margin:0">
            <input type="checkbox" id="cfg-tool-scheduler-pilot-enabled" />
            <span>启用</span>
          </label>
        </span>`;
      list.appendChild(row);
      setState(row, config);
      row.querySelector('#cfg-tool-scheduler-pilot-enabled')?.addEventListener('change', () => save(row));
      row.querySelector('#cfg-tool-scheduler-pilot-parallel')?.addEventListener('change', () => save(row));
    } catch {
      // 设置页本身会展示接口错误；实验增强失败不能影响正常设置页。
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
