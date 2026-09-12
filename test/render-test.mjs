// 实际执行 ui/app.js 的所有设置分区渲染函数，捕获运行时错误。
// 目的：像"B 未定义"这类错误，node --check（语法检查）根本查不出来，
// 只有真正跑一遍渲染才会暴露。
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'ui', 'app.js');
const code = fs.readFileSync(SRC, 'utf8');

// ── 极简 DOM 桩 ──
function makeEl(id = '', cls = '') {
  const el = {
    id,
    _cls: new Set(cls ? cls.split(' ') : []),
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    children: [],
    classList: null,
    addEventListener() {},
    removeEventListener() {},
    // 返回可用子元素而非 null —— 弹窗代码会拿它调 addEventListener。
    // ⚠️ 同一个 selector 必须返回**同一个**元素：updateUsagePage 用
    //    box.querySelector('[data-field="cost"]').textContent = v 填值，
    //    每次返回新元素的话，测试就永远读不到填进去的数值。
    querySelector: (sel) => { el._q ||= {} ; el._q[sel] ||= makeEl(); return el._q[sel]; },
    querySelectorAll: () => [],
    appendChild(c) { el.children.push(c); return c; },
    remove() {},
    closest: () => null,
    setAttribute() {},
    getAttribute: () => null,
    focus() {},
    scrollIntoView() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 20 }),
    insertAdjacentHTML() {},
    contains: () => false,
    scrollTop: 0, scrollHeight: 100, clientHeight: 50
  };
  el.classList = {
    add: (c) => el._cls.add(c),
    remove: (c) => el._cls.delete(c),
    toggle: (c, on) => { if (on) el._cls.add(c); else el._cls.delete(c); },
    contains: (c) => el._cls.has(c)
  };
  return el;
}

