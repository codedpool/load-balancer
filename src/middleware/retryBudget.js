// Retry budget — caps retries as a fraction of request volume so a wave of
// backend failures can't amplify into a retry storm that takes down the whole
// fleet (the classic cascading-failure trigger). Same idea as Envoy/Finagle
// retry budgets: retries are cheap when rare, but globally bounded.
//
// Model: a token bucket where 1 token = 1 permitted retry.
//   - each request deposits `ratio` tokens (e.g. 0.2 -> ~20% of requests' worth)
//   - a floor of `minPerSec` tokens/second is always replenished (so low-volume
//     traffic can still retry)
//   - each retry withdraws 1 token; if the bucket is empty, the retry is denied
//
// A `now` function can be injected for deterministic testing.

export class RetryBudget {
  constructor({
    ratio = 0.2,
    minPerSec = 10,
    ttlMs = 10000,
    now = () => Date.now(),
    initialTokens,
    maxTokens,
  } = {}) {
    this.ratio = ratio;
    this.minPerSec = minPerSec;
    this.now = now;

    const floorCap = minPerSec * (ttlMs / 1000);
    this.maxTokens = maxTokens ?? floorCap + 100;
    // Start with the floor's worth of headroom so cold-start traffic can retry.
    this.tokens = initialTokens ?? floorCap;
    this.last = now();
  }

  _replenish() {
    const t = this.now();
    const dt = (t - this.last) / 1000;
    if (dt > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + dt * this.minPerSec);
      this.last = t;
    }
  }

  // Call once per incoming request.
  deposit() {
    this._replenish();
    this.tokens = Math.min(this.maxTokens, this.tokens + this.ratio);
  }

  // Call when about to retry; returns false if the budget is exhausted.
  withdraw() {
    this._replenish();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
