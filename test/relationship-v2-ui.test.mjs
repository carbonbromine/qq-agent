import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
test('retired V2 is absent from UI and promoted pilot scripts are unloaded', () => {
  assert.doesNotMatch(read('ui/index.html'), /data-tab="relationships"|\/relationship-v2\.js|\/multimodal-context-pilot\.js|\/tool-scheduler-pilot\.js/);
  assert.doesNotMatch(read('ui/app.js'), /relationshipV2|launch-relationship-v2|cfg-relationship-v2-enabled/);
  assert.match(read('ui/app.js'), /cfg-tool-parallel/);
});
