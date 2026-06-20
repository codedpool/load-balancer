import httpProxy from 'http-proxy';
import http from 'node:http';
import { performance } from 'node:perf_hooks';

import { Trie } from './trie.js';
import { Backend, BackendPool, Strategy, parseStrategy, specToBackend } from './backend.js';
import * as logger from '../logger/logger.js';
import {
  RouteRequestsTotal,
  RouteRequestDuration,
  RouteActiveRequests,
  RouteErrorsTotal,
  RouteRequestSize,
  RouteResponseSize,
  RouteStrategyChanges,
  BackendHealthStatus,
  BackendRequestsTotal,
  BackendRequestDuration,
  BackendActiveConnections,
  BackendFailuresTotal,
  BackendSelectionTotal,
  BackendHealthCheckDuration,
  BackendHealthCheckFailures,
  BackendLoadScore,
} from './metrics.js';

// Methods safe to retry on another backend without risking duplicate side
// effects. Non-idempotent requests (POST/PATCH) are never retried.
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);

function classifyError(err) {
  switch (err?.code) {
    case 'ECONNREFUSED':
      return 'connection_refused';
    case 'ECONNRESET':
      return 'connection_reset';
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return 'timeout';
    default:
      return 'connection_error';
  }
}

export class LoadBalancer {
  constructor(opts = {}) {
    this.routes = new Map(); // prefix -> BackendPool
    this.trie = new Trie();
    // Extra attempts (on top of the first) when an idempotent request fails at
    // the connection level.
    this.maxRetries = opts.maxRetries ?? 2;
    this.breakerOptions = opts.breakerOptions;
    this.healthTimer = null;
    // Pooled keep-alive connections to upstreams. Without this, every proxied
    // request opens (and closes) a fresh TCP socket, which collapses throughput
    // and exhausts ephemeral ports under load.
    this.agent = new http.Agent({
      keepAlive: true,
      maxSockets: opts.maxSockets ?? 256,
      maxFreeSockets: 256,
    });
    // A single shared proxy; the upstream is chosen per request via `target`.
    // proxyTimeout bounds how long we wait on the upstream before failing over.
    this.proxy = httpProxy.createProxyServer({
      xfwd: true,
      proxyTimeout: opts.proxyTimeoutMs ?? 30000,
      agent: this.agent,
    });
  }

  addRoute(prefix, backends, strategy) {
    const pool = BackendPool.fromSpecs(backends, this.breakerOptions);
    pool.strategy = strategy;
    this.routes.set(prefix, pool);
    this.trie.insert(prefix);
  }

  // Core request entry point with retry/failover across backends.
  handle(req, res) {
    const start = performance.now();
    const requestId = logger.newRequestId();
    const path = req.url.split('?')[0];

    const { matched, matchedPath: prefix } = this.trie.matchPrefix(path);
    if (!matched) {
      RouteErrorsTotal.labels('unknown', 'route_not_found').inc();
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('No backend found for route\n');
      return;
    }

    const pool = this.routes.get(prefix);
    RouteActiveRequests.labels(prefix).inc();

    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > 0) {
      RouteRequestSize.labels(prefix).observe(contentLength);
    }

    const clientIP = req.socket.remoteAddress ?? '';
    const capture = wrapResponse(res);
    const idempotent = IDEMPOTENT.has(req.method);
    const maxAttempts = idempotent ? this.maxRetries + 1 : 1;
    const tried = new Set();

    let chosen = null;
    let chosenStart = 0;
    let attemptActiveDec = true; // true => no active attempt to decrement
    let routeFinalized = false;

    const decChosenActive = () => {
      if (attemptActiveDec) return;
      attemptActiveDec = true;
      BackendActiveConnections.labels(prefix, chosen.target, chosen.host).dec();
      chosen.decActive();
    };

