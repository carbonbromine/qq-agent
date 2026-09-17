'use strict';

// 全局 QQ 黑名单：与现有“按群屏蔽名单”并列。
// deny.users 中的 QQ 无论从私聊还是任意群聊发来消息，都在现有入站过滤层直接丢弃。
(function globalBlocklistUi() {
  let rendering = false;
  let timer = null;

  function usersOf(config) {
    return [...new Set((Array.isArray(config?.deny?.users) ? config.deny.users : [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean))];
  }

  function parseUsers(text) {
    const values = String(text || '')
      .split(/[\s,，;；]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    const invalid = values.filter((value) => !/^\d{5,15}$/.test(value));
    if (invalid.length) {
      throw new Error(`QQ 号必须为 5 到 15 位数字：${invalid.slice(0, 5).join('、')}`);
    }
    return [...new Set(values)];
  }

  function updateSummary(row, config) {
    const count = usersOf(config).length;
    const summary = row?.querySelector('#global-blocklist-summary');
    if (summary) {
      summary.textContent = count
        ? `当前 ${count} 个 QQ；群聊、私聊消息和拍一拍均不进入处理链路。`
        : '当前为空。';
    }
  }

  function openManager(row) {
    const current = usersOf(state.config || {});
    const overlay = modelModalShell({
      head: '全局 QQ 黑名单',
      body: `
        <div class="field">
          <label>QQ 号</label>
          <textarea id="global-blocklist-input" rows="10" placeholder="每行一个 QQ 号，也支持逗号或空格分隔">${esc(current.join('\n'))}</textarea>
          <div class="hint" style="margin-top:6px">命中后，无论该 QQ 在哪个群发言或直接私聊，消息都不会存档、不会触发生命周期、不会进入人物记忆/关系/黑话观察，也不会作为聊天背景交给模型。现有按群屏蔽名单仍独立生效。</div>
          <div class="hint" id="global-blocklist-status" style="margin-top:6px"></div>
        </div>`,
      foot: '<button type="button" class="btn" id="global-blocklist-cancel">取消</button><button type="button" class="btn btn-primary" id="global-blocklist-save">保存</button>'
    });

    overlay.querySelector('#global-blocklist-cancel')?.addEventListener('click', () => closeModelModal(overlay));
    overlay.querySelector('#global-blocklist-save')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const status = overlay.querySelector('#global-blocklist-status');
      try {
        const users = parseUsers(overlay.querySelector('#global-blocklist-input')?.value || '');
        button.disabled = true;
        if (status) status.textContent = '保存中…';
        const data = await api('/api/config', {
          method: 'POST',
          body: JSON.stringify({ deny: { users } })
        });
        state.config = data.config || state.config;
        updateSummary(row, state.config);
        closeModelModal(overlay);
      } catch (error) {
        if (status) status.textContent = `保存失败：${error?.message || error}`;
        button.disabled = false;
      }
    });
  }

  async function ensureRow() {
    if (rendering || document.getElementById('global-blocklist-row')) return;
    const groupButton = document.getElementById('blocklist-btn');
    const field = groupButton?.closest('.field');
    if (!field?.parentElement) return;

    rendering = true;
    try {
      if (!state.config) {
        const data = await api('/api/config');
        state.config = data.config || data;
      }
      if (document.getElementById('global-blocklist-row')) return;

      const row = document.createElement('div');
      row.className = 'field';
      row.id = 'global-blocklist-row';
      row.innerHTML = `
        <button class="btn btn-small" type="button" id="global-blocklist-btn">管理全局 QQ 黑名单</button>
        <div class="hint" id="global-blocklist-summary" style="margin-top:6px"></div>`;
      field.insertAdjacentElement('afterend', row);
      updateSummary(row, state.config || {});
      row.querySelector('#global-blocklist-btn')?.addEventListener('click', () => openManager(row));
    } catch {
      // UI 增强失败不能影响主设置页。
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
