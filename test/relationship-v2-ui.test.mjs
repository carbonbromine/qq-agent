import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = fs.readFileSync(path.join(root, 'ui', 'relationship-v2.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf8');

test('V2 has a dedicated page and the removed V1 script is no longer loaded', () => {
  assert.match(index, /data-tab="relationships"/);
  assert.match(index, /src="\/relationship-v2\.js"/);
  assert.doesNotMatch(index, /relationship-pilot\.js/);
  assert.match(page, /\/api\/relationship-v2\/evaluations/);
  assert.match(page, /rv2-behavior/);
});

test('relationship settings snapshot operator input before asynchronous reads', () => {
  const start = page.indexOf('async function saveSettings()');
  const end = page.indexOf('\n  async function runManual()', start);
  assert.ok(start >= 0 && end > start);
  const body = page.slice(start, end);
  const draftAt = body.indexOf('const draft = {');
  const configRead = body.indexOf("await api('/api/config')");
  const post = body.indexOf("await api('/api/config', { method: 'POST'");
  assert.ok(draftAt >= 0 && draftAt < configRead);
  assert.ok(configRead > draftAt);
  assert.ok(post > configRead);
  assert.match(body, /\.\.\.draft/);
});
