import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inheritBuiltinPriceMetadata,
  normalizePriceFeed
} from '../src/price-feed.js';
import { priceAt } from '../src/model-prices.js';

test('remote DeepSeek base prices inherit builtin peak tiers when omitted', () => {
  const normalized = normalizePriceFeed({
    'deepseek-flash': { in: 1, out: 4, cached: 0.02 }
  });
  assert.ok(normalized);

  const merged = inheritBuiltinPriceMetadata(normalized.prices);
  assert.deepEqual(merged['deepseek-flash'].peak, {
    in: 2,
    out: 8,
    cached: 0.04
  });

  // 2026-09-17 09:30 Beijing = 01:30 UTC, Thursday: peak.
  const peak = priceAt(merged['deepseek-flash'], Date.parse('2026-09-17T01:30:00Z'));
  assert.equal(peak.peak, true);
  assert.equal(peak.in, 2);
  assert.equal(peak.out, 8);
  assert.equal(peak.cached, 0.04);
});

test('partial remote peak override inherits missing cached peak price', () => {
  const normalized = normalizePriceFeed({
    'deepseek-flash': {
      in: 1,
      out: 4,
      cached: 0.02,
      peak: { in: 2, out: 8 }
    }
  });
  assert.ok(normalized);
  assert.deepEqual(normalized.prices['deepseek-flash'].peak, {
    in: 2,
    out: 8
  });

  const merged = inheritBuiltinPriceMetadata(normalized.prices);
  assert.deepEqual(merged['deepseek-flash'].peak, {
    in: 2,
    out: 8,
    cached: 0.04
  });

  const peak = priceAt(merged['deepseek-flash'], Date.parse('2026-09-17T01:30:00Z'));
  assert.equal(peak.cached, 0.04);
});

test('remote feed can explicitly override builtin peak tiers', () => {
  const normalized = normalizePriceFeed({
    'deepseek-flash': {
      in: 1.2,
      out: 4.8,
      cached: 0.03,
      peak: { in: 2.4, out: 9.6, cached: 0.06 }
    }
  });
  const merged = inheritBuiltinPriceMetadata(normalized.prices);
  assert.deepEqual(merged['deepseek-flash'].peak, {
    in: 2.4,
    out: 9.6,
    cached: 0.06
  });
});

test('models without builtin peak tiers do not gain one', () => {
  const normalized = normalizePriceFeed({
    'glm-5.3-flash': { in: 0.4, out: 1.4, cached: 0.115 }
  });
  const merged = inheritBuiltinPriceMetadata(normalized.prices);
  assert.equal(merged['glm-5.3-flash'].peak, undefined);
});
