import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-identity-store-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const { ChatStore } = await import('../src/store.js');
const {
  identityDatabasePath,
  readLegacyIdentityMemories
} = await import('../src/identity-store.js');
const { IdentityPilotManager } = await import('../src/identity-pilot.js');

function fileDigest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('disabled identity pilot creates no database and performs no OneBot work', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'disabled-'));
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let calls = 0;
  const manager = new IdentityPilotManager({
    store,
    dataDir: dir,
    config: () => ({ identityPilot: { enabled: false } }),
    onebot: { call: async () => { calls += 1; return []; } },
    log: () => {}
  });
  const status = await manager.start();
  assert.equal(status.enabled, false);
  assert.equal(status.active, false);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(identityDatabasePath(dir)), false);
  assert.equal(manager.observeMessage('group:1', {
    senderId: '123456', senderName: '未启用', ts: Date.now()
  }), false);
});

test('unifies the same QQ across chats and indexes legacy memory without modifying it', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'enabled-'));
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const now = Date.now();
  store.appendIncoming('group:100', {
    mid: 1, ts: now - 3000, senderId: '123456', senderName: '群名片甲', text: '群里消息'
  });
  store.appendIncoming('private:123456', {
    mid: 2, ts: now - 2000, senderId: '123456', senderName: '私聊昵称', text: '私聊消息'
  });
  store.appendIncoming('group:100', {
    mid: 3, ts: now - 1000, senderId: '999999', senderName: '被屏蔽者', text: '不应进入'
  });
  store.appendIncoming('group:200', {
    mid: 4, ts: now, senderId: '777777', senderName: '非白名单成员', text: '不应进入'
  });

  const memoryDir = path.join(dir, 'memory', 'group_100');
  fs.mkdirSync(memoryDir, { recursive: true });
  const memoryFile = path.join(memoryDir, '123456.json');
  fs.writeFileSync(memoryFile, JSON.stringify({
    userId: '123456',
    name: '群名片甲',
    impressions: [
      { content: '喜欢讨论系统设计', createdAt: now - 5000 },
      { content: '喜欢讨论系统设计', createdAt: now - 4000 }
    ]
  }, null, 2));
  const privateMemoryDir = path.join(dir, 'memory', 'private_123456');
  fs.mkdirSync(privateMemoryDir, { recursive: true });
  fs.writeFileSync(path.join(privateMemoryDir, '123456.json'), JSON.stringify({
    userId: '123456',
    name: '私聊昵称',
    impressions: [
      { content: '只应在私聊上下文可见的印象', createdAt: now - 3500 }
    ]
  }, null, 2));
  const beforeHash = fileDigest(memoryFile);
  const beforeMtime = fs.statSync(memoryFile).mtimeMs;

  const cfg = {
    identityPilot: { enabled: true },
    allow: { groups: ['100'], private: ['123456'] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    blocklist: { 100: ['999999'] }
  };
  let friendCalls = 0;
  const manager = new IdentityPilotManager({
    store,
    dataDir: dir,
    config: () => cfg,
    onebot: {
      call: async (action) => {
        assert.equal(action, 'get_friend_list');
        friendCalls += 1;
        return [{ user_id: 123456, nickname: '好友昵称', remark: '好友备注' }];
      }
    },
    log: () => {}
  });

  const status = await manager.start();
  assert.equal(status.active, true);
  assert.equal(status.people, 1);
  assert.equal(status.sources, 2);
  assert.equal(status.friends, 1);
  assert.equal(status.legacyMemories, 2);
  assert.equal(friendCalls, 1);
  assert.equal(fs.statSync(identityDatabasePath(dir)).mode & 0o777, 0o600);

  const people = manager.listPeople();
  assert.equal(people.length, 1);
  assert.equal(people[0].userId, '123456');
  assert.equal(people[0].primaryName, '好友备注');
  assert.equal(people[0].chatCount, 2);
  assert.equal(people[0].messageCount, 2);
  assert.equal(people[0].legacyMemoryCount, 2);
  assert.deepEqual(
    new Set(people[0].aliases.map((item) => item.alias)),
    new Set(['群名片甲', '私聊昵称'])
  );
  assert.equal(fileDigest(memoryFile), beforeHash);
  assert.equal(fs.statSync(memoryFile).mtimeMs, beforeMtime);
  const groupView = manager.lookupPerson('123456', { chatKey: 'group:100' });
  assert.equal(groupView.currentContextMemories.length, 1);
  assert.equal(groupView.currentContextMemories[0].content, '喜欢讨论系统设计');
  assert.equal(groupView.otherContextMemoryCount, 1);
  assert.ok(!JSON.stringify(groupView).includes('只应在私聊上下文可见的印象'));
  const privateView = manager.lookupPerson('123456', { chatKey: 'private:123456' });
  assert.equal(privateView.currentContextMemories[0].content, '只应在私聊上下文可见的印象');
  assert.equal(manager.lookupPerson('777777', { chatKey: 'group:100' }), null);

  const stored = store.appendIncoming('group:100', {
    mid: 5, ts: now + 1000, senderId: '123456', senderName: '新群名片', text: '增量消息'
  });
  assert.equal(manager.observeMessage('group:100', stored), true);
  const updated = manager.listPeople()[0];
  assert.equal(updated.messageCount, 3);
  assert.ok(updated.aliases.some((item) => item.alias === '新群名片'));

  cfg.identityPilot.enabled = false;
  manager.stop();
  assert.equal(manager.active, false);
  assert.equal(manager.observeMessage('group:100', stored), false);
});