    const finalizeRoute = () => {
      if (routeFinalized) return;
      routeFinalized = true;
      const statusCode = capture.statusCode;
      const duration = performance.now() - start;

      RouteRequestsTotal.labels(prefix, req.method, String(statusCode)).inc();
      RouteRequestDuration.labels(prefix, req.method).observe(duration / 1000);
      if (capture.responseSize > 0) {
        RouteResponseSize.labels(prefix).observe(capture.responseSize);
      }
      if (statusCode >= 400) {
        const errorType = statusCode >= 500 ? 'server_error' : 'client_error';
        RouteErrorsTotal.labels(prefix, errorType).inc();
      }
      RouteActiveRequests.labels(prefix).dec();

      logger.info(requestId, 'Routing request', {
        method: req.method,
        path,
        target: chosen ? chosen.target : '-',
        duration: `${duration.toFixed(3)}ms`,
      });
    };

    // Success path: the upstream response was fully relayed to the client.
    res.on('finish', () => {
      if (chosen && !attemptActiveDec) {
        const duration = performance.now() - chosenStart;
        chosen.recordRequest(duration);
        const statusCode = capture.statusCode;
        // A 5xx counts as a failure for passive ejection; otherwise success.
        if (statusCode >= 500) {
          chosen.recordFailure();
        } else {
          chosen.recordSuccess();
        }
        this.updateBackendMetrics(prefix, chosen, duration, statusCode);
        decChosenActive();
      }
      finalizeRoute();
    });
    res.on('close', () => {
      decChosenActive();
      finalizeRoute();
    });

