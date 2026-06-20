import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/middleware/rateLimit.js';

test('allows up to burst then rejects', () => {
  const rl = new RateLimiter(5, 10, { cleanupIntervalMs: 0 });
  const results = [];
  for (let i = 0; i < 13; i++) results.push(rl.allow('client-A'));
  assert.equal(results.filter(Boolean).length, 10);
  assert.equal(results.slice(10).every((r) => r === false), true);
  rl.stop();
});

test('separate keys have independent buckets', () => {
  const rl = new RateLimiter(5, 10, { cleanupIntervalMs: 0 });
  assert.equal(rl.allow('a'), true);
  assert.equal(rl.allow('b'), true);
  assert.equal(rl.allow('c'), true);
  rl.stop();
});

test('refills tokens as time passes', () => {
  const rl = new RateLimiter(5, 10, { cleanupIntervalMs: 0 });
  for (let i = 0; i < 10; i++) rl.allow('k');
  assert.equal(rl.allow('k'), false); // bucket empty
  // Simulate 2 seconds elapsing: 2 * 5 = 10 tokens refilled.
  rl.lastRefill.set('k', Date.now() / 1000 - 2);
  assert.equal(rl.allow('k'), true);
  rl.stop();
});

test('sweep evicts idle buckets', () => {
  const rl = new RateLimiter(5, 10, { cleanupIntervalMs: 0, idleTtlMs: 1000 });
  rl.allow('old');
  rl.allow('fresh');
  rl.lastRefill.set('old', Date.now() / 1000 - 100); // idle beyond TTL
  rl.sweep();
  assert.equal(rl.size(), 1);
  assert.equal(rl.lastRefill.has('fresh'), true);
  assert.equal(rl.lastRefill.has('old'), false);
  rl.stop();
});
