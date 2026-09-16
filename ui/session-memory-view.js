'use strict';

(function sessionMemoryView() {
  function ensureStyle() {
    if (document.getElementById('session-memory-style')) return;
    const style = document.createElement('style');
    style.id = 'session-memory-style';
    style.textContent = `
      #view-memory #mem-add-imp-btn,
      #view-memory #mem-consolidate-btn,
      #view-memory #mem-consolidate-status,
      #view-memory #mem-load-members-btn,
      #view-memory #mem-members,
      #view-memory #memory-detail > .collapsible:not(.memory-handoff) {
        display:none !important;
      }
      #view-memory .session-memory-note {
        padding:10px 12px;
        margin:0 0 12px;
        border-radius:8px;
        background:rgba(127,127,127,.08);
        font-size:13px;
        line-height:1.5;
      }
    `;
    document.head.appendChild(style);
  }

  function cleanList() {
    const head = document.querySelector('#memory-list .list-head');
    if (head && head.textContent !== '会话记忆') head.textContent = '会话记忆';

    const items = document.getElementById('memory-items');
    if (!items) return;
    items.querySelectorAll('.chat-item').forEach((row) => {
      const sub = row.querySelector('.chat-item-sub');
      if (!sub) return;
      const hasHandoff = sub.textContent.includes('有会话交接');
      const next = hasHandoff ? '有会话交接' : '暂无会话交接';
      if (sub.textContent !== next) sub.textContent = next;
    });
    const empty = items.querySelector('.list-head.muted');
    if (empty && /还没有任何记忆/.test(empty.textContent)) {
      empty.textContent = '还没有会话交接记录';
    }
  }

  function cleanDetail() {
    const detail = document.getElementById('memory-detail');
    if (!detail) return;

    const title = detail.querySelector('.detail-header h2');
    if (title && title.textContent.endsWith('的记忆')) {
      title.textContent = title.textContent.replace(/的记忆$/, '的会话记忆');
    }

    const sub = detail.querySelector('.detail-header .sub');
    if (sub) {
      const firstSpan = sub.querySelector('span');
      const text = '会话级 handoff / 工作状态（按 chatKey 隔离）';
      if (firstSpan && firstSpan.textContent !== text) firstSpan.textContent = text;
    }

    const memberButton = detail.querySelector('#mem-load-members-btn');
    const memberField = memberButton?.closest('.field');
    if (memberField) memberField.style.display = 'none';

    const handoff = detail.querySelector('.memory-handoff');
    const header = detail.querySelector('.detail-header');
    if (header && handoff && !detail.querySelector('.session-memory-note')) {
      const note = document.createElement('div');
      note.className = 'session-memory-note';
      note.textContent = '人物长期记忆已独立到“人物记忆”页；本页只管理当前群聊/私聊自己的会话交接状态。';
      header.insertAdjacentElement('afterend', note);
    }

    const empty = detail.querySelector('.empty-hint');
    if (empty && /选择会话查看记忆/.test(empty.textContent)) {
      empty.textContent = '← 选择会话查看 handoff';
    }
  }

  function clean() {
    ensureStyle();
    cleanList();
    cleanDetail();
  }

  const view = document.getElementById('view-memory');
  if (!view) return;
  const observer = new MutationObserver(() => clean());
  observer.observe(view, { childList: true, subtree: true, characterData: true });

  document.querySelector('[data-tab="memory"]')?.addEventListener('click', () => {
    setTimeout(clean, 0);
  });

  clean();
})();