    const attempt = () => {
      const target = pool.getNextBackend(clientIP, tried);
      if (!target) {
        RouteErrorsTotal.labels(prefix, tried.size === 0 ? 'no_backend_available' : 'all_backends_failed').inc();
        if (!res.headersSent) {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('No backend available\n');
        } else if (!res.writableEnded) {
          res.end();
        }
        return;
      }

      tried.add(target);
      chosen = target;
      chosenStart = performance.now();
      attemptActiveDec = false;
      target.incActive();
      BackendActiveConnections.labels(prefix, target.target, target.host).inc();
      BackendSelectionTotal.labels(prefix, target.target, target.host, pool.strategy).inc();

      this.proxy.web(req, res, { target: target.target }, (err) => {
        // This attempt failed at the connection level.
        decChosenActive();
        target.recordFailure();
        BackendFailuresTotal.labels(prefix, target.target, target.host, classifyError(err)).inc();
        logger.error(requestId, 'Proxy error', {
          method: req.method,
          path,
          target: target.target,
          status: err?.code || 'error',
        });

        if (!res.headersSent && idempotent && tried.size < maxAttempts) {
          attempt(); // fail over to the next backend
          return;
        }
        RouteErrorsTotal.labels(prefix, 'proxy_error').inc();
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Bad Gateway\n');
        } else if (!res.writableEnded) {
          res.end();
        }
      });
    };

    attempt();
  }

  updateBackendMetrics(routePrefix, backend, durationMs, statusCode) {
    const backendURL = backend.target;
    const backendHost = backend.host;

    BackendRequestsTotal.labels(routePrefix, backendURL, backendHost, String(statusCode)).inc();
    BackendRequestDuration.labels(routePrefix, backendURL, backendHost).observe(durationMs / 1000);

    // Load score = active requests + normalized latency.
    const active = backend.activeRequests();
    const latency = backend.avgLatency();
    const loadScore = active + latency / 100;
    BackendLoadScore.labels(routePrefix, backendURL, backendHost).set(loadScore);

    if (statusCode >= 500) {
      BackendFailuresTotal.labels(routePrefix, backendURL, backendHost, 'server_error').inc();
    }
  }

  updateBackendHealthMetrics(routePrefix, backend, isAlive, healthCheckDurationMs) {
    const backendURL = backend.target;
    const backendHost = backend.host;

    if (isAlive) {
      BackendHealthStatus.labels(routePrefix, backendURL, backendHost).set(1);
    } else {
      BackendHealthStatus.labels(routePrefix, backendURL, backendHost).set(0);
      BackendHealthCheckFailures.labels(routePrefix, backendURL, backendHost).inc();
    }

    BackendHealthCheckDuration.labels(routePrefix, backendURL, backendHost).observe(
      healthCheckDurationMs / 1000
    );
  }

  startHealthChecks(intervalMs, healthPath) {
    this.healthTimer = setInterval(() => {
      const snapshot = [...this.routes.entries()];
      for (const [prefix, pool] of snapshot) {
        for (const b of pool.backends) {
          this.checkBackend(prefix, b, healthPath);
        }
      }
    }, intervalMs);
    // Health checks alone shouldn't keep the process alive.
    this.healthTimer.unref?.();
  }

  async checkBackend(prefix, backend, healthPath) {
    const requestId = logger.newRequestId();
    const healthURL = backend.target + healthPath;
    const start = performance.now();

    let isAlive = false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const resp = await fetch(healthURL, { signal: controller.signal });
      isAlive = resp.status === 200;
    } catch {
      isAlive = false;
      BackendFailuresTotal.labels(prefix, backend.target, backend.host, 'connection_error').inc();
    } finally {
      clearTimeout(timer);
    }

    const healthCheckDuration = performance.now() - start;
    backend.setAlive(isAlive);
    this.updateBackendHealthMetrics(prefix, backend, isAlive, healthCheckDuration);

    logger.info(requestId, 'Health check result', {
      path: healthURL,
      target: backend.target,
      method: 'GET',
      status: isAlive ? 'UP' : 'DOWN',
    });
  }

  addBackendToRoute(prefix, backendURL, strategy, weight = 1) {
    const existing = this.routes.get(prefix);
    if (!existing) {
      const pool = new BackendPool([new Backend(backendURL, weight, this.breakerOptions)], strategy);
      this.routes.set(prefix, pool);
      this.trie.insert(prefix);
      console.log(`Created new route ${prefix} with backend ${backendURL}`);
      return;
    }

    existing.backends.push(new Backend(backendURL, weight, this.breakerOptions));
    console.log(`Added new backend ${backendURL} to route ${prefix}`);
  }

  removeBackendFromRoute(prefix, backendURL) {
    const pool = this.routes.get(prefix);
    if (!pool) {
      console.log(`Route ${prefix} does not exist`);
      return;
    }

    pool.backends = pool.backends.filter((b) => b.target !== backendURL);
    console.log(`Removed backend ${backendURL} from route ${prefix}`);
  }

  getRoutesInfo() {
    const result = [];
    for (const [prefix, pool] of this.routes) {
      result.push({
        prefix,
        strategy: pool.strategy,
        backends: pool.backends.map((b) => ({
          url: b.target,
          weight: b.weight,
          alive: b.isAlive(),
          breaker: b.breaker.state,
        })),
      });
    }
    return result;
  }

  updateRoute(prefix, backends, strategy) {
    const pool = this.routes.get(prefix);
    if (!pool) {
      throw new Error(`route not found: ${prefix}`);
    }

    if (backends && backends.length > 0) {
      pool.backends = backends.map((s) => specToBackend(s, this.breakerOptions));
    }

    if (strategy) {
      const oldStrategy = pool.strategy;
      const newStrategy = parseStrategy(strategy);
      if (oldStrategy !== newStrategy) {
        RouteStrategyChanges.labels(prefix, oldStrategy, newStrategy).inc();
        pool.strategy = newStrategy;
      }
    }
  }

  // Stop background timers and release proxy sockets (for graceful shutdown).
  stop() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    try {
      this.proxy.close();
    } catch {
      /* no-op */
    }
    this.agent.destroy();
  }
}

export { Strategy, parseStrategy };

// Intercept status code and bytes written, mirroring the original
// responseWriterWrapper. http-proxy writes the upstream response through these
// same methods, so the wrapper transparently observes it.
function wrapResponse(res) {
  const state = { statusCode: 200, responseSize: 0 };

  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = (statusCode, ...args) => {
    state.statusCode = statusCode;
    return origWriteHead(statusCode, ...args);
  };

  const origWrite = res.write.bind(res);
  res.write = (chunk, ...args) => {
    if (chunk && typeof chunk !== 'function') {
      state.responseSize += Buffer.byteLength(chunk);
    }
    return origWrite(chunk, ...args);
  };

  const origEnd = res.end.bind(res);
  res.end = (chunk, ...args) => {
    if (chunk && typeof chunk !== 'function') {
      state.responseSize += Buffer.byteLength(chunk);
    }
    return origEnd(chunk, ...args);
  };

  return state;
}
