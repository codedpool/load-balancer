// Per-client token-bucket rate limiter with idle-entry eviction so the bucket
// maps don't grow unbounded with the number of distinct clients seen.

export class RateLimiter {
  constructor(rate, burst, { idleTtlMs = 600000, cleanupIntervalMs = 60000 } = {}) {
    this.rate = rate; // tokens added per second
    this.burst = burst; // maximum bucket size
    this.tokens = new Map();
    this.lastRefill = new Map();

    this.idleTtlMs = idleTtlMs;
    this.cleanupTimer = null;
    if (cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => this.sweep(), cleanupIntervalMs);
      // Don't keep the process alive just for cleanup.
      this.cleanupTimer.unref?.();
    }
  }

  allow(key) {
    const now = Date.now() / 1000; // seconds
    const last = this.lastRefill.get(key) ?? 0;
    const elapsed = now - last;

    // Refill tokens based on time elapsed since the last refill.
    const newTokens = Math.floor(elapsed * this.rate);
    if (newTokens > 0) {
      const current = this.tokens.get(key) ?? 0;
      this.tokens.set(key, Math.min(this.burst, current + newTokens));
      this.lastRefill.set(key, now);
    }

    const available = this.tokens.get(key) ?? 0;
    if (available > 0) {
      this.tokens.set(key, available - 1);
      return true;
    }
    return false;
  }

  // Drop buckets for clients that haven't been seen within the idle TTL.
  sweep() {
    const cutoff = Date.now() / 1000 - this.idleTtlMs / 1000;
    for (const [key, last] of this.lastRefill) {
      if (last < cutoff) {
        this.lastRefill.delete(key);
        this.tokens.delete(key);
      }
    }
  }

  size() {
    return this.lastRefill.size;
  }

  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// Wraps a request handler, rejecting clients that exceed their token budget.
// Keyed on the client IP so the budget is shared across that client's
// connections (not reset per ephemeral source port). `allow` may be sync (the
// in-memory limiter) or async (the Redis-backed limiter); awaiting handles both.
export function rateLimitMiddleware(rl, next) {
  return async (req, res) => {
    const key = req.socket.remoteAddress ?? '';
    let allowed = true;
    try {
      allowed = await rl.allow(key);
    } catch {
      allowed = true; // fail open if the limiter backend errors
    }
    if (!allowed) {
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end('Too Many Requests\n');
      return;
    }
    next(req, res);
  };
}
