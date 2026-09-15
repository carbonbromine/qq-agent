'use strict';

// app.js 的 refreshStatus 同时承担顶部状态栏和业务页面刷新。
// chat-update / 15 秒状态轮询都会调用它，导致好友管理页被整页重建并闪烁。
// 这里仅保留全局状态与必要的当前页状态刷新；好友工作流由
// identity-pilot-update、切页、手动刷新和审批操作各自负责刷新。
refreshStatus = async function refreshStatus() {
  try {
    state.status = await api('/api/status');
    const s = state.status;
    const dot = $('#onebot-dot');
    const label = $('#onebot-label');
    dot.className = 'dot ' + (s.onebot.connected ? 'dot-on' : (s.onebot.everConnected ? 'dot-wait' : 'dot-off'));
    label.textContent = s.onebot.connected
      ? `OneBot 已连接${s.onebot.self ? `（${s.onebot.self.nickname}）` : ''}`
      : 'OneBot 未连接';
    $('#model-label').textContent = `模型：${s.orchestrator.model || '未设置'}`;
    const u = s.usage;
    const c = s.cost;
    const costTxt = c && c.cost > 0 ? ` · ¥${c.cost.toFixed(3)}` : '';
    const rate = s.cacheHitRate;
    const rateTxt = rate > 0 ? ` · 缓存 ${Math.round(rate * 100)}%` : '';
    $('#usage-label').textContent = `今日：${u.runs} 次运行 · ${fmtTokens(u.totalTokens)}${rateTxt}${costTxt}`;
    $('#search-count-label').textContent = `搜索：${s.webSearchCount ?? u.webSearchCount ?? 0} 次`;
    state.paused = s.paused;
    state.pauseReason = s.pauseReason;
    $('#pause-btn').textContent = state.paused ? '恢复' : '暂停';
    if ($('#runtime-mode')) $('#runtime-mode').value = s.orchestrator.mode || 'observe';
    if (s.timeControl?.enabled) {
      $('#model-label').textContent += s.timeControl.active ? ' · 活跃时段' : ' · 非活跃时段';
    }
    if (state.tab === 'settings' && state.settingsSection === 'time-control') loadTimeControlStatus();
    if (state.tab === 'settings' && state.settingsSection === 'moments') loadDailyMomentsStatus();
    if (state.tab === 'settings' && state.settingsSection === 'qzone-interactions') {
      loadQzoneInteractionStatus();
    }
    if (state.tab === 'settings' && state.settingsSection === 'experiments') {
      loadExperimentalFeatureStatuses();
    }
    if (state.tab === 'identity') loadIdentityFeaturePage();
    if (state.tab === 'incidents') loadIncidentFeaturePage();
    renderBanner();
  } catch (e) { /* 忽略瞬时错误 */ }
};
