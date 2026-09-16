import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const index = read('ui/index.html');
const people = read('ui/global-memory.js');
const session = read('ui/session-memory-view.js');

test('memory navigation exposes independent session and person pages', () => {
  assert.match(index, /data-tab="memory"[^>]*>会话记忆<\/button>/);
  assert.match(index, /data-tab="people-memory"[^>]*>人物记忆<\/button>/);
  assert.match(index, /id="view-memory"/);
  assert.match(index, /id="view-people-memory"/);
  assert.match(index, /id="global-memory-items"/);
  assert.match(index, /src="\/session-memory-view\.js"/);
  assert.match(index, /src="\/global-memory\.js"/);
});

test('global person memory renders only inside the dedicated people page', () => {
  assert.match(people, /getElementById\('view-people-memory'\)/);
  assert.match(people, /data-tab="people-memory"/);
  assert.doesNotMatch(people, /data-tab="memory"/);
  assert.doesNotMatch(people, /view-memory\[data-global-memory/);
  assert.match(people, /sourceChatKeys/);
  assert.match(people, /来源会话只用于证据追溯/);
});

test('session memory page suppresses person-memory controls and keeps handoff visible', () => {
  assert.match(session, /#view-memory #mem-add-imp-btn/);
  assert.match(session, /#view-memory #mem-consolidate-btn/);
  assert.match(session, /#view-memory #mem-load-members-btn/);
  assert.match(session, /\.collapsible:not\(\.memory-handoff\)/);
  assert.match(session, /人物长期记忆已独立到“人物记忆”页/);
  assert.match(session, /会话级 handoff \/ 工作状态/);
});
