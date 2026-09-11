import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatStore } from '../src/store.js';

describe('ChatStore', () => {
  function fixture(t, cap = 0) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-store-'));
    const store = new ChatStore(cap, { dataDir: dir });
    t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    return { store, dir };
  }
  function append(store, mid, text = 'message') {
    return store.appendIncoming('group:1', { mid, text, senderId: '42', senderName: 'member' });
  }

  it('deduplicates replayed messages and preserves pagination order', (t) => {
    const { store } = fixture(t);
    append(store, 1);
    assert.equal(append(store, 1).duplicate, true);
    append(store, 2);
    assert.equal(store.unreadCount('group:1'), 2);
    assert.deepEqual(store.recent('group:1', { limit: 1, offset: 1 }).map((m) => m.mid), ['1']);
  });

  it('claims a snapshot without acknowledging it and keeps later messages pending', (t) => {
    const { store } = fixture(t);
    append(store, 1);
    const batch = store.claimUnread('group:1');
    assert.equal(store.findByMid('group:1', 1).read, false);
    assert.equal(store.claimUnread('group:1'), null);
    append(store, 2);
    assert.equal(store.ackLease(batch.id), 1);
    assert.equal(store.ackLease(batch.id), 0);
    assert.deepEqual(store.peekUnread('group:1').map((m) => m.mid), ['2']);
  });

  it('returns failed unsent batches to pending and stops after the attempt budget', (t) => {
    const { store } = fixture(t);
    append(store, 1);
    for (let n = 0; n < 3; n++) {
      const batch = store.claimUnread('group:1');
      store.failLease(batch.id, 'offline', { delayMs: 0 });
    }
    assert.equal(store.unreadCount('group:1'), 0);
    assert.equal(store.getChatMeta('group:1').failed, 1);
    assert.equal(store.retryFailed('group:1'), 1);
    assert.equal(store.unreadCount('group:1'), 1);
  });

  it('recovers expired leases without re-sending uncertain external effects', (t) => {
    const { store } = fixture(t);
    append(store, 1);
    const batch = store.claimUnread('group:1');
    const send = store.beginSend('group:1', batch.id, { text: 'hello' });
    store.finishSend(send, { error: 'response lost' });
    assert.equal(store.recoverExpired(Date.now() + 300000), 1);
    assert.equal(store.getChatMeta('group:1').held, 1);
    assert.equal(store.retryFailed('group:1'), 0);
    assert.equal(store.resolveHeld('group:1'), 1);
  });

  it('persists leases and recovers an interrupted unsent run after reopening', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-store-reopen-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    let store = new ChatStore(0, { dataDir: dir });
    append(store, 1);
    store.claimUnread('group:1');
    store.close();
    store = new ChatStore(0, { dataDir: dir });
    assert.equal(store.recoverExpired(Date.now() + 300000), 1);
    assert.equal(store.unreadCount('group:1'), 1);
    store.close();
  });

  it('bounds each batch and never evicts pending messages for retention', (t) => {
    const { store } = fixture(t, 2);
    for (let i = 1; i <= 6; i++) append(store, i, 'x'.repeat(3000));
    assert.equal(store.unreadCount('group:1'), 6);
    const batch = store.claimUnread('group:1', { maxChars: 3000 });
    assert.equal(batch.messages.length, 1);
    assert.ok(batch.messages[0].text.length < 2100);
    assert.equal(store.findByMid('group:1', 1).text.length, 3000);
    store.failLease(batch.id, 'invalid model', { retryable: false });
    assert.equal(store.getChatMeta('group:1').failed, 1);
    assert.equal(store.getChatMeta('group:1').unread, 5);
  });

  it('imports a legacy JSON once, preserving the original archive', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-store-import-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'messages'));
    const file = path.join(dir, 'messages/group_1.json');
    fs.writeFileSync(file, JSON.stringify({ chatKey: 'group:1', messages: [
      { mid: 1, text: 'old', read: true }, { mid: 2, text: 'new', read: false }
    ] }));
    let store = new ChatStore(0, { dataDir: dir });
    assert.equal(store.unreadCount('group:1'), 1);
    store.close();
    store = new ChatStore(0, { dataDir: dir });
    assert.equal(store.getChatMeta('group:1').total, 2);
    assert.ok(fs.existsSync(file));
    store.close();
  });

  it('updates media without duplication and only marks specified pending IDs read', (t) => {
    const { store } = fixture(t);
    const m = append(store, 1);
    append(store, 2);
    store.updateByMid('group:1', 1, { text: 'expanded', appendMedia: [{ url: 'https://example.com/a' }, { url: 'https://example.com/a' }] });
    assert.equal(store.findByLocalId('group:1', m.id).media.length, 1);
    assert.equal(store.findByMid('group:1', 1).text, 'expanded');
    assert.equal(store.markRead('group:1', [m.id]), 1);
    assert.equal(store.activeMembers('group:1')[0].count, 2);
    assert.equal(store.drainUnread('group:1').length, 1);
  });
});
