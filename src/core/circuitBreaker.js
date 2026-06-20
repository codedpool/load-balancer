// Per-backend circuit breaker for passive failure detection (outlier ejection).
//
//   closed     -> normal; trips to `open` after `failureThreshold` consecutive failures
//   open       -> requests blocked; after `cooldownMs` moves to `half_open`
//   half_open  -> a few trial requests allowed; `successThreshold` successes -> closed,
//                 any failure -> open again
//
// A `now` function can be injected for deterministic testing.

export const BreakerState = Object.freeze({
  Closed: 'closed',
  Open: 'open',
  HalfOpen: 'half_open',
});

export class CircuitBreaker {
  constructor({
    failureThreshold = 5,
    cooldownMs = 10000,
    successThreshold = 2,
    now = () => Date.now(),
  } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.successThreshold = successThreshold;
    this.now = now;

    this.state = BreakerState.Closed;
    this.failures = 0;
    this.successes = 0;
    this.openedAt = 0;
  }

  // Whether a request may be sent now. Transitions open -> half_open once the
  // cooldown has elapsed (the selection itself is the trial request).
  requestAllowed() {
    if (this.state === BreakerState.Open) {
      if (this.now() - this.openedAt >= this.cooldownMs) {
        this.state = BreakerState.HalfOpen;
        this.successes = 0;
        return true;
      }
      return false;
    }
    return true; // closed or half_open
  }

  recordSuccess() {
    if (this.state === BreakerState.HalfOpen) {
      this.successes += 1;
      if (this.successes >= this.successThreshold) {
        this.reset();
      }
    } else {
      this.failures = 0;
    }
  }

  recordFailure() {
    if (this.state === BreakerState.HalfOpen) {
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.trip();
    }
  }

  trip() {
    this.state = BreakerState.Open;
    this.openedAt = this.now();
    this.successes = 0;
  }

  reset() {
    this.state = BreakerState.Closed;
    this.failures = 0;
    this.successes = 0;
  }

  isOpen() {
    return this.state === BreakerState.Open && this.now() - this.openedAt < this.cooldownMs;
  }
}
