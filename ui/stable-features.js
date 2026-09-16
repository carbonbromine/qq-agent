'use strict';

// Production feature UI invariants. app.js is intentionally kept backwards
// compatible with older consoles; this post-render layer removes only controls
// for capabilities that are no longer experimental/user-switchable.
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

  function prune() {
    // Keep the Experimental Features page itself: unrelated pilots (for example
    // multimodal/tool-scheduler/relationship experiments) still live there.
    // Only the four promoted/retired rows disappear.
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

    replaceText(document.querySelector('#identity-page'));
    replaceText(document.querySelector('#friend-page'));
    replaceText(document.querySelector('#incident-page'));
  }

  prune();
  const observer = new MutationObserver(() => prune());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
