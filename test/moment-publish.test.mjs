import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-moment-publish-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
const { DailyMomentsManager } = await import('../src/daily-moments.js');
const { buildMomentSystemPrompt, momentPersonaHash } = await import('../src/moment-prompt.js');
const { SessionRegistry } = await import('../src/sessions.js');
after(() => fs.rmSync(root, { recursive: true, force: true }));

const now = Date.parse('2026-09-12T08:00:00Z');
const dayKey = '2026-09-12';
const decision = (patch = {}) => ({
  decision: 'publish', reason: 'A concrete observation', content: 'Only the loading screen was shared.',
  imageIds: [], groupSummaries: [{ chatKey: 'group:1', summary: 'Discussed a connection issue.' }],
  ...patch
});

function response(args, patch = {}) {
  return {
    message: {
      content: null, reasoning_content: 'provider state',
      tool_calls: [{ id: 'submit', type: 'function', function: {
        name: 'submit_daily_moment', arguments: typeof args === 'string' ? args : JSON.stringify(args)
      } }]
    },
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...patch
  };
}

function fixture(patch = {}) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.api.model = 'mock';
  cfg.persona = {
    botName: 'Mori', selfNickname: 'Mori', roleText: 'Reserved and literal. No forced jokes.',
    customRules: 'Do not use a signature catchphrase.', participation: 'low'
  };
  cfg.dailyMoments.minMessagesPerGroup = 1;
  cfg.dailyMoments.enabled = true;
  cfg.dailyMoments.maxRounds = 3;
  cfg.dailyMoments.allowImages = false;
  setRuntimeConfig(cfg);
  const sends = [], requests = [];
  const options = {
    stateFile: path.join(dir, 'moments.json'),
    store: { listChats: () => ['group:1'], recent: () => [
      { ts: now - 1000, text: 'A concrete connection problem.', senderName: 'Member', media: [] },
      { ts: now - 500, text: 'I watched the loading screen.', senderName: 'Mori', self: true, media: [] }
    ] },
    memory: { members: () => [], getHandoff: () => null },
    stickers: { sync: async () => ({ entries: [] }) },
    onebot: { selfId: '888', call: async (action, params) => {
      if (action === 'get_qzone_msg_list') return { msglist: [] };
      assert.equal(action, 'send_qzone_msg');
      sends.push(params);
      return { tid: 'tid-test' };
    } },
    complete: async (args) => { requests.push(structuredClone(args.messages)); return response(decision()); },
    now: () => now,
    random: () => 0,
    ...patch
  };
  return { cfg, options, manager: new DailyMomentsManager(options), sends, requests };
}

test('persona-specific prompt keeps the complete settings and does not append chat protocol', () => {
  const { cfg } = fixture();
  const prompt = buildMomentSystemPrompt(cfg.persona);
  assert.ok(prompt.includes(cfg.persona.roleText));
  assert.ok(prompt.includes(cfg.persona.customRules));
  assert.ok(prompt.includes('Mori'));
  assert.ok(!prompt.includes('小鲸鱼'));
  assert.ok(!prompt.includes('【工作方式'));
  assert.ok(!prompt.includes('被 @ 或提到小鲸鱼'));
  assert.ok(prompt.includes('不要在一段通用文案上贴几个口头禅'));
  assert.ok(prompt.includes('不能把别人的经历写成'));
  assert.ok(prompt.includes('不公开群名'));
  const changed = { ...cfg.persona, roleText: 'Verbose, poetic, patient.' };
  assert.notEqual(momentPersonaHash(cfg.persona), momentPersonaHash(changed));
  assert.ok(buildMomentSystemPrompt(changed).includes(changed.roleText));
});

test('malformed JSON is returned as a tool error, then a corrected decision publishes', async () => {
  let calls = 0;
  const f = fixture({ complete: async ({ messages }) => {
    calls++;
    if (calls === 1) return response('{"decision":"publish","content":"reply "unescaped" here"}');
    const tool = messages.find((message) => message.role === 'tool');
    assert.match(tool.content, /不是合法 JSON/);
    assert.equal(messages.find((message) => message.role === 'assistant').reasoning_content, 'provider state');
    return response(decision());
  } });
  const result = await f.manager.run({ dayKey, publish: true, source: 'manual-publish' });
  assert.equal(result.record.status, 'published');
  assert.equal(calls, 2);
  assert.equal(f.sends.length, 1);
});

