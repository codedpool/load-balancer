import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, BreakerState } from '../src/core/circuitBreaker.js';

function makeBreaker(overrides = {}) {
  const clock = { t: 0 };
  const breaker = new CircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 1000,
    successThreshold: 2,
    now: () => clock.t,
    ...overrides,
  });
  return { breaker, clock };
}

test('starts closed and allows requests', () => {
  const { breaker } = makeBreaker();
  assert.equal(breaker.state, BreakerState.Closed);
  assert.equal(breaker.requestAllowed(), true);
});

test('opens after consecutive failures and blocks requests', () => {
  const { breaker } = makeBreaker();
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.requestAllowed(), true); // 2 < threshold 3
  breaker.recordFailure();
  assert.equal(breaker.state, BreakerState.Open);
  assert.equal(breaker.requestAllowed(), false);
});

test('a success resets the failure count while closed', () => {
  const { breaker } = makeBreaker();
  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordSuccess();
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.state, BreakerState.Closed); // never hit 3 in a row
});

test('half-opens after cooldown, then closes on enough successes', () => {
  const { breaker, clock } = makeBreaker();
  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.requestAllowed(), false);

  clock.t = 1000; // cooldown elapsed
  assert.equal(breaker.requestAllowed(), true);
  assert.equal(breaker.state, BreakerState.HalfOpen);

  breaker.recordSuccess();
  breaker.recordSuccess(); // successThreshold = 2
  assert.equal(breaker.state, BreakerState.Closed);
});

test('a failure while half-open re-opens immediately', () => {
  const { breaker, clock } = makeBreaker();
  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordFailure();
  clock.t = 1000;
  breaker.requestAllowed(); // -> half-open
  breaker.recordFailure();
  assert.equal(breaker.state, BreakerState.Open);
  assert.equal(breaker.requestAllowed(), false);
});
