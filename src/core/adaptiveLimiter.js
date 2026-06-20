// Adaptive concurrency limiter for load shedding.
//
// Instead of a hand-tuned fixed max-in-flight, the limit self-adjusts from
// observed latency using a gradient algorithm (the approach behind Netflix's
// concurrency-limits / TCP Vegas):
//
//   gradient = minRTT / recentRTT        (1.0 = no queueing, < 1 = congestion)
//   newLimit = limit * gradient + sqrt(limit)   (sqrt = queue headroom)
//
// When latency inflates above the no-load baseline (minRTT), the gradient drops
// and the limit shrinks, so excess load is shed (fast 503) instead of piling
// into unbounded queues and dragging every request down. When healthy, the
// limit grows back. This keeps the balancer responsive under overload rather
// than collapsing — the core of cascading-failure prevention.

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

export class AdaptiveLimiter {
  constructor({
    minLimit = 1,
    maxLimit = 200,
    initialLimit = 20,
    smoothing = 0.2,
    rttResetSamples = 1000,
  } = {}) {
    this.minLimit = minLimit;
    this.maxLimit = maxLimit;
    this.limit = clamp(initialLimit, minLimit, maxLimit);
    this.smoothing = smoothing;
    this.rttResetSamples = rttResetSamples;

    this.inflight = 0;
    this.minRtt = Infinity;
    this.samples = 0;
  }

  // Returns false if we're at the limit (caller should shed with 503).
  tryAcquire() {
    if (this.inflight >= Math.floor(this.limit)) {
      return false;
    }
    this.inflight += 1;
    return true;
  }

  // Call when a request finishes, with its total latency in ms.
  record(rttMs) {
    this.inflight = Math.max(0, this.inflight - 1);
    if (!(rttMs > 0)) return;

    this.samples += 1;
    // Periodically reset the baseline so it can track a shifting no-load RTT.
    if (this.samples % this.rttResetSamples === 0) {
      this.minRtt = rttMs;
    } else if (rttMs < this.minRtt) {
      this.minRtt = rttMs;
    }

    const gradient = clamp(this.minRtt / rttMs, 0.5, 1.0);
    const headroom = Math.sqrt(this.limit);
    const newLimit = this.limit * gradient + headroom;
    this.limit = clamp(
      this.limit * (1 - this.smoothing) + newLimit * this.smoothing,
      this.minLimit,
      this.maxLimit
    );
  }
}
