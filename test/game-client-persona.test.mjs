import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-game-client-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.env.DEBUG_SERVER_URL = 'http://127.0.0.1:1/event';
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));

const { PERSONAS, normalizeBehaviorProfile } = await import('../src/personas.js');
const { DEFAULT_CONFIG, getConfig, setRuntimeConfig, updateConfig, loadConfig } = await import('../src/config.js');
const { buildSystemPrompt } = await import('../src/prompt.js');
const { buildMomentSystemPrompt, momentPersonaHash } = await import('../src/moment-prompt.js');
const { buildQzoneInteractionPrompt, qzoneInteractionPersonaHash } = await import('../src/qzone-interaction-prompt.js');
const { buildFriendReviewSystemPrompt } = await import('../src/friend-review-prompt.js');
const { mdToPlain } = await import('../src/md-to-plain.js');

function developerPersona() {
  const template = PERSONAS.xiaojingyu_game_client;
  return {
    ...DEFAULT_CONFIG.persona,
    roleText: template.text,
    behaviorProfile: template.behaviorProfile
  };
}

test('ships a single-source developer role without changing the existing default', () => {
  assert.equal(DEFAULT_CONFIG.persona.roleText, PERSONAS.xiaojingyu.text);
  assert.equal(DEFAULT_CONFIG.persona.behaviorProfile, 'legacy');
  assert.equal(PERSONAS.xiaojingyu_game_client.behaviorProfile, 'grounded');
  assert.equal(PERSONAS.xiaojingyu_game_client.text, fs.readFileSync(
    new URL('../roles/xiaojingyu-game-client.md', import.meta.url), 'utf8'
  ).trim());
  for (const text of ['Unity / C#', '27 岁', '3 至 5 年', '不冒充真实公司的员工', '未经运行不说测试通过']) {
    assert.ok(PERSONAS.xiaojingyu_game_client.text.includes(text), text);
  }
  assert.doesNotMatch(PERSONAS.xiaojingyu_game_client.text, /mcp__|qq_mark_read|\[SILENT\]/);
});

test('grounded chat replaces conflicting style rules but retains permissions and tools', () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  const prompt = buildSystemPrompt({ persona: developerPersona() });
  for (const text of ['【自然交流与可靠边界】', '不受闲聊字数限制', 'finish 的交接不是定时任务',
    '不能执行命令', '发言必须', 'send_message', 'memory_append', '不按轮数凑配额']) {
    assert.ok(prompt.includes(text), text);
  }
  for (const text of ['可以先反问、阴阳、装傻', '给一个离谱/没用的答案', '多数 ≤30 字',
    '只有讲故事、回忆、补刀时才', '大约每 3~5 轮', '代码块在 QQ 上会显示成乱码']) {
    assert.equal(prompt.includes(text), false, text);
  }
  const legacyPersona = { ...DEFAULT_CONFIG.persona };
  delete legacyPersona.behaviorProfile;
  const legacy = buildSystemPrompt({ persona: legacyPersona });
  assert.equal(legacy, buildSystemPrompt({ persona: DEFAULT_CONFIG.persona }));
  assert.ok(legacy.includes('【反 AI 味：拒绝有求必应】'));
  assert.notEqual(legacy, prompt);
  assert.equal(prompt, buildSystemPrompt({ persona: developerPersona() }));
});

test('all social scenes receive the full same role and invalidate stale persona hashes', () => {
  const persona = developerPersona();
  for (const build of [
    (p) => buildSystemPrompt({ persona: p }),
    buildMomentSystemPrompt,
    buildQzoneInteractionPrompt,
    buildFriendReviewSystemPrompt
  ]) {
    const result = build({ ...persona, customRules: '测试附加规则' });
    assert.ok(result.includes(persona.roleText));
    assert.ok(result.includes('测试附加规则'));
  }
  for (const hash of [momentPersonaHash, qzoneInteractionPersonaHash]) {
    assert.notEqual(hash(DEFAULT_CONFIG.persona), hash(persona));
  }
  assert.doesNotMatch(buildMomentSystemPrompt(persona), /【工作方式/);
  assert.doesNotMatch(buildQzoneInteractionPrompt(persona), /【反 AI 味/);
});

test('persona behavior persists, keeps edited roles and rejects invalid updates atomically', () => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  assert.equal(normalizeBehaviorProfile(undefined), 'legacy');
  updateConfig({ persona: developerPersona() });
  assert.equal(loadConfig().persona.behaviorProfile, 'grounded');
  updateConfig({ persona: { roleText: `${developerPersona().roleText}\n补充偏好` } });
  assert.equal(loadConfig().persona.behaviorProfile, 'grounded');
  assert.ok(loadConfig().persona.roleText.endsWith('补充偏好'));
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  for (const invalid of ['unknown', '', 1, {}, true]) {
    assert.throws(() => updateConfig({ persona: { behaviorProfile: invalid } }), /behavior profile/);
    assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before);
    assert.equal(getConfig().persona.behaviorProfile, 'grounded');
  }
  updateConfig({ persona: { ...DEFAULT_CONFIG.persona } });
  assert.equal(loadConfig().persona.behaviorProfile, 'legacy');
  assert.equal(loadConfig().persona.roleText, PERSONAS.xiaojingyu.text);
});

