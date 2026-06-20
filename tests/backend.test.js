import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Backend, BackendPool, Strategy, parseStrategy } from '../src/core/backend.js';

test('parseStrategy normalizes names and defaults to round robin', () => {
  assert.equal(parseStrategy('WEIGHTED_ROUND_ROBIN'), Strategy.WeightedRoundRobin);
  assert.equal(parseStrategy('least_connections'), Strategy.LeastConnections);
  assert.equal(parseStrategy('nonsense'), Strategy.RoundRobin);
  assert.equal(parseStrategy(undefined), Strategy.RoundRobin);
});

test('round robin cycles through backends', () => {
  const pool = BackendPool.fromSpecs(['http://a:1', 'http://b:1', 'http://c:1']);
  const seen = [pool.getNextBackend('x'), pool.getNextBackend('x'), pool.getNextBackend('x')];
  assert.deepEqual(new Set(seen.map((b) => b.host)).size, 3);
});

test('weighted round robin distributes proportionally (3:1)', () => {
  const pool = BackendPool.fromSpecs([
    { url: 'http://a:1', weight: 3 },
    { url: 'http://b:1', weight: 1 },
  ]);
  pool.strategy = Strategy.WeightedRoundRobin;
  const counts = {};
  for (let i = 0; i < 8; i++) {
    const h = pool.getNextBackend('x').host;
    counts[h] = (counts[h] || 0) + 1;
  }
  assert.equal(counts['a:1'], 6);
  assert.equal(counts['b:1'], 2);
});

test('least connections picks the fewest in-flight', () => {
  const pool = BackendPool.fromSpecs(['http://a:1', 'http://b:1', 'http://c:1']);
  pool.strategy = Strategy.LeastConnections;
  pool.backends[0].active = 5;
  pool.backends[1].active = 1;
  pool.backends[2].active = 9;
  assert.equal(pool.getNextBackend('x').host, 'b:1');
});

test('least loaded factors latency into the score', () => {
  const pool = BackendPool.fromSpecs(['http://a:1', 'http://b:1']);
  pool.strategy = Strategy.LeastLoaded;
  pool.backends[0].active = 0;
  pool.backends[0].totalRequests = 1;
  pool.backends[0].ewmaLatencyMs = 500; // score 5
  pool.backends[1].active = 2;
  pool.backends[1].totalRequests = 1;
  pool.backends[1].ewmaLatencyMs = 50; // score 2.5
  assert.equal(pool.getNextBackend('x').host, 'b:1');
});

test('ip hash is deterministic for the same client', () => {
  const pool = BackendPool.fromSpecs(['http://a:1', 'http://b:1', 'http://c:1']);
  pool.strategy = Strategy.IPHash;
  const first = pool.getNextBackend('203.0.113.7').host;
  for (let i = 0; i < 5; i++) {
    assert.equal(pool.getNextBackend('203.0.113.7').host, first);
  }
});

test('unavailable backends are skipped', () => {
  const pool = BackendPool.fromSpecs(['http://a:1', 'http://b:1']);
  pool.backends[0].setAlive(false);
  for (let i = 0; i < 4; i++) {
    assert.equal(pool.getNextBackend('x').host, 'b:1');
  }
});

test('excluded backends are skipped (failover support)', () => {
  const pool = BackendPool.fromSpecs(['http://a:1', 'http://b:1']);
  const first = pool.getNextBackend('x');
  const second = pool.getNextBackend('x', new Set([first]));
  assert.notEqual(second.host, first.host);
});

test('getNextBackend returns null when all are excluded', () => {
  const pool = BackendPool.fromSpecs(['http://a:1', 'http://b:1']);
  const excluded = new Set(pool.backends);
  assert.equal(pool.getNextBackend('x', excluded), null);
});

test('open breaker makes a backend unavailable', () => {
  const b = new Backend('http://a:1', 1, { failureThreshold: 2, cooldownMs: 1000 });
  assert.equal(b.isAvailable(), true);
  b.recordFailure();
  b.recordFailure();
  assert.equal(b.isAvailable(), false);
});

test('EWMA latency tracks recent samples', () => {
  const b = new Backend('http://a:1');
  b.recordRequest(100);
  assert.equal(b.avgLatency(), 100);
  b.recordRequest(200);
  // 0.3*200 + 0.7*100 = 130
  assert.ok(Math.abs(b.avgLatency() - 130) < 1e-9);
});