test('all decision rounds use auto tool choice for thinking-mode compatibility', async () => {
  const toolChoices = [];
  const f = fixture({ complete: async ({ toolChoice }) => {
    toolChoices.push(toolChoice);
    if (toolChoices.length < 3) {
      return {
        message: { content: 'still deciding' },
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      };
    }
    return response(decision());
  } });
  const result = await f.manager.run({ dayKey, publish: false });
  assert.equal(result.record.status, 'preview');
  assert.deepEqual(toolChoices, ['auto', 'auto', 'auto']);
});

test('empty or invalid submissions never become successful skip decisions', async () => {
  for (const bad of [{}, null, [], decision({ decision: 'other' }), decision({ reason: '' }),
    decision({ groupSummaries: [] }), decision({ imageIds: ['unknown'] })]) {
    const f = fixture({ complete: async () => response(bad) });
    await assert.rejects(f.manager.run({ dayKey, publish: true }), { code: 'MOMENT_DECISION_INVALID' });
    assert.equal(f.manager.status().latest.status, 'failed');
    assert.equal(f.sends.length, 0);
  }
});

test('valid skip is explicit and remains a successful non-publication', async () => {
  const f = fixture({ complete: async () => response(decision({ decision: 'skip', content: '', reason: 'Nothing new today.' })) });
  const result = await f.manager.run({ dayKey, publish: true });
  assert.equal(result.record.status, 'skipped');
  assert.equal(result.record.reason, 'Nothing new today.');
  assert.equal(f.sends.length, 0);
});

test('restart recovers stale preview/generation but holds an uncertain publication', async () => {
  const f = fixture();
  fs.writeFileSync(f.options.stateFile, JSON.stringify({ version: 1, records: [
    { id: 'old-preview', dayKey, source: 'manual-preview', status: 'running' },
    { id: 'old-generation', dayKey: '2026-09-10', source: 'scheduled', status: 'running' },
    { id: 'old-send', dayKey: '2026-09-09', status: 'publishing', content: 'old' }
  ] }));
  const restarted = new DailyMomentsManager(f.options);
  assert.deepEqual(restarted.status().records.map((record) => record.status),
    ['interrupted', 'interrupted', 'publish-unknown']);
  const rerun = await restarted.run({ dayKey, publish: true, source: 'manual-publish' });
  assert.equal(rerun.record.status, 'published');
  assert.equal(f.sends.length, 1);
  const uncertain = await restarted.run({ dayKey: '2026-09-09', publish: true, force: true, confirmDuplicateRisk: true });
  assert.equal(uncertain.alreadyAttempted, true);
  assert.equal(f.sends.length, 1);
});

test('preview is isolated from publishing, exact draft can publish without another model call', async () => {
  const f = fixture();
  const preview = await f.manager.run({ dayKey, publish: false });
  assert.equal(f.sends.length, 0);
  const result = await f.manager.publishDraft(preview.record.id);
  assert.equal(result.record.tid, 'tid-test');
  assert.equal(f.requests.length, 1);
  assert.equal(f.sends[0].content, preview.record.content);
  const again = await f.manager.publishDraft(preview.record.id);
  assert.equal(again.alreadyAttempted, true);
  assert.equal(f.sends.length, 1);
});

test('explicit confirmation allows manual same-day draft publishing and regeneration', async () => {
  let generated = 0;
  const f = fixture({ complete: async () =>
    response(decision({ content: `manual moment ${++generated}` })) });
  const first = await f.manager.runNow({ dayKey, publish: true });
  const preview = await f.manager.runNow({ dayKey, publish: false });

  const blocked = await f.manager.publishDraft(preview.record.id);
  assert.equal(blocked.alreadyAttempted, true);
  assert.equal(blocked.record.id, first.record.id);
  assert.equal(f.sends.length, 1);

  await assert.rejects(
    f.manager.publishDraft(preview.record.id, { force: true }),
    { code: 'MOMENT_DUPLICATE_CONFIRMATION_REQUIRED' }
  );
  const publishedDraft = await f.manager.publishDraft(preview.record.id, {
    force: true,
    confirmDuplicateRisk: true
  });
  assert.equal(publishedDraft.record.id, preview.record.id);
  assert.equal(publishedDraft.record.status, 'published');
  assert.equal(f.sends.length, 2);

  const rerun = await f.manager.runNow({
    dayKey,
    publish: true,
    force: true,
    confirmDuplicateRisk: true
  });
  assert.equal(rerun.record.status, 'published');
  assert.equal(rerun.alreadyAttempted, undefined);
  assert.equal(f.sends.length, 3);
  assert.equal(generated, 3);
});