test('grounded formatting preserves code operators, indentation and inline code', () => {
  const code = [
    '#if DEBUG',
    '    var product = a * b * c;',
    '    var mask = left | right;',
    '    var label = "__keep__";',
    '    var test = value > 0 && value < 10;',
    '    var markdown = "[name](url)";',
    '#endif'
  ].join('\n');
  const input = `**Example**\n\`\`\`csharp\n${code}\n\`\`\`\nInline \`a * b * c\`.`;
  assert.equal(mdToPlain(input, { preserveCode: true }), `Example\n${code}\nInline a * b * c.`);
  assert.equal(mdToPlain(`~~~cpp\n${code}\n~~~`, { preserveCode: true }), code);
  assert.equal(mdToPlain('```cs\r\n    x *= 2;\r\n```', { preserveCode: true }), '    x *= 2;');
  assert.equal(mdToPlain('````cs\nvar s = "```";\n````', { preserveCode: true }), 'var s = "```";');
  assert.equal(mdToPlain('\u0000QQ_CODE_0\u0000 `a * b * c`', { preserveCode: true }),
    '\u0000QQ_CODE_0\u0000 a * b * c');
  assert.equal(mdToPlain('**hello**\n- item'), 'hello\n• item');
  assert.equal(mdToPlain('`a * b * c`'), 'a  b  c');
});

test('a developer Agent sends intact code through its session-bound tool and durable outbox', async (t) => {
  const { ChatStore } = await import('../src/store.js');
  const { SessionRegistry } = await import('../src/sessions.js');
  const { Orchestrator } = await import('../src/orchestrator.js');
  const { SendQueue } = await import('../src/sender.js');
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.persona = developerPersona();
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['123'];
  cfg.api.model = 'test';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.sticker.enabled = false;
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  const code = '    var product = a * b * c;\n    var mask = left | right;';
  const sent = [];
  const onebot = {
    getGroupInfo: async () => ({ group_name: 'Test' }),
    sendText: async (kind, id, text) => { sent.push({ kind, id, text }); return { message_id: 9 }; }
  };
  const store = new ChatStore(0, { dataDir: dir });
  const sessions = new SessionRegistry();
  const runner = new Orchestrator({
    store, sessions, onebot, stickers: {}, memory: { formatForPrompt: () => '' },
    sender: new SendQueue({ store, onebot })
  });
  const previousFetch = globalThis.fetch;
  t.after(async () => {
    globalThis.fetch = previousFetch;
    await runner.abortAll();
    store.close();
  });
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.ok(request.messages[0].content.includes('【自然交流与可靠边界】'));
    calls++;
    if (calls === 1) {
      // A settings change must not change the already-running session's output format.
      setRuntimeConfig({ ...cfg, persona: { ...DEFAULT_CONFIG.persona } });
    }
    return Response.json({
      choices: [{ message: calls === 1 ? { tool_calls: [{
        id: 'code-send', type: 'function',
        function: { name: 'send_message', arguments: JSON.stringify({ messages: `\`\`\`cs\n${code}\n\`\`\`` }) }
      }] } : { content: '' } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
    });
  };
  store.appendIncoming('group:123', { mid: 1, senderId: '42', text: 'Show code' });
  await runner.wake('group:123');
  assert.deepEqual(sent, [{ kind: 'group', id: '123', text: code }]);
  assert.equal(store.findByMid('group:123', 9).text, code);
  assert.equal(store.findByMid('group:123', 1).state, 'acked');
});

test('console APIs expose, select, customize and roll back the developer persona', async (t) => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.memory.consolidateEnabled = false;
  setRuntimeConfig(cfg);
  const { createApp } = await import('../src/app.js');
  const app = createApp({ log: () => {} });
  app.onebot.connect = async () => {};
  t.after(async () => { await app.stop(); });
  await app.start();
  const request = (route, body) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const templates = (await (await request('/api/persona-templates')).json()).templates;
  const builtin = templates.find((p) => p.id === 'xiaojingyu_game_client');
  assert.equal(builtin.text, developerPersona().roleText);
  assert.equal(builtin.behaviorProfile, 'grounded');
  assert.equal(builtin.builtin, true);
  assert.equal((await request('/api/config', { persona: developerPersona() })).status, 200);
  assert.equal((await (await request('/api/config')).json()).persona.behaviorProfile, 'grounded');
  const custom = { name: 'Developer copy', text: builtin.text, customRules: 'Prefer concise examples', behaviorProfile: 'grounded' };
  assert.equal((await request('/api/persona-templates', custom)).status, 200);
  const saved = (await (await request('/api/persona-templates')).json()).templates.find((p) => p.name === custom.name);
  assert.equal(saved.customRules, custom.customRules);
  assert.equal(saved.behaviorProfile, custom.behaviorProfile);
  assert.equal((await request('/api/persona-templates', { name: 'Old API', text: 'Old role' })).status, 200);
  assert.equal(getConfig().customPersonas.at(-1).behaviorProfile, 'legacy');
  assert.equal((await request('/api/persona-templates', { ...custom, behaviorProfile: 'bad' })).status, 400);
  assert.equal((await request('/api/config', { persona: DEFAULT_CONFIG.persona })).status, 200);
  assert.equal(getConfig().persona.behaviorProfile, 'legacy');
});
