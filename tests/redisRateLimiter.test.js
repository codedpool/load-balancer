import { test } from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';

import { RedisRateLimiter } from '../src/middleware/redisRateLimiter.js';
import { RateLimiter } from '../src/middleware/rateLimit.js';

// ioredis-mock instances share one in-memory data store, which lets us simulate
// multiple load-balancer workers talking to the same Redis.

test('enforces burst then blocks (single worker)', async () => {
  const rl = new RedisRateLimiter({
    client: new RedisMock(),
    rate: 5,
    burst: 10,
    now: () => 1000,
    failOpen: false,
  });
  let allowed = 0;
  for (let i = 0; i < 14; i++) {
    if (await rl.allow('client-A')) allowed++;
  }
  assert.equal(allowed, 10);
});

test('budget is SHARED across workers (the whole point)', async () => {
  // Two limiters = two workers, each with its own client but the same Redis.
  const clock = { t: 1000 };
  const w1 = new RedisRateLimiter({ client: new RedisMock(), rate: 5, burst: 10, now: () => clock.t, failOpen: false });
  const w2 = new RedisRateLimiter({ client: new RedisMock(), rate: 5, burst: 10, now: () => clock.t, failOpen: false });

  let allowed = 0;
  for (let i = 0; i < 16; i++) {
    const worker = i % 2 === 0 ? w1 : w2;
    if (await worker.allow('1.2.3.4')) allowed++;
  }
  // One global budget of 10 across BOTH workers (not 10 each).
  assert.equal(allowed, 10);
});

test('contrast: in-memory limiters do NOT share (10 each = 20)', async () => {
  const w1 = new RateLimiter(5, 10, { cleanupIntervalMs: 0 });
  const w2 = new RateLimiter(5, 10, { cleanupIntervalMs: 0 });
  let allowed = 0;
  for (let i = 0; i < 16; i++) {
    const worker = i % 2 === 0 ? w1 : w2;
    if (worker.allow('1.2.3.4')) allowed++;
  }
  assert.equal(allowed, 16); // all 16 pass (8 each, under per-worker burst of 10)
  w1.stop();
  w2.stop();
});

test('refills over time', async () => {
  const clock = { t: 1000 };
  const rl = new RedisRateLimiter({ client: new RedisMock(), rate: 5, burst: 10, now: () => clock.t, failOpen: false });
  for (let i = 0; i < 10; i++) await rl.allow('k');
  assert.equal(await rl.allow('k'), false); // empty
  clock.t = 1002; // 2s later -> +10 tokens
  assert.equal(await rl.allow('k'), true);
});

test('fails open when the Redis client errors', async () => {
  const brokenClient = {
    tokenBucket: async () => {
      throw new Error('redis down');
    },
  };
  const rl = new RedisRateLimiter({ client: brokenClient, rate: 5, burst: 10, failOpen: true });
  assert.equal(await rl.allow('k'), true);
});
