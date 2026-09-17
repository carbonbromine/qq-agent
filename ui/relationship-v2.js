'use strict';

(function relationshipV2Page() {
  let loading = false;

  const pct = (value) => `${Math.round((Number(value) || 0) * 100)}%`;
  const timeText = (value) => value ? new Date(Number(value)).toLocaleString('zh-CN') : '—';
  const modeLabel = {
    boundary: '边界未解决',
    deescalate: '近期紧张',
    trusted: '信任',
    'familiar-positive': '熟悉正向',
    cool: '偏冷',
    baseline: '基线'
  };
  const jobLabel = {
    queued: '排队中', running: '执行中', done: '完成', failed_reviewable: '失败待检查'
  };

  function render(config, status, relationships, jobs) {
    const box = document.querySelector('#relationship-v2-page');
    if (!box) return;
    const cfg = config.relationshipV2 || {};
    const counts = status.counts || {};
    box.innerHTML = `
      <div class="asset-head">
        <div>
          <h2>关系状态 V2</h2>
          <div class="muted">长期关系、近期温暖、近期紧张和边界状态分别维护；没有“总好感度”。</div>
        </div>
        <button class="btn btn-small" type="button" id="rv2-refresh">刷新</button>
      </div>
      <div class="usage-cards">
        <div class="usage-card"><span>运行状态</span><strong>${status.active ? '运行中' : cfg.enabled ? '启动失败' : '已停用'}</strong></div>
        <div class="usage-card"><span>人物状态</span><strong>${Number(counts.states) || 0}</strong></div>
        <div class="usage-card"><span>关系事件</span><strong>${Number(counts.events) || 0}</strong></div>
        <div class="usage-card"><span>失败任务</span><strong>${Number(counts.failedJobs) || 0}</strong></div>
      </div>
      ${status.error ? `<div class="banner">${esc(status.error)}</div>` : ''}

      <details class="asset-section" open>
        <summary><strong>运行参数</strong></summary>
        <div class="checkbox-row"><input id="rv2-auto" type="checkbox" ${cfg.autoEvaluationEnabled !== false ? 'checked' : ''} />
          <label for="rv2-auto">启用低频自动评估</label></div>
        <div class="checkbox-row"><input id="rv2-behavior" type="checkbox" ${cfg.behaviorInjectionEnabled === true ? 'checked' : ''} />
          <label for="rv2-behavior">向主聊天注入有界关系提示</label></div>
        <div class="field-row">
          <label class="field"><span>直接互动条数</span><input id="rv2-min-direct" type="number" min="3" max="50" value="${esc(cfg.minDirectMessages ?? 6)}" /></label>
          <label class="field"><span>每人冷却 / 小时</span><input id="rv2-cooldown" type="number" min="1" max="720" value="${esc(cfg.perUserCooldownHours ?? 12)}" /></label>
          <label class="field"><span>每日评估上限</span><input id="rv2-daily" type="number" min="1" max="200" value="${esc(cfg.maxEvaluationsPerDay ?? 20)}" /></label>
          <label class="field"><span>最大证据条数</span><input id="rv2-evidence" type="number" min="12" max="120" value="${esc(cfg.maxEvidenceMessages ?? 48)}" /></label>
        </div>
        <div class="field-row">
          <label class="field"><span>温暖半衰期 / 小时</span><input id="rv2-warmth" type="number" min="1" max="168" value="${esc(cfg.warmthHalfLifeHours ?? 12)}" /></label>
          <label class="field"><span>紧张半衰期 / 小时</span><input id="rv2-tension" type="number" min="6" max="720" value="${esc(cfg.tensionHalfLifeHours ?? 48)}" /></label>
          <label class="field"><span>长期关系宽限 / 天</span><input id="rv2-grace" type="number" min="0" max="365" value="${esc(cfg.bondGraceDays ?? 30)}" /></label>
          <label class="field"><span>关系置信半衰期 / 天</span><input id="rv2-bond-half" type="number" min="30" max="3650" value="${esc(cfg.bondHalfLifeDays ?? 180)}" /></label>
        </div>
        <button class="btn btn-primary btn-small" id="rv2-save" type="button">保存参数</button>
        <span class="muted" id="rv2-save-result"></span>
      </details>

      <details class="asset-section" open>
        <summary><strong>手动后台评估</strong></summary>
        <div class="field-row">
          <label class="field"><span>QQ 号</span><input id="rv2-manual-uin" inputmode="numeric" placeholder="数字 QQ 号" /></label>
          <label class="field"><span>开始时间（可选）</span><input id="rv2-manual-from" type="datetime-local" /></label>
          <label class="field"><span>结束时间（可选）</span><input id="rv2-manual-to" type="datetime-local" /></label>
        </div>
        <button class="btn btn-small" id="rv2-manual-run" type="button" ${status.active ? '' : 'disabled'}>加入后台队列</button>
        <span class="muted" id="rv2-manual-result">${status.active ? '默认评估最近 7 天。' : '启用实验后才能创建任务。'}</span>
      </details>

      <div class="asset-section">
        <h3>关系状态</h3>
        <div class="table-wrap"><table class="usage-table">
          <thead><tr><th>QQ名</th><th>QQ号</th><th>熟悉</th><th>长期等级</th><th>关系置信</th><th>近期温暖</th><th>近期紧张</th><th>策略</th><th>最近互动</th></tr></thead>
          <tbody>${relationships.length ? relationships.map((item) => `<tr>
            <td>${esc(item.name || '未记录')}</td><td><code>${esc(item.userId)}</code></td>
            <td>${pct(item.familiarity)}</td>
            <td>${Number(item.bondLevel) || 0}</td>
            <td>${pct(item.bondConfidence)}</td>
            <td>${pct(item.recentWarmth)}</td>
            <td>${pct(item.recentTension)}</td>
            <td>${esc(modeLabel[item.policy?.mode] || item.policy?.mode || '—')}</td>
            <td>${esc(timeText(item.lastInteractionAt))}</td>
          </tr>`).join('') : '<tr><td colspan="9" class="muted">尚无 V2 状态</td></tr>'}</tbody>
        </table></div>
      </div>

      <div class="asset-section">
        <h3>后台任务</h3>
        <div class="table-wrap"><table class="usage-table">
          <thead><tr><th>任务</th><th>QQ名</th><th>QQ号</th><th>触发</th><th>状态</th><th>证据 / 事件</th><th>时间</th><th>错误</th></tr></thead>
          <tbody>${jobs.length ? jobs.map((job) => `<tr>
            <td><code>${esc(job.id)}</code></td><td>${esc(job.name || '未记录')}</td><td><code>${esc(job.userId)}</code></td>
            <td>${esc(job.triggerKind)}</td><td>${esc(jobLabel[job.status] || job.status)}</td>
            <td>${Number(job.evidenceCount) || 0} / ${Number(job.eventCount) || 0}</td>
            <td>${esc(timeText(job.createdAt))}</td><td title="${esc(job.error)}">${esc(job.error || '—')}</td>
          </tr>`).join('') : '<tr><td colspan="8" class="muted">尚无任务</td></tr>'}</tbody>
        </table></div>
      </div>`;

    box.querySelector('#rv2-refresh')?.addEventListener('click', () => load());
    box.querySelector('#rv2-save')?.addEventListener('click', saveSettings);
    box.querySelector('#rv2-manual-run')?.addEventListener('click', runManual);
  }

  async function saveSettings() {
    const result = document.querySelector('#rv2-save-result');
    if (result) result.textContent = '保存中…';
    const num = (selector, fallback) => {
      const value = Number(document.querySelector(selector)?.value);
      return Number.isFinite(value) ? value : fallback;
    };
    // Snapshot the whole form before the first await so a refresh cannot replace
    // what the operator actually submitted.
    const draft = {
      autoEvaluationEnabled: document.querySelector('#rv2-auto')?.checked === true,
      behaviorInjectionEnabled: document.querySelector('#rv2-behavior')?.checked === true,
      minDirectMessages: num('#rv2-min-direct', 6),
      perUserCooldownHours: num('#rv2-cooldown', 12),
      maxEvaluationsPerDay: num('#rv2-daily', 20),
      maxEvidenceMessages: num('#rv2-evidence', 48),
      warmthHalfLifeHours: num('#rv2-warmth', 12),
      tensionHalfLifeHours: num('#rv2-tension', 48),
      bondGraceDays: num('#rv2-grace', 30),
      bondHalfLifeDays: num('#rv2-bond-half', 180)
    };
    try {
      const config = await api('/api/config');
      const patch = {
        relationshipV2: {
          ...(config.relationshipV2 || {}),
          ...draft
        }
      };
      const response = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
      state.config = response.config;
      if (result) result.textContent = '已保存 ✓';
      await load();
    } catch (error) {
      if (result) result.textContent = `保存失败：${error.message}`;
    }
  }

  async function runManual() {
    const result = document.querySelector('#rv2-manual-result');
    const userId = document.querySelector('#rv2-manual-uin')?.value.trim() || '';
    const fromText = document.querySelector('#rv2-manual-from')?.value || '';
    const toText = document.querySelector('#rv2-manual-to')?.value || '';
    if (result) result.textContent = '正在排队…';
    try {
      const response = await api('/api/relationship-v2/evaluations', {
        method: 'POST',
        body: JSON.stringify({
          userId,
          ...(fromText ? { fromTs: new Date(fromText).getTime() } : {}),
          ...(toText ? { toTs: new Date(toText).getTime() } : {})
        })
      });
      if (result) result.textContent = `已入队：${response.job.id}`;
      setTimeout(() => load(), 300);
    } catch (error) {
      if (result) result.textContent = `创建失败：${error.message}`;
    }
  }

  async function load() {
    if (loading || state.tab !== 'relationships') return;
    loading = true;
    try {
      const [config, status, relations, jobs] = await Promise.all([
        api('/api/config'),
        api('/api/relationship-v2/status'),
        api('/api/relationships?limit=200'),
        api('/api/relationship-v2/jobs?limit=100')
      ]);
      if (state.tab === 'relationships') {
        render(config, status, relations.relationships || [], jobs.jobs || []);
      }
    } catch (error) {
      const box = document.querySelector('#relationship-v2-page');
      if (box) box.innerHTML = `<div class="empty-hint">关系页面加载失败：${esc(error.message)}</div>`;
    } finally {
      loading = false;
    }
  }

  window.loadRelationshipV2Page = load;
})();