test('legacy memory scanner ignores name-only identities and leaves source bytes untouched', (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const memoryDir = path.join(dir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  const file = path.join(memoryDir, 'group_300.json');
  fs.writeFileSync(file, JSON.stringify({
    memberImpression: [
      { userId: '456789', target: '有号码', content: '稳定印象', createdAt: 1 },
      { target: '只有名字', content: '不能跨群归并', createdAt: 2 }
    ]
  }));
  const before = fs.readFileSync(file);
  const rows = readLegacyIdentityMemories(dir);
  assert.deepEqual(rows.map((row) => ({
    userId: row.userId, chatKey: row.chatKey, content: row.content
  })), [{ userId: '456789', chatKey: 'group:300', content: '稳定印象' }]);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('friend proposals require eligibility, deduplicate, cool down, and close on friend_add', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'friend-proposals-'));
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cfg = {
    identityPilot: {
      enabled: true,
      friendProposal: {
        enabled: true,
        ownerUin: '900001',
        minMessageCount: 2,
        cooldownDays: 30,
        maxPending: 2
      }
    },
    allow: { groups: ['100'], private: ['900001'] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    blocklist: {}
  };
  const now = Date.now();
  for (let i = 1; i <= 2; i++) {
    store.appendIncoming('group:100', {
      mid: i,
      ts: now + i,
      senderId: '123456',
      senderName: '候选成员',
      text: `消息${i}`
    });
    store.appendIncoming('group:100', {
      mid: i + 10,
      ts: now + i,
      senderId: '654321',
      senderName: '冷却成员',
      text: `冷却消息${i}`
    });
  }
  const notices = [];
  const onebotActions = [];
  const manager = new IdentityPilotManager({
    store,
    dataDir: dir,
    config: () => cfg,
    onebot: {
      call: async (action) => {
        onebotActions.push(action);
        return [];
      }
    },
    notifyFriendProposal: async (proposal, ownerUin) => {
      notices.push({ proposal, ownerUin });
    },
    log: () => {}
  });
  t.after(() => manager.stop());
  await manager.start();

  const created = await manager.proposeFriend({
    userId: '123456',
    chatKey: 'group:100',
    reasonCode: 'frequent',
    reason: '已经连续聊了很多次',
    verificationMessage: '以后继续聊'
  });
  assert.equal(created.created, true);
  assert.equal(created.adminNotified, true);
  assert.equal(created.proposal.status, 'pending');
  assert.equal(created.proposal.notifiedAt > 0, true);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].ownerUin, '900001');

  const duplicate = await manager.proposeFriend({
    userId: '123456',
    chatKey: 'group:100',
    reasonCode: 'interest',
    reason: '重复候选不应新增'
  });
  assert.equal(duplicate.created, false);
  assert.equal(manager.listFriendProposals().length, 1);

  const approved = manager.decideFriendProposal(
    created.proposal.id,
    'approve',
    { decidedBy: '900001' }
  );
  assert.equal(approved.proposal.status, 'approved_manual');
  assert.equal(approved.execution, 'manual-required');
  assert.equal(approved.protocolDispatchSupported, false);
  assert.match(approved.note, /OneBot/);
  assert.deepEqual(onebotActions, ['get_friend_list']);

  assert.equal(manager.markFriendAdded('123456'), 1);
  assert.equal(manager.listFriendProposals()[0].status, 'accepted');
  assert.equal(manager.listPeople()[0].isFriend, true);
  assert.deepEqual(manager.status().friendProposal.counts, {
    total: 1,
    pending: 0,
    approvedManual: 0,
    accepted: 1,
    rejected: 0
  });

  const rejected = await manager.proposeFriend({
    userId: '654321',
    chatKey: 'group:100',
    reasonCode: 'banter',
    reason: '想以后继续互怼'
  });
  manager.decideFriendProposal(rejected.proposal.id, 'reject', { decidedBy: '900001' });
  await assert.rejects(
    manager.proposeFriend({
      userId: '654321',
      chatKey: 'group:100',
      reasonCode: 'banter',
      reason: '冷却期内重复'
    }),
    /冷却期/
  );
});

test('friend proposal validation enforces message threshold and administrator configuration', async (t) => {
  const dir = fs.mkdtempSync(path.join(root, 'friend-proposal-validation-'));
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const cfg = {
    identityPilot: {
      enabled: true,
      friendProposal: {
        enabled: true,
        ownerUin: '900001',
        minMessageCount: 3,
        cooldownDays: 30,
        maxPending: 1
      }
    },
    allow: { groups: ['100'], private: ['900001'] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    blocklist: {}
  };
  store.appendIncoming('group:100', {
    mid: 1,
    ts: Date.now(),
    senderId: '123456',
    senderName: '候选成员',
    text: '只有一条'
  });
  const manager = new IdentityPilotManager({
    store,
    dataDir: dir,
    config: () => cfg,
    onebot: { call: async () => [] },
    log: () => {}
  });
  t.after(() => manager.stop());
  await manager.start();
  await assert.rejects(
    manager.proposeFriend({
      userId: '123456',
      chatKey: 'group:100',
      reasonCode: 'interest',
      reason: '互动不足'
    }),
    /互动消息不足/
  );
  cfg.identityPilot.friendProposal.ownerUin = '';
  await assert.rejects(
    manager.proposeFriend({
      userId: '123456',
      chatKey: 'group:100',
      reasonCode: 'interest',
      reason: '没有管理员'
    }),
    /管理员 QQ/
  );
});
