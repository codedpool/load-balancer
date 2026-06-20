// Per-client token-bucket rate limiter.

export class RateLimiter {
  constructor(rate, burst) {
    this.rate = rate; // tokens added per second
    this.burst = burst; // maximum bucket size
    this.tokens = new Map();
    this.lastRefill = new Map();
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
}

// Wraps a request handler, rejecting clients that exceed their token budget.
// Keyed on the client IP so the budget is shared across that client's
// connections (not reset per ephemeral source port).
export function rateLimitMiddleware(rl, next) {
  return (req, res) => {
    const key = req.socket.remoteAddress ?? '';
    if (!rl.allow(key)) {
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end('Too Many Requests\n');
      return;
    }
    next(req, res);
  };
}
