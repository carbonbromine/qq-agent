'use strict';

(function globalMemoryConsole() {
  const MARKER = 'qq-agent-console';
  let people = [];
  let selectedKey = '';
  let loadSeq = 0;

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  const fmtTime = (ts) => {
    const n = Number(ts) || 0;
    if (!n) return '-';
    const d = new Date(n);
    const pad = (x) => String(x).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

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

  function ensureStyle() {
    if (document.getElementById('global-memory-style')) return;
    const style = document.createElement('style');
    style.id = 'global-memory-style';
    style.textContent = `
      #view-memory[data-global-memory="1"] > #memory-list,
      #view-memory[data-global-memory="1"] > #memory-detail { display:none !important; }
      #global-memory-list { display:flex; flex-direction:column; }
      #global-memory-items { overflow:auto; min-height:0; }
      .gm-head { display:flex; gap:8px; align-items:center; padding:10px 12px; border-bottom:1px solid var(--border-color, rgba(128,128,128,.2)); }
      .gm-head strong { flex:1; }
      .gm-person { display:block; width:100%; border:0; border-bottom:1px solid var(--border-color, rgba(128,128,128,.15)); background:transparent; color:inherit; text-align:left; padding:11px 12px; cursor:pointer; }
      .gm-person:hover, .gm-person.active { background:var(--hover-bg, rgba(127,127,127,.10)); }
      .gm-person-title { display:flex; gap:8px; align-items:center; }
      .gm-person-title strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .gm-count { margin-left:auto; font-size:12px; opacity:.7; }
      .gm-sub { margin-top:4px; font-size:12px; opacity:.65; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .gm-toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px; }
      .gm-chip { display:inline-block; padding:2px 7px; margin:2px 4px 2px 0; border-radius:999px; font-size:12px; background:rgba(127,127,127,.12); }
      .gm-memory { margin:10px 0; padding:12px; border:1px solid var(--border-color, rgba(128,128,128,.2)); border-radius:10px; }
      .gm-memory-content { white-space:pre-wrap; line-height:1.55; }
      .gm-memory-meta { margin-top:7px; font-size:12px; opacity:.65; }
      .gm-section { margin:16px 0; }
      .gm-section h3 { margin:0 0 8px; }
      .gm-note { padding:10px 12px; margin:0 0 12px; border-radius:8px; background:rgba(127,127,127,.08); font-size:13px; line-height:1.5; }
      .gm-empty { padding:24px 14px; opacity:.6; }
      .gm-status { font-size:12px; opacity:.75; }
    `;
    document.head.appendChild(style);
  }

  function ensureView() {
    const view = document.getElementById('view-memory');
    if (!view) return null;
    ensureStyle();
    view.dataset.globalMemory = '1';

    let list = document.getElementById('global-memory-list');
    let detail = document.getElementById('global-memory-detail');
    if (!list) {
      list = document.createElement('aside');
      list.id = 'global-memory-list';
      list.className = 'list-pane';
      list.innerHTML = `
        <div class="gm-head">
          <strong>全局人物记忆</strong>
          <button class="btn btn-small" type="button" id="gm-refresh">刷新</button>
        </div>
        <div id="global-memory-items"></div>`;
      view.appendChild(list);
      list.querySelector('#gm-refresh')?.addEventListener('click', () => loadGlobalMemory(true));
    }
    if (!detail) {
      detail = document.createElement('div');
      detail.id = 'global-memory-detail';
      detail.className = 'detail-pane';
      detail.innerHTML = '<div class="empty-hint">← 选择人物查看全局记忆</div>';
      view.appendChild(detail);
    }
    return { view, list, detail };
  }

  async function mapLimit(items, limit, worker) {
    const output = new Array(items.length);
    let cursor = 0;
    async function run() {
      while (cursor < items.length) {
        const index = cursor++;
        try { output[index] = await worker(items[index], index); }
        catch { output[index] = null; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return output;
  }

  function mergePerson(target, incoming) {
    if (!target) return structuredClone(incoming);
    const merged = { ...target };
    merged.name = incoming.name || merged.name;
    merged.updatedAt = Math.max(Number(merged.updatedAt) || 0, Number(incoming.updatedAt) || 0);
    merged.lastConsolidatedAt = Math.max(
      Number(merged.lastConsolidatedAt) || 0,
      Number(incoming.lastConsolidatedAt) || 0
    );
    merged.sourceChatKeys = [...new Set([
      ...(merged.sourceChatKeys || []),
      ...(incoming.sourceChatKeys || [])
    ].map(String).filter(Boolean))];

    const memoryMap = new Map();
    for (const item of [...(merged.impressions || []), ...(incoming.impressions || [])]) {
      const content = String(item?.content || '').trim();
      if (!content) continue;
      const old = memoryMap.get(content);
      if (!old) {
        memoryMap.set(content, structuredClone(item));
        continue;
      }
      old.createdAt = Math.min(Number(old.createdAt) || Infinity, Number(item.createdAt) || Infinity);
      if (!Number.isFinite(old.createdAt)) old.createdAt = 0;
      old.lastObservedAt = Math.max(Number(old.lastObservedAt) || 0, Number(item.lastObservedAt) || 0);
      old.sourceChatKeys = [...new Set([
        ...(old.sourceChatKeys || []),
        ...(item.sourceChatKeys || [])
      ].map(String).filter(Boolean))];
    }
    merged.impressions = [...memoryMap.values()].sort((a, b) =>
      (Number(b.lastObservedAt) || Number(b.createdAt) || 0)
      - (Number(a.lastObservedAt) || Number(a.createdAt) || 0));
    return merged;
  }

  async function fetchPeople() {
    const summary = await api('/api/memory-files');
    const files = Array.isArray(summary.files) ? summary.files : [];
    const activeFiles = files.filter((file) => Number(file.impressionCount) > 0);
    const details = await mapLimit(activeFiles, 6, async (file) => {
      const path = String(file.chatKey || '').replace(':', '_');
      if (!/^(group|private)_\d+$/.test(path)) return null;
      return api(`/api/memory-files/${path}`);
    });

    const map = new Map();
    for (const detail of details) {
      for (const member of Array.isArray(detail?.members) ? detail.members : []) {
        const key = String(member.userId || '').trim() || `name:${String(member.name || '')}`;
        if (!key || key === 'name:') continue;
        map.set(key, mergePerson(map.get(key), member));
      }
    }
    return [...map.entries()].map(([key, member]) => ({ key, ...member }))
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  }

  function renderList() {
    const box = document.getElementById('global-memory-items');
    if (!box) return;
    if (!people.length) {
      box.innerHTML = '<div class="gm-empty">还没有人物长期记忆</div>';
      return;
    }
    box.innerHTML = people.map((person) => {
      const sources = person.sourceChatKeys || [];
      const title = person.name || person.userId || '未知人物';
      const subtitle = person.userId
        ? `QQ ${person.userId} · ${sources.length} 个来源会话`
        : `${sources.length} 个来源会话`;
      return `<button type="button" class="gm-person ${person.key === selectedKey ? 'active' : ''}" data-gm-key="${esc(person.key)}">
        <div class="gm-person-title"><strong>${esc(title)}</strong><span class="gm-count">${(person.impressions || []).length} 条</span></div>
        <div class="gm-sub">${esc(subtitle)}</div>
      </button>`;
    }).join('');
    box.querySelectorAll('[data-gm-key]').forEach((button) => {
      button.addEventListener('click', () => {
        selectedKey = button.dataset.gmKey || '';
        renderList();
        renderDetail();
      });
    });
  }

  function sourceFor(person) {
    return (person?.sourceChatKeys || []).find((key) => /^(group|private):\d+$/.test(String(key))) || '';
  }

  async function consolidatePerson(person) {
    const chatKey = sourceFor(person);
    const userId = String(person?.userId || '').trim();
    if (!chatKey || !/^\d{1,15}$/.test(userId)) throw new Error('缺少可用于整理的来源会话或 QQ 号');
    await api('/api/memory-files/consolidate', {
      method: 'POST',
      body: JSON.stringify({ chatKey, userIds: [userId], force: true })
    });
  }

  async function deletePerson(person) {
    const chatKey = sourceFor(person);
    const userId = String(person?.userId || '').trim();
    if (!chatKey || !/^\d{1,15}$/.test(userId)) throw new Error('缺少可删除的来源会话或 QQ 号');
    const path = chatKey.replace(':', '_');
    await api(`/api/memory-files/${path}/members/${userId}`, { method: 'DELETE' });
  }

  function renderDetail() {
    const box = document.getElementById('global-memory-detail');
    if (!box) return;
    const person = people.find((item) => item.key === selectedKey);
    if (!person) {
      box.innerHTML = '<div class="empty-hint">← 选择人物查看全局记忆</div>';
      return;
    }

    const sourceHtml = (person.sourceChatKeys || []).length
      ? person.sourceChatKeys.map((key) => `<span class="gm-chip">${esc(key)}</span>`).join('')
      : '<span class="muted">无来源记录</span>';
    const memories = person.impressions || [];
    const memoryHtml = memories.length
      ? memories.map((item) => {
          const sources = (item.sourceChatKeys || []).map((key) => `<span class="gm-chip">${esc(key)}</span>`).join('');
          const at = Number(item.lastObservedAt) || Number(item.createdAt) || 0;
          return `<div class="gm-memory">
            <div class="gm-memory-content">${esc(item.content)}</div>
            <div class="gm-memory-meta">最近确认 ${esc(fmtTime(at))}</div>
            <div>${sources || '<span class="muted">无来源</span>'}</div>
          </div>`;
        }).join('')
      : '<div class="gm-empty">这个人目前没有长期印象</div>';
    const manageable = /^\d{1,15}$/.test(String(person.userId || '')) && Boolean(sourceFor(person));

    box.innerHTML = `
      <div class="detail-header">
        <h2>${esc(person.name || person.userId || '未知人物')}</h2>
        <div class="sub">${person.userId ? `QQ ${esc(person.userId)} · ` : ''}${memories.length} 条全局长期印象</div>
        <div class="gm-toolbar">
          <button class="btn btn-small" type="button" id="gm-consolidate" ${manageable ? '' : 'disabled'}>整理人物记忆</button>
          <button class="btn btn-small btn-danger" type="button" id="gm-delete" ${manageable ? '' : 'disabled'}>删除全部人物记忆</button>
          <span class="gm-status" id="gm-action-status"></span>
        </div>
      </div>
      <div class="gm-note">
        人物长期记忆现在按 QQ 全局统一；下面的来源只用于追溯证据，不再限制记忆在哪个群可见。<br>
        会话 handoff 仍然按 chatKey 隔离，不会把一个群正在讨论的工作状态带到另一个群。
      </div>
      <div class="gm-section"><h3>来源会话</h3><div>${sourceHtml}</div></div>
      <div class="gm-section"><h3>长期印象</h3>${memoryHtml}</div>`;

    const status = box.querySelector('#gm-action-status');
    box.querySelector('#gm-consolidate')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      if (status) status.textContent = '已提交整理任务…';
      try {
        await consolidatePerson(person);
        if (status) status.textContent = '整理中，完成后会自动刷新';
        setTimeout(() => loadGlobalMemory(true), 2500);
        setTimeout(() => loadGlobalMemory(true), 7000);
      } catch (error) {
        if (status) status.textContent = `整理失败：${error?.message || error}`;
        button.disabled = false;
      }
    });
    box.querySelector('#gm-delete')?.addEventListener('click', async (event) => {
      if (!window.confirm(`确定删除 ${person.name || person.userId} 的全部全局人物记忆？此操作不会删除聊天记录。`)) return;
      const button = event.currentTarget;
      button.disabled = true;
      if (status) status.textContent = '正在删除…';
      try {
        await deletePerson(person);
        selectedKey = '';
        await loadGlobalMemory(true);
      } catch (error) {
        if (status) status.textContent = `删除失败：${error?.message || error}`;
        button.disabled = false;
      }
    });
  }

  async function loadGlobalMemory(force = false) {
    const ui = ensureView();
    if (!ui) return;
    const seq = ++loadSeq;
    const items = document.getElementById('global-memory-items');
    if (force || !people.length) items.innerHTML = '<div class="gm-empty">正在读取全局人物记忆…</div>';
    try {
      const next = await fetchPeople();
      if (seq !== loadSeq) return;
      people = next;
      if (selectedKey && !people.some((item) => item.key === selectedKey)) selectedKey = '';
      renderList();
      renderDetail();
    } catch (error) {
      if (seq !== loadSeq) return;
      items.innerHTML = `<div class="gm-empty">加载失败：${esc(error?.message || error)}</div>`;
    }
  }

  function activateIfNeeded() {
    const view = document.getElementById('view-memory');
    if (!view?.classList.contains('active')) return;
    ensureView();
    loadGlobalMemory(false);
  }

  document.querySelector('[data-tab="memory"]')?.addEventListener('click', () => {
    // app.js 会先更新旧的按会话记忆视图；稍后切换为全局人物视图，两套逻辑互不抢 DOM。
    setTimeout(() => loadGlobalMemory(true), 80);
  });

  window.addEventListener('focus', activateIfNeeded);
  setInterval(() => {
    const view = document.getElementById('view-memory');
    if (view?.classList.contains('active')) loadGlobalMemory(false);
  }, 15000);
})();
