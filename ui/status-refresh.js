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

// 生命周期线程可能在某次模型 Session 已经结束之后，才由恢复循环因为空闲/硬上限
// 真正关闭。旧 Session 因此不一定有 threadCloseReason；会话详情仍保留了当时的
// idleDeadline / hardDeadline / resumeArmedUntil，可据此恢复一个可解释的结束原因。
const LIFECYCLE_CLOSE_REASON_LABELS = Object.freeze({
  'model-close': '模型主动结束生命周期',
  'mode-changed': '会话模式发生变化',
  'silent-idle': '监听状态空闲超时',
  'active-idle': '活跃状态空闲超时',
  'hard-lifetime': '达到生命周期硬上限，进入待续接窗口',
  'hard-lifetime-silent': '达到生命周期硬上限',
  'rollover-expired': '硬上限后的待续接窗口到期',
  'context-budget': '上下文预算达到上限，进入待续接窗口',
  expired: '续接窗口到期',
  closed: '生命周期已关闭'
});

function lifecycleEndReasonMeta(s) {
  if (s?.conversationMode !== 'lifecycle') return null;
  const aggregate = lifecycleAggregate(s);
  const lifecycle = aggregate?.lifecycle || {};
  const lifecycleState = lifecycle.state || lifecycleStateOf(s);
  if (lifecycleState !== 'closed') return null;

  const explicit = String(lifecycle.closeReason || s.threadCloseReason || '').trim();
  if (explicit) {
    return {
      text: LIFECYCLE_CLOSE_REASON_LABELS[explicit] || explicit,
      detail: `系统记录：${explicit}`
    };
  }

  const now = Date.now();
  const idleDeadline = Number(lifecycle.idleDeadline || s.threadIdleDeadline) || 0;
  const hardDeadline = Number(lifecycle.hardDeadline || s.threadHardDeadline) || 0;
  const resumeArmedUntil = Number(lifecycle.resumeArmedUntil || s.threadResumeArmedUntil) || 0;
  const lastState = String(s.threadState || '');

  // 生命周期曾处于活跃态且硬上限后的续接窗口也已经过去：最终结束点是 rollover expiry。
  if (lastState === 'active' && hardDeadline > 0 && hardDeadline <= now
      && resumeArmedUntil > 0 && resumeArmedUntil <= now
      && (!idleDeadline || hardDeadline <= idleDeadline)) {
    return {
      text: '硬上限后的待续接窗口到期',
      detail: '根据历史截止时间推断'
    };
  }

  if (idleDeadline > 0 && idleDeadline <= now
      && (!hardDeadline || idleDeadline < hardDeadline)) {
    return {
      text: lastState === 'listening' ? '监听状态空闲超时' : '活跃状态空闲超时',
      detail: '根据历史截止时间推断'
    };
  }

  if (hardDeadline > 0 && hardDeadline <= now) {
    return {
      text: '达到生命周期硬上限',
      detail: '根据历史截止时间推断'
    };
  }

  if (resumeArmedUntil > 0 && resumeArmedUntil <= now) {
    return {
      text: '待续接窗口到期',
      detail: '根据历史截止时间推断'
    };
  }

  return { text: '生命周期已关闭', detail: '未记录具体关闭原因' };
}

// 不复制 app.js 的大段渲染逻辑，只在原生命周期摘要尾部追加“结束原因”。
const renderLifecycleOverviewBase = renderLifecycleOverview;
renderLifecycleOverview = function renderLifecycleOverviewWithEndReason(s) {
  const html = renderLifecycleOverviewBase(s);
  const reason = lifecycleEndReasonMeta(s);
  if (!html || !reason) return html;
  const item = `
      <div class="lifecycle-end-reason">
        <span>结束原因</span>
        <strong>${esc(reason.text)}</strong>
        <small>${esc(reason.detail)}</small>
      </div>`;
  return html.replace(/<\/section>\s*$/, `${item}\n    </section>`);
};
