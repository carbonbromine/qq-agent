import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('default suite excludes retired feature legacy audits', () => {
  const command = String(pkg.scripts?.test || '');
  assert.doesNotMatch(command, /test\/selftest\.mjs/);
  assert.doesNotMatch(command, /test\/render-test\.mjs/);
  assert.match(command, /node --test test\/\*\.test\.mjs/);
});

test('legacy audits remain explicitly runnable', () => {
  assert.equal(pkg.scripts?.['test:legacy-selftest'], 'node test/selftest.mjs');
  assert.equal(pkg.scripts?.['test:legacy-render'], 'node test/render-test.mjs');
});

test('current render command targets current-architecture UI invariants', () => {
  const command = String(pkg.scripts?.['test:render'] || '');
  assert.match(command, /stable-feature-architecture\.test\.mjs/);
  assert.match(command, /relationship-v2-ui\.test\.mjs/);
  assert.match(command, /memory-page-separation\.test\.mjs/);
  assert.doesNotMatch(command, /render-test\.mjs/);
});
