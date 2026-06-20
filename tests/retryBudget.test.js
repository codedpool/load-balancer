import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RetryBudget } from '../src/middleware/retryBudget.js';

test('allows retries proportional to request volume (ratio)', () => {
  // No floor, start empty: only deposits fund retries. ratio 0.2 -> 1 retry per 5 requests.
  const b = new RetryBudget({ ratio: 0.2, minPerSec: 0, initialTokens: 0, now: () => 0 });
  for (let i = 0; i < 11; i++) b.deposit(); // ~2.2 tokens
  assert.equal(b.withdraw(), true);
  assert.equal(b.withdraw(), true);
  assert.equal(b.withdraw(), false); // budget exhausted -> retry storm prevented
});

test('caps a retry storm: a burst of failures cannot all retry', () => {
  const b = new RetryBudget({ ratio: 0.1, minPerSec: 0, initialTokens: 0, now: () => 0 });
  let allowed = 0;
  // 100 requests fail and all want to retry; only ~10% may.
  for (let i = 0; i < 100; i++) {
    b.deposit();
    if (b.withdraw()) allowed += 1;
  }
  assert.ok(allowed <= 11, `expected ~10 retries allowed, got ${allowed}`);
});

test('floor replenishes retries over time even with no traffic', () => {
  const clock = { t: 0 };
  const b = new RetryBudget({ ratio: 0, minPerSec: 10, initialTokens: 0, now: () => clock.t });
  assert.equal(b.withdraw(), false); // empty
  clock.t = 1000; // 1s -> +10 floor tokens
  assert.equal(b.withdraw(), true);
});

test('default budget allows normal low-volume retries (no false denials)', () => {
  const b = new RetryBudget({ now: () => 0 }); // defaults: floor headroom
  for (let i = 0; i < 20; i++) {
    b.deposit();
    assert.equal(b.withdraw(), true);
  }
});
