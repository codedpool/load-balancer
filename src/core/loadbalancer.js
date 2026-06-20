import httpProxy from 'http-proxy';
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

export class LoadBalancer {
  constructor() {
    this.routes = new Map(); // prefix -> BackendPool
    this.trie = new Trie();
    // A single shared proxy; the upstream is chosen per request via `target`.
    this.proxy = httpProxy.createProxyServer({ xfwd: true });
  }

  addRoute(prefix, backends, strategy) {
    const pool = BackendPool.fromSpecs(backends);
    pool.strategy = strategy;
    this.routes.set(prefix, pool);
    this.trie.insert(prefix);
  }

  // Core request entry point (equivalent to the original ServeHTTP).
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
    const target = pool.getNextBackend(clientIP);
    if (!target) {
      RouteErrorsTotal.labels(prefix, 'no_backend_available').inc();
      logger.error(requestId, 'No backend available', {
        method: req.method,
        path,
      });
      RouteActiveRequests.labels(prefix).dec();
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('No Backend available\n');
      return;
    }

    target.incActive();
    BackendActiveConnections.labels(prefix, target.target, target.host).inc();
    BackendSelectionTotal.labels(prefix, target.target, target.host, pool.strategy).inc();

    // Capture status code and response size the same way the original wrapped
    // the ResponseWriter.
    const captured = wrapResponse(res);

    let settled = false;
    const finalize = () => {
      if (settled) return;
      settled = true;

      const duration = performance.now() - start; // ms
      target.recordRequest(duration);

      const statusCode = captured.statusCode;
      const responseSize = captured.responseSize;

      this.updateBackendMetrics(prefix, target, duration, statusCode);

      RouteRequestsTotal.labels(prefix, req.method, String(statusCode)).inc();
      RouteRequestDuration.labels(prefix, req.method).observe(duration / 1000);

      if (responseSize > 0) {
        RouteResponseSize.labels(prefix).observe(responseSize);
      }

      if (statusCode >= 400) {
        const errorType = statusCode >= 500 ? 'server_error' : 'client_error';
        RouteErrorsTotal.labels(prefix, errorType).inc();
      }

      logger.info(requestId, 'Routing request', {
        method: req.method,
        path,
        target: target.target,
        duration: `${duration.toFixed(3)}ms`,
      });
      console.log(
        `[${req.method}] ${path} -> ${target.target} [strategy=${pool.strategy}] in ${duration.toFixed(2)}ms ` +
          `(avg ${target.avgLatency().toFixed(2)} ms, active ${target.activeRequests()})`
      );

      BackendActiveConnections.labels(prefix, target.target, target.host).dec();
      target.decActive();
      RouteActiveRequests.labels(prefix).dec();
    };

    res.on('finish', finalize);
    res.on('close', finalize);

    this.proxy.web(req, res, { target: target.target }, (err) => {
      // Upstream connection failure / proxy error.
      BackendFailuresTotal.labels(prefix, target.target, target.host, 'connection_error').inc();
      RouteErrorsTotal.labels(prefix, 'proxy_error').inc();
      logger.error(requestId, 'Proxy error', {
        method: req.method,
        path,
        target: target.target,
        status: err?.code || 'error',
      });
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      if (!res.writableEnded) {
        res.end('Bad Gateway\n');
      }
    });
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
    setInterval(() => {
      const snapshot = [...this.routes.entries()];
      for (const [prefix, pool] of snapshot) {
        for (const b of pool.backends) {
          this.checkBackend(prefix, b, healthPath);
        }
      }
    }, intervalMs);
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
      const pool = new BackendPool([new Backend(backendURL, weight)], strategy);
      this.routes.set(prefix, pool);
      this.trie.insert(prefix);
      console.log(`Created new route ${prefix} with backend ${backendURL}`);
      return;
    }

    existing.backends.push(new Backend(backendURL, weight));
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
        backends: pool.backends.map((b) => ({ url: b.target, weight: b.weight })),
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
      pool.backends = backends.map(specToBackend);
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