const store = new Map();
const document = {
  documentElement: makeEl('html'),
  body: makeEl('body'),
  head: makeEl('head'),
  querySelector: (sel) => {
    if (!store.has(sel)) store.set(sel, makeEl(String(sel).replace(/^#/, '')));
    return store.get(sel);
  },
  querySelectorAll: () => [],
  getElementById: (id) => document.querySelector('#' + id),
  createElement: (tag) => makeEl('', ''),
  addEventListener() {},
  removeEventListener() {}
};

// SSE 处理器注册表：桩捕获 connectSSE 绑定的监听，测试可直接派发合成事件
const sseRegistry = {};
const sandbox = {
  document,
  window: null,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { href: 'http://127.0.0.1/', protocol: 'http:', host: '127.0.0.1' },
  fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
  EventSource: function () {
    this.addEventListener = (type, fn) => { (sseRegistry[type] ||= []).push(fn); };
    this.close = () => {};
  },
  setTimeout, clearTimeout, setInterval, clearInterval,
  console,
  alert: () => {},
  confirm: () => true,
  prompt: () => null,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  URL, Blob: function () {}, FileReader: function () {},
  Intl, Math, JSON, Date, Number, String, Object, Array, Map, Set, Boolean, RegExp, Error,
  isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  structuredClone: (x) => JSON.parse(JSON.stringify(x))
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

let pass = 0, fail = 0;
const results = [];

try {
  const ctx = vm.createContext(sandbox);
  // 用 Script 执行（app.js 是普通脚本，非 module）
  new vm.Script(code, { filename: SRC }).runInContext(ctx);

  // 取出渲染函数并执行
  const sections = [
    'renderSettingsSection', 'renderApiSection', 'renderSearchSection',
    'renderMemorySettingsSection', 'renderExperimentalSettingsSection',
    'renderDailyMomentsSection',
    'renderQzoneInteractionSection', 'renderTimeControlSection',
    'renderPersonaSection', 'renderAllowSection',
    'renderChatSection', 'renderDesktopSection', 'renderOnebotSection',
    'renderPersonaPicker', 'renderHealthCard'
  ];

  // 直接用后端的 DEFAULT_CONFIG 做桩 —— 不要手敲字段名，
  // 手敲容易猜错层级（我刚把 minGapMs 放错层，误报了一个不存在的问题）。
  const { DEFAULT_CONFIG } = await import('../src/config.js');
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  // 再叠加上本轮关心的档位字段（默认值里没有 contextSliderPos）
  cfg.store = {
    ...(cfg.store || {}),
    contextTier: 3, contextSliderPos: 55,
    atCount: 5, keywordCount: 10, keywords: ['大肥鱼'],
    randomPercent: 50, randomCount: 20, allCount: 80
  };


  console.log('=== 实际执行各设置分区渲染函数 ===\n');
  for (const name of sections) {
    const fn = ctx[name] || sandbox[name];
    if (typeof fn !== 'function') {
      console.log('  SKIP  ' + name + '（非函数或未导出）');
      continue;
    }
    try {
      const out = fn(cfg);
      const ok = typeof out === 'string' && out.length > 0;
      if (ok) { pass++; console.log('  OK    ' + name + '  (' + out.length + ' 字符)'); }
      else { fail++; console.log('  FAIL  ' + name + ' 返回非字符串'); }
    } catch (e) {
      fail++;
      console.log('  FAIL  ' + name + ' 抛错: ' + (e && e.message));
      results.push({ name, err: e && e.message });
    }
  }
  const desktopHtml = ctx.renderDesktopSection(cfg);
  const apiHtml = ctx.renderApiSection(cfg);
  if (apiHtml.includes('id="cfg-max-run-tokens"')
      && apiHtml.includes('value="160000"')
      && apiHtml.includes('id="cfg-context-window-tokens"')
      && apiHtml.includes('value="1000000"')) {
    pass++;
    console.log('  OK    运行预算与模型上下文窗口控件完整');
  } else {
    fail++;
    console.log('  FAIL  运行预算或模型上下文窗口控件缺失');
  }
  const tokenControls = [
    'cfg-console-token-current', 'cfg-console-token-new',
    'cfg-console-token-confirm', 'change-console-token-btn'
  ].every((id) => desktopHtml.includes(`id="${id}"`));
  if (tokenControls && !desktopHtml.includes('value="console-test-secret"')) {
    pass++;
    console.log('  OK    控制台 Token 更新控件完整且不回显密钥');
  } else {
    fail++;
    console.log('  FAIL  控制台 Token 更新控件缺失或回显了密钥');
  }
  const onebotHtml = ctx.renderOnebotSection({
    ...cfg,
    onebot: { ...cfg.onebot, accessToken: 'onebot-secret', httpAccessToken: 'onebot-http-secret',
      hasAccessToken: true, hasHttpAccessToken: true }
  });
  if (onebotHtml.includes('cfg-obtoken') && onebotHtml.includes('留空保持不变')
      && !onebotHtml.includes('onebot-secret') && !onebotHtml.includes('onebot-http-secret')) {
    pass++;
    console.log('  OK    OneBot Token 留空保持且不回显密钥');
  } else {
    fail++;
    console.log('  FAIL  OneBot Token 控件会丢失或回显密钥');
  }
  const momentsHtml = ctx.renderDailyMomentsSection(cfg);
  const momentControls = [
    'cfg-moments-enabled', 'cfg-moments-catchup',
    'cfg-moments-hour', 'cfg-moments-minute', 'cfg-moments-visibility',
    'cfg-moments-min-messages', 'cfg-moments-max-groups',
    'cfg-moments-max-messages', 'cfg-moments-images',
    'cfg-moments-max-images', 'cfg-moments-research', 'cfg-moments-rounds',
    'daily-moments-preview-btn', 'daily-moments-run-btn', 'daily-moments-status'
  ].every((id) => momentsHtml.includes(`id="${id}"`));
  if (momentControls) {
    pass++;
    console.log('  OK    每日动态调度、研究、配图和手动执行控件完整');
  } else {
    fail++;
    console.log('  FAIL  每日动态设置控件缺失');
  }
  const interactionsHtml = ctx.renderQzoneInteractionSection(cfg);
  const interactionControls = [
    'cfg-qzi-enabled', 'cfg-qzi-catchup',
    'cfg-qzi-feed-interval', 'cfg-qzi-reply-interval', 'cfg-qzi-max-age',
    'cfg-qzi-feed-count', 'cfg-qzi-own-count', 'cfg-qzi-batch-items',
    'cfg-qzi-likes', 'cfg-qzi-comments', 'cfg-qzi-replies',
    'cfg-qzi-max-likes', 'cfg-qzi-max-comments', 'cfg-qzi-max-replies',
    'qzi-run-feed-btn', 'qzi-run-reply-btn', 'qzone-interactions-status'
  ].every((id) => interactionsHtml.includes(`id="${id}"`));
  if (interactionControls && !/id="cfg-qzi-enabled" checked/.test(interactionsHtml)) {
    pass++;
    console.log('  OK    动态互动默认关闭，调度、限额和手动执行控件完整');
  } else {
    fail++;
    console.log('  FAIL  动态互动设置控件缺失或默认状态错误');
  }
  const experimentalHtml = ctx.renderExperimentalSettingsSection(cfg);
  const experimentalOnHtml = ctx.renderExperimentalSettingsSection({
    ...cfg,
    identityPilot: { enabled: true }
  });
  if (
    experimentalHtml.includes('id="cfg-identity-pilot-enabled"')
    && experimentalHtml.includes('已关闭 · 当前系统行为不变')
    && !/id="cfg-identity-pilot-enabled" checked/.test(experimentalHtml)
    && /id="cfg-identity-pilot-enabled" checked/.test(experimentalOnHtml)
    && experimentalOnHtml.includes('总开关已开启（阶段 1）')
  ) {
    pass++;
    console.log('  OK    人物画像实验总开关默认关闭并可展示开启状态');
  } else {
    fail++;
    console.log('  FAIL  人物画像实验总开关缺失或默认状态错误');
  }
  const pilotPatchFn = ctx.identityPilotSettingsPatch || sandbox.identityPilotSettingsPatch;
  const pilotOnPatch = pilotPatchFn(cfg, true);
  const pilotOffPatch = pilotPatchFn({ ...cfg, identityPilot: { enabled: true } }, false);
  if (
    pilotOnPatch.enabled === true
    && pilotOffPatch.enabled === false
    && Object.keys(pilotOnPatch).length === 1
    && Object.keys(pilotOffPatch).length === 1
  ) {
    pass++;
    console.log('  OK    实验总开关独立生成最小配置补丁');
  } else {
    fail++;
    console.log('  FAIL  实验总开关保存补丁不正确');
  }
  const timeHtml = ctx.renderTimeControlSection({
    ...cfg, allow: { groups: ['123'], private: ['456'] }
  });
  if (['tc-enabled', 'tc-target', 'tc-mode', 'tc-live-state'].every((id) =>
    timeHtml.includes(`id="${id}"`)) && timeHtml.includes('group:123')
    && timeHtml.includes('private:456') && timeHtml.includes('DS 低峰时段')
    && !/id="tc-enabled" checked/.test(timeHtml)) {
    pass++;
    console.log('  OK    时间控制默认关闭，支持群聊及私聊规则');
  } else {
    fail++;
    console.log('  FAIL  时间控制设置不完整');
  }
  const customTimeHtml = ctx.renderTimeControlSection({
    ...cfg,
    timeControl: {
      enabled: true,
      schedule: { mode: 'custom', windows: [{ days: [1, 7], start: '22:00', end: '06:00' }] },
      overrides: {}
    }
  });
  if (customTimeHtml.includes('value="22:00"') && customTimeHtml.includes('value="06:00"')
    && customTimeHtml.includes('data-day="7" checked')
    && customTimeHtml.includes('aria-label="删除时间段"')
    && customTimeHtml.includes('id="tc-add"')) {
    pass++;
    console.log('  OK    自定义时段、星期与增删控件完整');
  } else {
    fail++;
    console.log('  FAIL  自定义时间段控件缺失');
  }
  const conversationHtml = ctx.renderChatSection({
    ...cfg,
    allow: { ...cfg.allow, groups: ['123'] },
    conversation: {
      ...cfg.conversation,
      mode: 'lifecycle',
      unifiedMode: false,
      groupModes: { 123: 'threaded' }
    }
  });
  const conversationControls = [
    'cfg-conversation-mode', 'cfg-conversation-unified',
    'conversation-group-select', 'conversation-group-mode',
    'cfg-cont-window', 'cfg-thread-ttl', 'cfg-cont-history',
    'cfg-life-silent', 'cfg-life-active', 'cfg-life-hard',
    'cfg-life-rollover', 'cfg-life-history', 'cfg-life-tokens', 'cfg-life-chars',
    'cfg-wakedelay-min', 'cfg-wakedelay-max'
  ].every((id) => conversationHtml.includes(`id="${id}"`));
  if (conversationControls
      && conversationHtml.includes('id="cfg-conversation-mode" value="lifecycle"')
      && conversationHtml.includes('id="cfg-life-tokens"')
      && conversationHtml.includes('value="32000"')
      && ['legacy', 'threaded', 'lifecycle'].every((mode) =>
        conversationHtml.includes(`data-conversation-mode="${mode}"`)
        && conversationHtml.includes(`data-conversation-panel="${mode}"`))) {
    pass++;
    console.log('  OK    三种对话模式及分群覆盖控件完整');
  } else {
    fail++;
    console.log('  FAIL  三种对话模式或分群覆盖控件缺失');
  }
  const modePanel = (html, mode) => {
    const match = html.match(new RegExp(
      `<section class="conversation-mode-panel([^"]*)"[^>]*data-conversation-panel="${mode}"[^>]*>([\\s\\S]*?)<\\/section>`
    ));
    return match ? { classes: match[1], html: match[2] } : null;
  };
  const modeViews = Object.fromEntries(['legacy', 'threaded', 'lifecycle'].map((mode) => {
    const html = ctx.renderChatSection({
      ...cfg,
      conversation: { ...cfg.conversation, mode }
    });
    return [mode, {
      legacy: modePanel(html, 'legacy'),
      threaded: modePanel(html, 'threaded'),
      lifecycle: modePanel(html, 'lifecycle')
    }];
  }));
  const isolatedModePanels =
    !modeViews.legacy.legacy.classes.includes('hidden')
    && modeViews.legacy.threaded.classes.includes('hidden')
    && modeViews.legacy.lifecycle.classes.includes('hidden')
    && !modeViews.threaded.threaded.classes.includes('hidden')
    && modeViews.threaded.threaded.html.includes('cfg-cont-window')
    && !modeViews.threaded.threaded.html.includes('cfg-life-silent')
    && !modeViews.lifecycle.lifecycle.classes.includes('hidden')
    && modeViews.lifecycle.lifecycle.html.includes('cfg-life-silent')
    && !modeViews.lifecycle.lifecycle.html.includes('cfg-cont-window');
  if (isolatedModePanels) {
    pass++;
    console.log('  OK    模式切换仅显示当前模式的专属参数');
  } else {
    fail++;
    console.log('  FAIL  不同模式的参数仍混在同一可见面板');
  }
  const statusText = ctx.sessionStatusText || sandbox.sessionStatusText;
  const conversationText = ctx.conversationStatusText || sandbox.conversationStatusText;
  const modeBand = ctx.renderSessionModeBand || sandbox.renderSessionModeBand;
  const lifecycleSession = {
    status: 'done',
    conversationMode: 'lifecycle',
    threadState: 'listening',
    threadId: '12345678-abcd'
  };
  if (
    statusText(lifecycleSession) === '本轮已发言'
    && conversationText(lifecycleSession) === '完整生命周期 · 监听中'
    && statusText({ status: 'done', conversationMode: 'legacy' }) === '已发言'
    && modeBand(lifecycleSession).includes('session-mode-band mode-lifecycle')
    && modeBand(lifecycleSession).includes('线程 12345678')
  ) {
    pass++;
    console.log('  OK    Session 结束与各模式运行态 UI 已明确区分');
  } else {
    fail++;
    console.log('  FAIL  Session 模式状态仍未清晰区分');
  }
  const groupSessions = ctx.buildSessionDisplayItems || sandbox.buildSessionDisplayItems;
  const threadTimeline = ctx.renderSessionThreadTimeline || sandbox.renderSessionThreadTimeline;
  const groupedRuns = [
    {
      id: 'life-wait', chatKey: 'group:1', startedAt: 3, status: 'waiting',
      conversationMode: 'lifecycle', threadId: 'thread-1', threadState: 'active',
      trigger: '等待第三批', rounds: 0, webSearchCount: 0, waitUntil: Date.now() + 5000,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 }
    },
    {
      id: 'life-2', chatKey: 'group:1', startedAt: 2, status: 'done',
      conversationMode: 'lifecycle', threadId: 'thread-1', threadState: 'listening',
      trigger: '第二批', rounds: 2, webSearchCount: 1,
      usage: { promptTokens: 20, completionTokens: 2, totalTokens: 22, cachedTokens: 15, calls: 2 }
    },
    {
      id: 'life-1', chatKey: 'group:1', startedAt: 1, status: 'done',
      conversationMode: 'lifecycle', threadId: 'thread-1', threadState: 'active',
      trigger: '第一批', rounds: 1, webSearchCount: 0,
      usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11, cachedTokens: 0, calls: 1 }
    },
    {
      id: 'legacy-1', chatKey: 'group:2', startedAt: 1, status: 'done',
      conversationMode: 'legacy', threadId: null, rounds: 1,
      usage: { totalTokens: 5, calls: 1 }
    }
  ];
  const groupedView = groupSessions(groupedRuns);
  vm.runInContext(`state.sessions = ${JSON.stringify(groupedRuns)};`, ctx);
  const timelineHtml = threadTimeline(groupedRuns[0]);
  const lifecycleGroup = groupedView.find((item) => item.threadId === 'thread-1');
  if (
    groupedView.length === 2
    && lifecycleGroup?.runCount === 3
    && lifecycleGroup?.usage?.totalTokens === 33
    && lifecycleGroup?.latestSessionId === 'life-wait'
    && (timelineHtml.match(/data-thread-session-id=/g) || []).length === 3
    && timelineHtml.includes('3 批 · 3 次调用')
  ) {
    pass++;
    console.log('  OK    生命周期 Session 按 threadId 聚合并保留批次时间线');
  } else {
    fail++;
    console.log('  FAIL  生命周期 Session 聚合或时间线不完整');
  }
  vm.runInContext('state.sessions = [];', ctx);
  const contextInspector = ctx.renderSessionContextInspector || sandbox.renderSessionContextInspector;
  const contextSession = {
    id: 'context-test',
    status: 'done',
    model: 'deepseek-reasoner',
    promptLayout: 'deepseek-lifecycle-append-v1',
    threadId: 'thread-1',
    inputRound: 2,
    inputPayloadChars: 4096,
    injectedMessages: [{ role: 'assistant', content: '上一轮回复' }],
    inputMessages: [
      { role: 'system', content: '系统提示' },
      { role: 'assistant', content: '上一轮回复', reasoning_content: '上一轮推理' },
      { role: 'user', content: '本轮输入' }
    ],
    inputTools: [{ type: 'function', function: { name: 'finish' } }],
    inputRequestOptions: { toolChoice: 'auto', temperature: 0.8 },
    usage: {
      promptTokens: 2400,
      completionTokens: 180,
      totalTokens: 2580,
      cachedTokens: 1800,
      calls: 2
    },
    webSearchCount: 2,
    sessionMetrics: { estimatedCost: 0.0123 },
    callUsage: [
      { round: 1, promptTokens: 1000, cachedTokens: 700, completionTokens: 100, totalTokens: 1100 },
      { round: 2, promptTokens: 1400, cachedTokens: 1100, completionTokens: 80, totalTokens: 1480 }
    ],
    messages: [
      { role: 'assistant', content: null, reasoning_content: '检查上下文后调用工具' },
      { toolCall: { name: 'finish', args: {}, result: 'ok' } },
      { role: 'assistant', content: 'done', reasoning_content: '任务已完成' }
    ]
  };
  vm.runInContext("state.sessionInspectorTab = 'input';", ctx);
  const inputInspector = contextInspector(contextSession);
  vm.runInContext("state.sessionInspectorTab = 'injected';", ctx);
  const injectedInspector = contextInspector(contextSession);
  vm.runInContext("state.sessionInspectorTab = 'reasoning';", ctx);
  const reasoningInspector = contextInspector(contextSession);
  const contextMetrics = (ctx.sessionMetricsOf || sandbox.sessionMetricsOf)(contextSession);
  const contextInspectorOk =
    contextMetrics.firstCallCacheHitRate === 0.7
    && contextMetrics.cacheHitRate === 0.75
    && contextMetrics.promptTokens === 2400
    && contextMetrics.completionTokens === 180
    && contextMetrics.cachedTokens === 1800
    && contextMetrics.toolCalls === 1
    && contextMetrics.webSearchCount === 2
    && contextMetrics.estimatedCost === 0.0123
    && inputInspector.includes('完整输入 · 3')
    && inputInspector.includes('Session 全局统计 · 2 次模型调用')
    && inputInspector.includes('首轮缓存命中率')
    && inputInspector.includes('70.0%')
    && inputInspector.includes('总缓存命中率')
    && inputInspector.includes('75.0%')
    && inputInspector.includes('总输出 Token')
    && inputInspector.includes('180')
    && inputInspector.includes('总输入 Token')
    && inputInspector.includes('2,400')
    && inputInspector.includes('总缓存 Token')
    && inputInspector.includes('1,800')
    && inputInspector.includes('总工具次数')
    && inputInspector.includes('总联网次数')
    && inputInspector.includes('预估成本')
    && inputInspector.includes('¥0.0123')
    && inputInspector.includes('当前展示第 2 轮请求快照')
    && inputInspector.includes('第 1 轮')
    && inputInspector.includes('第 2 轮')
    && inputInspector.includes('1,400')
    && inputInspector.includes('1,100')
    && inputInspector.includes('&quot;tools&quot;')
    && injectedInspector.includes('上一轮回复')
    && reasoningInspector.includes('检查上下文后调用工具')
    && reasoningInspector.includes('任务已完成');
  if (contextInspectorOk) {
    pass++;
    console.log('  OK    注入对话、完整输入、Token 与模型推理检查器完整');
  } else {
    fail++;
    console.log('  FAIL  模型上下文检查器缺失关键数据');
  }

  // 滑条换算函数
  console.log('\n=== 滑条换算（UI 侧）===');
  for (const fnName of ['sliderToTierUI', 'sliderToTierUI_tierToSlider', 'sliderDesc']) {
    const fn = ctx[fnName] || sandbox[fnName];
    if (typeof fn !== 'function') { fail++; console.log('  FAIL  ' + fnName + ' 未定义'); continue; }
    try {
      if (fnName === 'sliderToTierUI') {
        const r = fn(55);
        const ok = r.tier === 3 && Math.abs(r.randomPercent - 50) < 0.6;
        ok ? pass++ : fail++;
        console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + ' sliderToTierUI(55) → 档' + r.tier + '/' + r.randomPercent + '%');
      } else if (fnName === 'sliderToTierUI_tierToSlider') {
        const r = fn({ contextSliderPos: 55 });
        const ok = r === 55;
        ok ? pass++ : fail++;
        console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + ' sliderToTierUI_tierToSlider() → ' + r);
      } else {
        const r = fn(55);
        const ok = typeof r === 'string' && r.includes('3 档');
        ok ? pass++ : fail++;
        console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + ' sliderDesc(55) → ' + String(r).slice(0, 46));
      }
    } catch (e) {
      fail++;
      console.log('  FAIL  ' + fnName + ' 抛错: ' + (e && e.message));
    }
  }

  // 各滑条位置都渲染一次（覆盖全区间）
  console.log('\n=== 各滑条位置渲染聊天设置 ===');
  for (const pos of [0, 5, 10, 15, 20, 30, 55, 75, 90, 95, 100]) {
    try {
      const out = (ctx.renderChatSection || sandbox.renderChatSection)({
        ...cfg, store: { ...cfg.store, contextSliderPos: pos }
      });
      const ok = typeof out === 'string' && out.length > 0;
      ok ? pass++ : fail++;
      console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + ' 位置 ' + String(pos).padStart(3) + '% → ' + out.length + ' 字符');
    } catch (e) {
      fail++;
      console.log('  FAIL  位置 ' + pos + '% 抛错: ' + (e && e.message));
    }
  }

    // ── 刻度段高亮：滑到哪一档，对应标签 + 上边线一起变色 ──
    console.log('\n=== 刻度段高亮（拖动联动）===');
    /** 从渲染出的 HTML 里找出带 .on 的刻度段编号 */
    const activeSegs = (html) => {
      const out = [];
      const re = /class="tier-seg seg(\d)([^"]*)"/g;
      let m;
      while ((m = re.exec(html))) { if (/\bon\b/.test(m[2])) out.push(Number(m[1])); }
      return out;
    };
    const renderAt = (pos) => (ctx.renderChatSection || sandbox.renderChatSection)({
      ...JSON.parse(JSON.stringify(cfg)),
      store: { ...cfg.store, contextSliderPos: pos }
    });

    for (const [pos, want, desc] of [
      [0, 1, '最左端'], [5, 1, '1档中段'], [10, 1, '1档右界'],
      [15, 2, '2档'], [20, 2, '2档右界'],
      [30, 3, '3档靠左'], [55, 3, '3档正中(50%)'], [75, 3, '3档靠右'], [90, 3, '3档右界'],
      [95, 4, '4档'], [100, 4, '最右端']
    ]) {
      try {
        const on = activeSegs(renderAt(pos));
        const ok = on.length === 1 && on[0] === want;
        ok ? pass++ : fail++;
        console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + String(pos).padStart(3) + '% (' + desc + ') → 高亮第 ' + want + ' 段'
          + (ok ? '' : '  实际 [' + on.join(',') + ']'));
      } catch (e) { fail++; console.log('  FAIL ' + pos + '% 抛错: ' + (e && e.message)); }
    }

    // 任何时候只亮一段
    for (const pos of [0, 10, 15, 20, 55, 90, 95, 100]) {
      const on = activeSegs(renderAt(pos));
      const ok = on.length === 1;
      ok ? pass++ : fail++;
      console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + String(pos).padStart(3) + '% 只亮 1 段' + (ok ? '' : '  实际 ' + on.length + ' 段'));
    }

    // 四段都有机会被点亮
    const lit = new Set();
    for (let p = 0; p <= 100; p += 0.5) for (const n of activeSegs(renderAt(p))) lit.add(n);
    {
      const ok = lit.size === 4;
      ok ? pass++ : fail++;
      console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '四段都能被点亮' + (ok ? '' : '  实际 [' + [...lit].sort().join(',') + ']'));
    }

    // 刻度与参数区一致（亮哪段就亮哪个参数块）
    // 注意正则要带边界：容器是 tier-params（复数），不能被当前缀匹配进来
    for (const [pos, want] of [[5, 1], [15, 2], [55, 3], [95, 4]]) {
      const html = renderAt(pos);
      const on = activeSegs(html);
      const params = [...html.matchAll(/class="tier-param(?!s)([^"]*)"/g)].map((m, i) => ({
        idx: i + 1, dim: /\bdim\b/.test(m[1])
      }));
      const bright = params.filter((x) => !x.dim).map((x) => x.idx);
      const ok = on[0] === want && bright.length === 1 && bright[0] === want;
      ok ? pass++ : fail++;
      console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + pos + '% 刻度第' + on[0] + '段 / 参数第' + bright.join(',') + '块 一致'
        + (ok ? '' : '  （期望均为 ' + want + '）'));
    }


    // ── 调用明细弹窗（点「调用次数」卡片打开）──
    console.log('\n=== 调用明细弹窗 ===');
    const openBreakdown = ctx.openToolBreakdown || sandbox.openToolBreakdown;
    if (typeof openBreakdown !== 'function') {
      fail++; console.log('  FAIL openToolBreakdown 未定义');
    } else {
      const fakeStats = {
        rangeLabel: '近 7 天',
        searchCount: 46,
        toolCounts: {
          send_message: 133, finish: 149, send_sticker: 7, send_poke: 6,
          get_recent_messages: 3, get_message_images: 70, get_message_detail: 7,
          list_stickers: 4, collect_sticker: 2,
          memory_append: 2, memory_remove: 2,
          web_search: 39, web_fetch: 7,
          some_unknown_tool: 5
        }
      };
      let captured = '';
      const realShell = ctx.modelModalShell || sandbox.modelModalShell;
      // 拦截弹窗外壳，拿到它渲染的 body
      ctx.modelModalShell = sandbox.modelModalShell = (opt) => { captured = String(opt.body || ''); return makeEl(); };

      try {
        vm.runInContext('state.usageStats = ' + JSON.stringify(fakeStats) + ';', ctx);
        openBreakdown();
        const ok = captured.length > 0
          && captured.includes('tool-breakdown')
          && captured.includes('send_message')
          && captured.includes('联网搜索')
          && captured.includes('some_unknown_tool');
        ok ? pass++ : fail++;
        console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '弹窗渲染（含未知工具兜底）  ' + captured.length + ' 字符');
        const catsOk = ['发言', '查看', '表情', '记忆', '联网', '其他'].every((c) => captured.includes(c));
        catsOk ? pass++ : fail++;
        console.log('  ' + (catsOk ? 'OK   ' : 'FAIL ') + '六个分类齐全');
        const leadOk = captured.includes('发了 133 条消息') && captured.includes('联网查了 46 次');
        leadOk ? pass++ : fail++;
        console.log('  ' + (leadOk ? 'OK   ' : 'FAIL ') + '一句话小结正确');
      } catch (e) {
        fail++; console.log('  FAIL 弹窗抛错: ' + (e && e.message));
      }

      try {
        captured = '';
        vm.runInContext("state.usageStats = { rangeLabel: '今天', searchCount: 0, toolCounts: {} };", ctx);
        openBreakdown();
        const ok = captured.includes('还没有任何工具调用记录');
        ok ? pass++ : fail++;
        console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '空数据给出友好提示');
      } catch (e) {
        fail++; console.log('  FAIL 空数据抛错: ' + (e && e.message));
      }

      if (realShell) ctx.modelModalShell = sandbox.modelModalShell = realShell;
    }


    // ── 用量页端到端：实际调用 loadUsageView 并验证页面真的有内容 ──
    // 补这个是因为：上一轮 loadUsageView 被误删，而现有测试**全是绿的** ——
    // 没有任何测试真正调用它，所以删了也没人发现。这是测试盲区。
    console.log('\n=== 用量页加载（loadUsageView）===');
    {
      const { DEFAULT_CONFIG: DC2 } = await import('../src/config.js');
      const loadUsage = ctx.loadUsageView || sandbox.loadUsageView;
      if (typeof loadUsage !== 'function') {
        fail++; console.log('  FAIL loadUsageView 未定义（用量页会一直空白）');
      } else {
        // 造一份统计返回
        const stats = {
          range: '7', rangeLabel: '近 7 天', mode: 'days',
          totals: {
            cost: 3.96, promptTokens: 120000, completionTokens: 34000,
            cachedTokens: 80000, totalTokens: 154000,
            cacheHitRate: 0.666, runs: 149, peakCost: 2, offPeakCost: 1.96
          },
          searchCount: 46,
          toolCounts: { send_message: 133, web_search: 39, finish: 149 },
          days: [{ key: '2026-09-04', runs: 20, promptTokens: 1000, completionTokens: 200, cachedTokens: 500, cacheHitRate: 0.5, cost: 0.5 }],
          chats: [{ key: 'group:1', runs: 10, promptTokens: 500, completionTokens: 100, cacheHitRate: 0.4, cost: 0.2 }],
          models: [{ key: 'deepseek:deepseek-chat', runs: 149, promptTokens: 120000, completionTokens: 34000, cacheHitRate: 0.666, cost: 3.96 }]
        };
        const statusData = { usage: { runs: 12 }, config: DC2 };
        const prices = { rows: [] };

        // ⚠️ mock 只覆盖**真实存在**的接口，其余一律 404。
        //    曾经这里把 /api/usage/prices 也 mock 成 200，而这个接口后端根本没有
        //    —— 结果测试全绿、线上用量页永远加载失败。
        //    所以未知路径必须返回 404，让"捏造的接口"在测试里就暴露。
        const realFetch = sandbox.fetch;
        const REAL_USAGE_APIS = ['/api/usage/stats', '/api/usage/breakdown', '/api/status'];
        sandbox.fetch = async (url) => {
          const u = String(url);
          const hit = REAL_USAGE_APIS.find((p) => u.includes(p));
          if (!hit) return { ok: false, status: 404, json: async () => ({ error: `未知 API：${u}` }) };
          const body = u.includes('/api/usage/stats') ? stats : statusData;
          return { ok: true, status: 200, json: async () => body };
        };

        const usageBox = document.getElementById('usage-page');
        try {
          vm.runInContext("state.tab = 'usage';", ctx);
          await loadUsage({ force: true });
          const html = String(usageBox.innerHTML || '');
          if (html.length < 500) console.log('    [调试] 实际内容: ' + JSON.stringify(html.slice(0, 300)));
          const ok = html.length > 500
            && html.includes('用量与成本')
            && html.includes('估算成本')
            && html.includes('搜索次数');
          ok ? pass++ : fail++;
          console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '加载后页面有内容  ' + html.length + ' 字符'
            + (ok ? '' : '  （缺关键区块）'));

          // 数值应被填入。注意 updateUsagePage 走的是 textContent（不是 innerHTML），
          // 所以要直接查那个字段元素，而不是查整段 HTML
          const costEl = usageBox.querySelector('[data-field="cost"]');
          const costTxt = String(costEl?.textContent || '');
          const runsEl = usageBox.querySelector('[data-field="runs"]');
          const runsTxt = String(runsEl?.textContent || '');
          const searchEl = usageBox.querySelector('[data-field="search"]');
          const searchTxt = String(searchEl?.textContent || '');
          const filled = costTxt.includes('3.96') && runsTxt === '149' && searchTxt === '46';
          filled ? pass++ : fail++;
          console.log('  ' + (filled ? 'OK   ' : 'FAIL ') + '数值已填充  成本=' + costTxt
            + ' 调用=' + runsTxt + ' 搜索=' + searchTxt);

          // 骨架屏应已被真实内容替换
          const noSkeleton = !/usage-card skeleton/.test(html);
          noSkeleton ? pass++ : fail++;
          console.log('  ' + (noSkeleton ? 'OK   ' : 'FAIL ') + '骨架屏已被替换（不是一直转圈）');

          // 非 force（轮询）路径：只更新数值，不重建
          usageBox.innerHTML = '<div id="keepme">KEEP</div>';
          await loadUsage();
          const kept = String(usageBox.innerHTML || '').includes('KEEP');
          kept ? pass++ : fail++;
          console.log('  ' + (kept ? 'OK   ' : 'FAIL ') + '轮询(force=false)不重建 DOM');

          // ★ 第二次进入：应直接用上次数据立即渲染，不显示骨架
          //   （后端统计冷启动约 200ms，缓存 TTL 只有 5s，每次都等就是"黑一下"）
          usageBox.innerHTML = '';
          let sawSkeleton = false;
          const origSkeleton = ctx.renderUsageSkeleton || sandbox.renderUsageSkeleton;
          ctx.renderUsageSkeleton = sandbox.renderUsageSkeleton = () => { sawSkeleton = true; return origSkeleton(); };
          await loadUsage({ force: true });
          ctx.renderUsageSkeleton = sandbox.renderUsageSkeleton = origSkeleton;
          const secondHtml = String(usageBox.innerHTML || '');
          const ok2 = !sawSkeleton && secondHtml.includes('估算成本');
          ok2 ? pass++ : fail++;
          console.log('  ' + (ok2 ? 'OK   ' : 'FAIL ') + '二次进入直接显示旧数据（不闪骨架）');

          // ★ 用量页请求的接口必须真实存在（不能在测试里 mock 掉 404）
          //   上一轮就是凭空捏造了 /api/usage/prices，测试绿、线上白屏。
          const { createApp: createApp2 } = await import('../src/app.js');
          const http = await import('node:http');
          const realApp = createApp2({ log: () => {} });
          const realPort = await realApp.start(40991);
          const hit = (p) => new Promise((r) => {
            http.request({ host: '127.0.0.1', port: realPort, path: p, method: 'GET',
              headers: { 'x-console-token': 'qq-agent-console' } },
              (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => r({ code: res.statusCode, d })); }
            ).on('error', () => r({ code: 0, d: '' })).end();
          });
          for (const p of ['/api/usage/stats?range=7', '/api/status']) {
            const r = await hit(p);
            const ok = r.code === 200;
            ok ? pass++ : fail++;
            console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + '真实接口可用 ' + p + ' → HTTP ' + r.code);
          }
          // 反向确认：不存在的接口确实返回 404（证明上面不是假阳性）
          const bad = await hit('/api/usage/prices');
          const badOk = bad.code === 404;
          badOk ? pass++ : fail++;
          console.log('  ' + (badOk ? 'OK   ' : 'FAIL ') + '不存在的接口确实 404（/api/usage/prices）');
          await realApp.stop();

          // 切到别的 range 时，旧数据不能冒用（range 对不上会显示错的区间）
          vm.runInContext("usageRange = 'today';", ctx);
          usageBox.innerHTML = '';
          let usedOld = false;
          const origPage = ctx.renderUsagePage || sandbox.renderUsagePage;
          ctx.renderUsagePage = sandbox.renderUsagePage = (...a) => { usedOld = true; return origPage(...a); };
          // 先清掉缓存，模拟"新 range 没有旧数据"
          vm.runInContext('usageLastData = null;', ctx);
          usageBox.innerHTML = '';
          await loadUsage({ force: true });
          ctx.renderUsagePage = sandbox.renderUsagePage = origPage;
          vm.runInContext("usageRange = '7';", ctx);
          const ok3 = usedOld;
          ok3 ? pass++ : fail++;
          console.log('  ' + (ok3 ? 'OK   ' : 'FAIL ') + '切换 range 会重新渲染（不误用旧区间数据）');
        } catch (e) {
          fail++; console.log('  FAIL 抛错: ' + (e && e.message));
        } finally {
          sandbox.fetch = realFetch;
        }
      }
    }

  // ── 会话详情 SSE 实时性（2026-09-05 回归）──
  // 曾经的三个洞：① SSE 载荷不带 sent →"已发送"徽标只能等手动刷新；
  // ② session-end 不重拉详情（轮询只刷 running/waiting，最终态再也不来）；
  // ③ 渲染合批用 rAF → 窗口被遮挡时完全停火，渲染全部积压。
  console.log('\n=== 会话详情 SSE 实时推送 ===');
  try {
    const detailBox = document.querySelector('#session-detail');
    vm.runInContext(`
      state.tab = 'sessions';
      state.currentSessionId = 's_sse_1';
      state.sessionDetail = { id: 's_sse_1', chatKey: 'group:1', status: 'running', startedAt: 1,
        messages: [], sent: [], usage: { calls: 0 }, rounds: 0 };
      state.sessions = [{ id: 's_sse_1', chatKey: 'group:1', status: 'running', startedAt: 1, messages: [], sent: [] }];
      state.chats = [];
      lastDetailFp = null;
    `, ctx);
    ctx.connectSSE();   // 把处理器注册进 sseRegistry（init 里那次可能还没执行到）
    const fireSse = (type, data) => { for (const fn of sseRegistry[type] || []) fn({ data: JSON.stringify(data) }); };
    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

    // ① session-update 携带 sent：合批（80ms）后详情必须实时出现工具卡片与"已发送"徽标
    fireSse('session-update', {
      sessionId: 's_sse_1', chatKey: 'group:1', status: 'running', activity: '',
      rounds: 1, usage: { calls: 1 },
      messages: [{ role: 'assistant', content: '让我想想' },
        { toolCall: { name: 'send_message', args: { messages: '实时你好' }, result: '已发送' } }],
      sent: [{ type: 'text', text: '实时你好', at: '12:00:00' }]
    });
    await sleepMs(250);
    const html1 = String(detailBox.innerHTML || '');
    const okTool = html1.includes('send_message');
    okTool ? pass++ : fail++;
    console.log('  ' + (okTool ? 'OK   ' : 'FAIL ') + '工具卡片实时出现（send_message）' + (okTool ? '' : ' -> ' + html1.slice(0, 100)));
    const okSent = html1.includes('实时你好');
    okSent ? pass++ : fail++;
    console.log('  ' + (okSent ? 'OK   ' : 'FAIL ') + '已发送徽标实时出现（不等轮询/手动刷新）' + (okSent ? '' : ' -> ' + html1.slice(0, 100)));

    // ② session-end：当前开着的会话必须自动重拉完整详情（最终 sent/finishReason）
    const finalSession = { id: 's_sse_1', chatKey: 'group:1', status: 'done', startedAt: 1, endedAt: 2,
      messages: [{ role: 'assistant', content: '让我想想' }],
      sent: [{ type: 'text', text: '最终发言', at: '12:00:01' }],
      usage: { calls: 1 }, rounds: 1, finishReason: 'stop' };
    const origFetch2 = sandbox.fetch;
    sandbox.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/sessions/s_sse_1')) return { ok: true, json: async () => finalSession };
      if (u.includes('/api/sessions')) return { ok: true, json: async () => ({ sessions: [finalSession] }) };
      return origFetch2(url);
    };
    fireSse('session-end', { sessionId: 's_sse_1', chatKey: 'group:1', status: 'done' });
    await sleepMs(400);
    sandbox.fetch = origFetch2;
    const html2 = String(detailBox.innerHTML || '');
    const okFinal = html2.includes('最终发言');
    okFinal ? pass++ : fail++;
    console.log('  ' + (okFinal ? 'OK   ' : 'FAIL ') + 'session-end 后详情自动刷出最终 sent（不用手动刷新）' + (okFinal ? '' : ' -> ' + html2.slice(0, 100)));

    // ③ 新 Session 只刷新列表，不能抢占用户当前正在阅读的详情。
    const incoming = { id: 's_sse_2', chatKey: 'group:2', status: 'waiting', startedAt: 3,
      messages: [], sent: [], usage: { calls: 0 }, rounds: 0 };
    sandbox.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/sessions')) {
        return { ok: true, json: async () => ({ sessions: [incoming, finalSession] }) };
      }
      if (u.includes('/api/status')) {
        return { ok: true, json: async () => ({ onebot: {}, orchestrator: {}, usage: {}, cost: {} }) };
      }
      return origFetch2(url);
    };
    fireSse('session-start', { sessionId: incoming.id, chatKey: incoming.chatKey, status: 'waiting' });
    await sleepMs(250);
    sandbox.fetch = origFetch2;
    const keptSelection = vm.runInContext('state.currentSessionId', ctx) === 's_sse_1';
    keptSelection ? pass++ : fail++;
    console.log('  ' + (keptSelection ? 'OK   ' : 'FAIL ') + '新 Session 不抢占当前查看窗口');
  } catch (e) {
    fail++; console.log('  FAIL SSE 实时性测试抛错: ' + (e && e.message));
  }

  // ── 批量自定义价格编辑弹窗（2026-09-05 改版：供应商 → 模型 → 官方价）──
  console.log('\n=== 批量自定义价格编辑弹窗 ===');
  try {
    vm.runInContext(`
      state.providers = [
        { id: 'a6api', displayName: 'A6API中转站', models: ['deepseek-v4-flash', 'glm-5.3'], modelNames: {} },
        { id: 'openrouter', displayName: 'OpenRouter', models: ['openai/gpt-5.6-luna'], modelNames: {} }
      ];
      state.config = state.config || {};
      state.config.api = state.config.api || {};
      state.config.api.modelPrices = { 'orphan-model-x': { in: 1, out: 2, cached: 0.1 } };
      state.modelPrices = { prices: [{ id: 'deepseek-v4-flash', in: 1.5, out: 4.5, cached: 0.05 }], current: null };
    `, ctx);
    ctx.openBatchPriceModal();
    const overlay = document.body.children[document.body.children.length - 1];
    const leftHtml = String(overlay.querySelector('#bp-left').innerHTML || '');
    const rightHtml = String(overlay.querySelector('#bp-right').innerHTML || '');
    const okProv = leftHtml.includes('A6API中转站') && leftHtml.includes('OpenRouter');
    okProv ? pass++ : fail++;
    console.log('  ' + (okProv ? 'OK   ' : 'FAIL ') + '左列展示供应商列表' + (okProv ? '' : ' -> ' + leftHtml.slice(0, 120)));
    const okOrphan = leftHtml.includes('已自定义（目录外');
    okOrphan ? pass++ : fail++;
    console.log('  ' + (okOrphan ? 'OK   ' : 'FAIL ') + '目录外已自定义模型归入虚拟供应商');
    const okModel = rightHtml.includes('deepseek-v4-flash');
    okModel ? pass++ : fail++;
    console.log('  ' + (okModel ? 'OK   ' : 'FAIL ') + '右列展示选中供应商的模型');
    const okOff = !rightHtml.includes('官方 输入') && !rightHtml.includes('官方 缓存命中');
    okOff ? pass++ : fail++;
    console.log('  ' + (okOff ? 'OK   ' : 'FAIL ') + '官方价不占列（太挤，改走占位符/悬停）');
    const okPh = rightHtml.includes('placeholder="1.5"') && rightHtml.includes('官方价：输入 1.5 / 输出 4.5');
    okPh ? pass++ : fail++;
    console.log('  ' + (okPh ? 'OK   ' : 'FAIL ') + '官方价仍在占位符与悬停提示里' + (okPh ? '' : ' -> ' + rightHtml.slice(0, 150)));
  } catch (e) {
    fail++; console.log('  FAIL 批量价格弹窗抛错: ' + (e && e.message));
  }

} catch (e) {
  fail++;
  console.log('\n加载 app.js 失败: ' + (e && e.message));
  console.log(e && e.stack && e.stack.split('\n').slice(0, 6).join('\n'));
}

console.log('\n' + (fail ? 'FAILED ' + fail + ' / passed ' + pass : 'ALL PASSED ' + pass));
process.exit(fail ? 1 : 0);
