import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGlobalBlocklist,
  withGlobalBlocklistRuntimeView
} from '../src/global-blocklist.js';

test('normalizeGlobalBlocklist trims, deduplicates and validates QQ UINs', () => {
  assert.deepEqual(
    normalizeGlobalBlocklist([' 12345 ', 67890, '12345', '', null]),
    ['12345', '67890']
  );
  assert.throws(
    () => normalizeGlobalBlocklist(['abc'], { strict: true }),
    /5 到 15 位数字/
  );
});

test('global blacklist is visible to private deny and every group blocklist at runtime', () => {
  const raw = {
    deny: {
      groups: ['90001'],
      private: ['11111'],
      users: ['22222', '33333']
    },
    blocklist: {
      '10001': ['44444']
    }
  };
  const view = withGlobalBlocklistRuntimeView(raw);

  assert.deepEqual(view.deny.private, ['11111', '22222', '33333']);
  assert.deepEqual(view.blocklist['10001'], ['44444', '22222', '33333']);
  assert.deepEqual(view.blocklist['10002'], ['22222', '33333']);
  assert.deepEqual(view.deny.groups, ['90001']);
});

test('runtime projection does not leak global users into serialized per-chat configuration', () => {
  const raw = {
    deny: {
      groups: [],
      private: ['11111'],
      users: ['22222']
    },
    blocklist: {
      '10001': ['33333']
    }
  };
  const view = withGlobalBlocklistRuntimeView(raw);
  const serialized = JSON.parse(JSON.stringify(view));

  assert.deepEqual(serialized.deny.private, ['11111']);
  assert.deepEqual(serialized.deny.users, ['22222']);
  assert.deepEqual(serialized.blocklist, { '10001': ['33333'] });
});
