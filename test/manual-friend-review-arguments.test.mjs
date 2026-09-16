import assert from 'node:assert/strict';
import { test } from 'node:test';

const { normalizeManualToolArguments } = await import('../src/manual-friend-review-route.js');

const payload = {
  decision: 'propose',
  ratings: { quality: 4, interest: 3, reciprocity: 4, stability: 3 },
  evidenceIds: ['message:group:1:1', 'message:group:1:2'],
  reasonCode: 'interest',
  reason: '互动稳定且有继续交流意愿'
};

function parsed(value) {
  return JSON.parse(normalizeManualToolArguments(value));
}

test('manual friend review accepts provider-decoded object arguments', () => {
  assert.deepEqual(parsed(payload), payload);
});

test('manual friend review keeps normal JSON string arguments', () => {
  assert.deepEqual(parsed(JSON.stringify(payload)), payload);
});

test('manual friend review unwraps fenced JSON arguments', () => {
  const fenced = '```json\n' + JSON.stringify(payload, null, 2) + '\n```';
  assert.deepEqual(parsed(fenced), payload);
});

test('manual friend review repairs harmless trailing commas', () => {
  const text = JSON.stringify(payload, null, 2)
    .replace(/\n}/g, ',\n}')
    .replace(/\n  }/g, ',\n  }');
  assert.deepEqual(parsed(text), payload);
});
