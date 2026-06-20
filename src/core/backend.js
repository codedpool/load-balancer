// Backend instances, the pool that owns them, and the selection strategies.
// Node runs application code on a single thread, so the atomic counters used
// in the original implementation become plain numbers here.

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

export class Backend {
  constructor(rawURL, weight = 1) {
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

    this.alive = true;
    this.totalRequests = 0;
    this.totalLatencyMs = 0;
    this.active = 0; // current number of in-flight requests
  }

  setAlive(alive) {
    this.alive = alive;
  }

  isAlive() {
    return this.alive;
  }

  // Record a completed request and its latency (milliseconds).
  recordRequest(durationMs) {
    this.totalRequests += 1;
    this.totalLatencyMs += durationMs;
  }

  incActive() {
    this.active += 1;
  }

  decActive() {
    this.active -= 1;
  }

  // Average latency in milliseconds.
  avgLatency() {
    if (this.totalRequests === 0) {
      return 0;
    }
    return this.totalLatencyMs / this.totalRequests;
  }

  activeRequests() {
    return this.active;
  }
}

// Build a Backend from a config spec: either a plain URL string or an
// object of the form { url, weight }.
export function specToBackend(spec) {
  if (typeof spec === 'string') {
    return new Backend(spec);
  }
  return new Backend(spec.url, spec.weight ?? 1);
}

export class BackendPool {
  constructor(backends = [], strategy = Strategy.RoundRobin) {
    this.backends = backends;
    this.current = 0;
    this.strategy = strategy;
  }

  static fromSpecs(specs) {
    return new BackendPool(specs.map(specToBackend));
  }

  getNextBackend(clientIP) {
    const backends = this.backends;
    const n = backends.length;
    if (n === 0) {
      return null;
    }

    switch (this.strategy) {
      case Strategy.WeightedRoundRobin: {
        // Smooth weighted round robin (nginx-style), over alive backends only.
        let totalWeight = 0;
        let best = null;
        for (const b of backends) {
          if (!b.isAlive()) continue;
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
          if (!b.isAlive()) continue;
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
          if (!b.isAlive()) continue;
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
          if (!b.isAlive()) continue;
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
          if (b.isAlive()) {
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
          if (b.isAlive()) {
            return b;
          }
        }
        return null;
      }
    }
  }

  setBackendAlive(url, alive) {
    for (const b of this.backends) {
      if (b.target === url) {
        b.setAlive(alive);
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