test('concurrent publish requests cannot accidentally return a preview result', async () => {
  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  const f = fixture({ complete: async () => {
    started();
    await new Promise((resolve) => { release = resolve; });
    return response(decision());
  } });
  const preview = f.manager.run({ dayKey, publish: false });
  await ready;
  await assert.rejects(f.manager.run({ dayKey, publish: true }), { code: 'MOMENT_BUSY' });
  release();
  await preview;
  assert.equal(f.sends.length, 0);
});

test('missing tid or send failure stays uncertain, and cannot be force-retried', async () => {
  for (const outcome of [null, 'throw']) {
    let sent = 0;
    const f = fixture({ onebot: { selfId: '888', call: async (action) => {
      if (action === 'get_qzone_msg_list') return { msglist: [] };
      sent++;
      if (outcome === 'throw') throw new Error('response lost');
      return {};
    } } });
    await assert.rejects(f.manager.run({ dayKey, publish: true }));
    assert.equal(f.manager.status().latest.status, 'publish-unknown');
    const again = await f.manager.run({ dayKey, publish: true, force: true, confirmDuplicateRisk: true });
    assert.equal(again.alreadyAttempted, true);
    assert.equal(sent, 1);
  }
});

test('stale persona, revoked source permission, and paused runtime block draft publishing', async () => {
  for (const change of [
    (cfg) => { cfg.persona.roleText = 'A different voice'; },
    (cfg) => { cfg.runtime.paused = true; },
    (cfg) => { cfg.allow.groups = []; },
    (cfg) => { cfg.timeControl.enabled = true; cfg.timeControl.schedule = { mode: 'custom', windows: [] }; }
  ]) {
    const f = fixture();
    const preview = await f.manager.run({ dayKey, publish: false });
    change(f.cfg);
    setRuntimeConfig(f.cfg);
    await assert.rejects(f.manager.publishDraft(preview.record.id));
    assert.equal(f.sends.length, 0);
  }
});

test('failed duplicate lookup does not dispatch and does not consume the draft', async () => {
  const f = fixture();
  const preview = await f.manager.run({ dayKey, publish: false });
  f.options.onebot.call = async () => { throw new Error('login expired'); };
  await assert.rejects(f.manager.publishDraft(preview.record.id), /login expired/);
  assert.equal(f.manager.status().latest.status, 'preview');
  assert.equal(f.manager.status().latest.publishAttempted, false);
});

test('unknown publish can be reconciled by exact content without another send', async () => {
  let sent = 0, found = false;
  const f = fixture({ onebot: { selfId: '888', call: async (action) => {
    if (action === 'get_qzone_msg_list') return { msglist: found ? [{ tid: 'found', content: decision().content }] : [] };
    sent++;
    throw new Error('response lost');
  } } });
  await assert.rejects(f.manager.run({ dayKey, publish: true }));
  const id = f.manager.status().latest.id;
  assert.equal((await f.manager.reconcile(id)).matched, false);
  found = true;
  const checked = await f.manager.reconcile(id);
  assert.equal(checked.record.status, 'published');
  assert.equal(checked.record.tid, 'found');
  assert.equal(sent, 1);
});

test('failed model output retains consumed usage in the Session and daily record', async () => {
  const sessions = new SessionRegistry();
  const f = fixture({ sessions, complete: async () => response({}) });
  await assert.rejects(f.manager.run({ dayKey, publish: false }), { code: 'MOMENT_DECISION_INVALID' });
  const record = f.manager.status().latest;
  assert.equal(record.usage.totalTokens, 45);
  assert.equal(sessions.get(record.sessionId).usage.totalTokens, 45);
});

test('current persona self-reference survives public name redaction', async () => {
  const f = fixture({ complete: async () => response(decision({ content: 'Mori has a thought. Member mentioned it.' })) });
  const result = await f.manager.run({ dayKey, publish: false });
  assert.match(result.record.content, /Mori/);
  assert.doesNotMatch(result.record.content, /Member/);
});

