import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveLimiter } from '../src/core/adaptiveLimiter.js';

test('acquire is bounded by the current limit', () => {
  const lim = new AdaptiveLimiter({ initialLimit: 3, minLimit: 1, maxLimit: 100 });
  assert.equal(lim.tryAcquire(), true);
  assert.equal(lim.tryAcquire(), true);
  assert.equal(lim.tryAcquire(), true);
  assert.equal(lim.tryAcquire(), false); // 3 in flight, limit 3 -> shed
});

test('record frees an in-flight slot', () => {
  const lim = new AdaptiveLimiter({ initialLimit: 1 });
  assert.equal(lim.tryAcquire(), true);
  assert.equal(lim.tryAcquire(), false);
  lim.record(5);
  assert.equal(lim.tryAcquire(), true);
});

test('limit shrinks when latency inflates above the baseline', () => {
  const lim = new AdaptiveLimiter({ initialLimit: 40, minLimit: 1, maxLimit: 200, smoothing: 0.5 });
  lim.record(10); // establishes a ~10ms no-load baseline (minRtt)
  const before = lim.limit;
  for (let i = 0; i < 20; i++) lim.record(200); // sustained latency inflation
  assert.ok(lim.limit < before, `limit should shrink under congestion (${before} -> ${lim.limit})`);
});

test('limit grows back when latency returns to baseline', () => {
  const lim = new AdaptiveLimiter({ initialLimit: 5, minLimit: 1, maxLimit: 200, smoothing: 0.5 });
  lim.record(10);
  for (let i = 0; i < 10; i++) lim.record(200); // shrink
  const low = lim.limit;
  for (let i = 0; i < 30; i++) lim.record(10); // healthy again
  assert.ok(lim.limit > low, `limit should recover when healthy (${low} -> ${lim.limit})`);
});
