// Backend instances, the pool that owns them, and the selection strategies.
// Node runs application code on a single thread, so the atomic counters used
// in the original implementation become plain numbers here.
import { CircuitBreaker } from './circuitBreaker.js';

export const Strategy = Object.freeze({
  RoundRobin: 'round_robin',
  WeightedRoundRobin: 'weighted_round_robin',
  LeastLatency: 'least_latency',
  LeastActive: 'least_active',
  LeastConnections: 'least_connections',
  LeastLoaded: 'least_loaded',
  IPHash: 'ip_hash',
});

export function parseStrategy(s) {
  switch (String(s ?? '').toLowerCase()) {
    case Strategy.WeightedRoundRobin:
      return Strategy.WeightedRoundRobin;
    case Strategy.LeastActive:
      return Strategy.LeastActive;
    case Strategy.LeastConnections:
      return Strategy.LeastConnections;
    case Strategy.LeastLatency:
      return Strategy.LeastLatency;
    case Strategy.LeastLoaded:
      return Strategy.LeastLoaded;
    case Strategy.IPHash:
      return Strategy.IPHash;
    default:
      return Strategy.RoundRobin;
  }
}

// Smoothing factor for the exponentially weighted moving average of latency.
const EWMA_ALPHA = 0.3;

export class Backend {
  constructor(rawURL, weight = 1, breakerOptions = {}) {
    let parsed;
    try {
      parsed = new URL(rawURL);
    } catch {
      throw new Error(`Invalid backend URL: ${rawURL}`);
    }
    this.url = parsed;
    // String form without a trailing slash, used as the proxy target and as
    // the metric/label identity for this backend.
    this.target = parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname);
    this.host = parsed.host; // host:port

    // Static weight (weighted_round_robin) and the running counter used by the
    // smooth weighted round robin algorithm.
    this.weight = Number(weight) > 0 ? Number(weight) : 1;
    this.currentWeight = 0;

    this.alive = true; // set by active health checks
    this.breaker = new CircuitBreaker(breakerOptions); // passive failure detection

    this.totalRequests = 0;
    this.ewmaLatencyMs = 0; // exponentially weighted moving average latency
    this.active = 0; // current number of in-flight requests
  }

  setAlive(alive) {
    this.alive = alive;
  }

  isAlive() {
    return this.alive;
  }

  // A backend is eligible for selection only if it is both health-check alive
  // and not currently ejected by its circuit breaker.
  isAvailable() {
    return this.alive && this.breaker.requestAllowed();
  }

  recordSuccess() {
    this.breaker.recordSuccess();
  }

  recordFailure() {
    this.breaker.recordFailure();
  }

  // Record a completed request's latency (milliseconds) into the EWMA so recent
  // behaviour dominates and old samples decay.
  recordRequest(durationMs) {
    this.totalRequests += 1;
    if (this.totalRequests === 1) {
      this.ewmaLatencyMs = durationMs;
    } else {
      this.ewmaLatencyMs = EWMA_ALPHA * durationMs + (1 - EWMA_ALPHA) * this.ewmaLatencyMs;
    }
  }

  incActive() {
    this.active += 1;
  }

  decActive() {
    this.active -= 1;
  }

  // Smoothed average latency in milliseconds.
  avgLatency() {
    return this.totalRequests === 0 ? 0 : this.ewmaLatencyMs;
  }

  activeRequests() {
    return this.active;
  }
}

// Build a Backend from a config spec: either a plain URL string or an
// object of the form { url, weight }.
export function specToBackend(spec, breakerOptions) {
  if (typeof spec === 'string') {
    return new Backend(spec, 1, breakerOptions);
  }
  return new Backend(spec.url, spec.weight ?? 1, breakerOptions);
}

export class BackendPool {
  constructor(backends = [], strategy = Strategy.RoundRobin) {
    this.backends = backends;
    this.current = 0;
    this.strategy = strategy;
  }

  static fromSpecs(specs, breakerOptions) {
    return new BackendPool(specs.map((s) => specToBackend(s, breakerOptions)));
  }

  // Pick the next backend per the configured strategy, skipping unavailable
  // backends and any already attempted this request (`excluded`).
  getNextBackend(clientIP, excluded = new Set()) {
    const backends = this.backends;
    const n = backends.length;
    if (n === 0) {
      return null;
    }
    const usable = (b) => b.isAvailable() && !excluded.has(b);

    switch (this.strategy) {
      case Strategy.WeightedRoundRobin: {
        // Smooth weighted round robin (nginx-style), over usable backends only.
        let totalWeight = 0;
        let best = null;
        for (const b of backends) {
          if (!usable(b)) continue;
          b.currentWeight += b.weight;
          totalWeight += b.weight;
          if (best === null || b.currentWeight > best.currentWeight) {
            best = b;
          }
        }
        if (best === null) {
          return null;
        }
        best.currentWeight -= totalWeight;
        return best;
      }

      case Strategy.LeastActive:
      case Strategy.LeastConnections: {
        let best = null;
        let minActive = Infinity;
        for (const b of backends) {
          if (!usable(b)) continue;
          const active = b.activeRequests();
          if (active < minActive) {
            minActive = active;
            best = b;
          }
        }
        return best;
      }

      case Strategy.LeastLoaded: {
        // Lowest combined score of active requests and normalized latency,
        // matching the lb_backend_load_score metric.
        let best = null;
        let bestScore = Infinity;
        for (const b of backends) {
          if (!usable(b)) continue;
          const score = b.activeRequests() + b.avgLatency() / 100;
          if (score < bestScore) {
            bestScore = score;
            best = b;
          }
        }
        return best;
      }

      case Strategy.LeastLatency: {
        let best = null;
        let bestLatency = Infinity;
        for (const b of backends) {
          if (!usable(b)) continue;
          const lat = b.avgLatency();
          if (lat < bestLatency) {
            bestLatency = lat;
            best = b;
          }
        }
        return best;
      }

      case Strategy.IPHash: {
        const idx = hashIP(clientIP) % n;
        for (let i = 0; i < n; i++) {
          const b = backends[(idx + i) % n];
          if (usable(b)) {
            return b;
          }
        }
        return null;
      }

      default: {
        // Round robin (fallback)
        for (let i = 0; i < n; i++) {
          this.current += 1;
          const b = backends[this.current % n];
          if (usable(b)) {
            return b;
          }
        }
        return null;
      }
    }
  }
}

// 32-bit FNV-1a hash, matching the original ip_hash distribution.
function hashIP(ip) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < ip.length; i++) {
    hash ^= ip.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