test('manual and scheduled publication scopes do not consume each other', async () => {
  for (const manualFirst of [true, false]) {
    const f = fixture();
    const manual = () => f.manager.runNow({ dayKey, publish: true });
    const automatic = () => f.manager.run({ dayKey, publish: true, source: 'scheduled' });
    const first = await (manualFirst ? manual() : automatic());
    const second = await (manualFirst ? automatic() : manual());
    assert.equal(first.record.status, 'published');
    assert.equal(second.record.status, 'published');
    assert.notEqual(first.record.id, second.record.id);
    assert.equal(f.sends.length, 2);
    assert.equal((await manual()).alreadyAttempted, true);
    assert.equal((await automatic()).alreadyAttempted, true);
    assert.equal(f.sends.length, 2);
  }
});

test('publishing a saved manual draft does not block the automatic task', async () => {
  const f = fixture();
  const draft = await f.manager.runNow({ publish: false });
  await f.manager.publishDraft(draft.record.id);
  const automatic = await f.manager.run({ dayKey, publish: true });
  assert.equal(automatic.record.status, 'published');
  assert.equal(f.sends.length, 2);
});

test('unresolved manual sends hold automatic work without a second external write', async () => {
  const f = fixture({ onebot: { selfId: '888', call: async (action) => {
    if (action === 'get_qzone_msg_list') return { msglist: [] };
    throw new Error('response lost');
  } } });
  await assert.rejects(f.manager.runNow({ publish: true }));
  const result = await f.manager.run({ dayKey, publish: true });
  assert.equal(result.alreadyAttempted, true);
  assert.equal(result.record.status, 'publish-unknown');
  assert.equal(f.requests.length, 1);
});

async function settleTimers() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}

function scheduledFixture(t, patch = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-09-12T16:59:45+08:00') });
  const f = fixture({ now: () => Date.now(), ...patch });
  f.cfg.dailyMoments.scheduleWindows = [{ start: '17:00', end: '18:00', count: 2 }];
  f.cfg.dailyMoments.startupCatchup = true;
  t.after(() => f.manager.stop());
  return f;
}

test('random scheduler persists independent slots, publishes twice and survives restart', async (t) => {
  const f = scheduledFixture(t);
  await f.manager.runNow({ publish: true });
  // The manual post predates the first slot by enough to clear the safety gap.
  f.manager.state.records[0].publishStartedAt -= 10 * 60000;
  f.manager.state.records[0].publishedAt -= 10 * 60000;
  f.manager.start();
  const before = f.manager.status().scheduleSlots.map((slot) => ({ id: slot.id, at: slot.at }));
  t.mock.timers.tick(15000);
  await settleTimers();
  assert.equal(f.sends.length, 2);
  assert.equal(f.manager.status().scheduleSlots[0].status, 'published');
  t.mock.timers.tick(30 * 60000);
  await settleTimers();
  assert.equal(f.sends.length, 3);
  assert.equal(f.manager.status().scheduleSlots[1].status, 'published');
  f.manager.stop();
  const restarted = new DailyMomentsManager(f.options);
  t.after(() => restarted.stop());
  restarted.start();
  t.mock.timers.tick(15000);
  await settleTimers();
  assert.equal(f.sends.length, 3);
  assert.deepEqual(restarted.status().scheduleSlots.map((slot) => ({ id: slot.id, at: slot.at })), before);
});

test('pause and time-control gates defer only until the allowed window expires', async (t) => {
  const f = scheduledFixture(t);
  f.cfg.runtime.paused = true;
  f.manager.start();
  t.mock.timers.tick(15000);
  await settleTimers();
  assert.equal(f.requests.length, 0);
  assert.match(f.manager.status().scheduleSlots[0].reason, /暂停/);
  f.cfg.runtime.paused = false;
  f.cfg.timeControl = { enabled: true, schedule: { mode: 'custom', windows: [] }, overrides: {} };
  setRuntimeConfig(f.cfg);
  t.mock.timers.tick(30000);
  await settleTimers();
  assert.equal(f.requests.length, 0);
  assert.match(f.manager.status().scheduleSlots[0].reason, /活跃时间/);
  t.mock.timers.tick(60 * 60000);
  await settleTimers();
  assert.equal(f.sends.length, 0);
  assert.equal(f.manager.status().scheduleSlots.filter((slot) => slot.dayKey === dayKey && slot.status === 'missed').length, 2);
});

test('no catchup starts no late fixed-time task after deployment', async (t) => {
  const f = scheduledFixture(t);
  f.cfg.dailyMoments.scheduleWindows = null;
  f.cfg.dailyMoments.hour = 16;
  f.cfg.dailyMoments.minute = 30;
  f.cfg.dailyMoments.startupCatchup = false;
  f.manager.start();
  t.mock.timers.tick(15000);
  await settleTimers();
  assert.equal(f.requests.length, 0);
  assert.equal(f.manager.status().lastScheduleCheck.status, 'missed');
});

test('unknown slot publication prevents retries and later slots wait for reconciliation', async (t) => {
  let sends = 0;
  let msglist = [];
  const f = scheduledFixture(t, { onebot: { selfId: '888', call: async (action) => {
    if (action === 'get_qzone_msg_list') return { msglist };
    sends++;
    throw new Error('response lost');
  } } });
  f.manager.start();
  t.mock.timers.tick(15000);
  await settleTimers();
  assert.equal(sends, 1);
  assert.equal(f.manager.status().scheduleSlots[0].status, 'publish-unknown');
  t.mock.timers.tick(30 * 60000);
  await settleTimers();
  assert.equal(sends, 1);
  assert.match(f.manager.status().scheduleSlots[1].reason, /待核对/);
  const record = f.manager.status().latest;
  assert.equal((await f.manager.reconcile(record.id)).matched, false);
  assert.equal(f.manager.status().scheduleSlots[0].status, 'publish-unknown');
  msglist = [{ tid: 'confirmed-tid', content: record.content }];
  assert.equal((await f.manager.reconcile(record.id)).matched, true);
  assert.equal(f.manager.status().scheduleSlots[0].status, 'published');
  assert.equal(sends, 1);
  const restored = new DailyMomentsManager(f.options);
  assert.equal(restored.status().scheduleSlots[0].status, 'published');
});

test('expiry while generating prevents an out-of-window send', async (t) => {
  let finish;
  const f = scheduledFixture(t, { complete: async () => {
    await new Promise((resolve) => { finish = resolve; });
    return response(decision());
  } });
  f.cfg.dailyMoments.scheduleWindows = [{ start: '17:00', end: '17:05', count: 1 }];
  f.manager.start();
  t.mock.timers.tick(15000);
  await settleTimers();
  assert.ok(finish);
  t.mock.timers.tick(5 * 60000);
  finish();
  await settleTimers();
  assert.equal(f.sends.length, 0);
  assert.equal(f.manager.status().scheduleSlots[0].status, 'missed');
});

test('a restarted claimed slot is interrupted instead of automatically retried', (t) => {
  const f = scheduledFixture(t);
  f.manager.start();
  const state = JSON.parse(fs.readFileSync(f.options.stateFile, 'utf8'));
  state.scheduleSlots[0].status = 'running';
  fs.writeFileSync(f.options.stateFile, JSON.stringify(state));
  f.manager.stop();
  const restarted = new DailyMomentsManager(f.options);
  assert.equal(restarted.status().scheduleSlots[0].status, 'interrupted');
});

test('live configuration saves preserve overdue waiting slots without startup catchup', async (t) => {
  const f = scheduledFixture(t);
  f.cfg.dailyMoments.startupCatchup = false;
  f.cfg.runtime.paused = true;
  f.manager.start();
  t.mock.timers.tick(15000);
  await settleTimers();
  const before = f.manager.status().scheduleSlots.map((slot) => slot.at);
  t.mock.timers.tick(1000);
  f.cfg.runtime.paused = false;
  f.manager.reconfigure();
  assert.equal(f.manager.status().scheduleSlots[0].status, 'pending');
  assert.deepEqual(f.manager.status().scheduleSlots.map((slot) => slot.at), before);
  t.mock.timers.tick(15000);
  await settleTimers();
  assert.equal(f.sends.length, 1);
  assert.equal(f.manager.status().scheduleSlots[0].status, 'published');
});

test('changing an in-flight window cancels its send without replacing the new timer', async (t) => {
  let finish;
  let calls = 0;
  const f = scheduledFixture(t, { complete: async () => {
    if (++calls === 1) await new Promise((resolve) => { finish = resolve; });
    return response(decision());
  } });
  f.manager.start();
  t.mock.timers.tick(15000);
  await settleTimers();
  f.cfg.dailyMoments.scheduleWindows = [{ start: '17:01', end: '17:10', count: 1 }];
  f.manager.reconfigure();
  finish();
  await settleTimers();
  assert.equal(f.sends.length, 0);
  assert.match(f.manager.status().latest.error, /计划已取消或修改/);
  t.mock.timers.tick(60000);
  await settleTimers();
  assert.equal(f.sends.length, 1);
  assert.equal(f.manager.status().latest.scheduleSlotId, `${dayKey}/17:01-17:10/1`);
});
