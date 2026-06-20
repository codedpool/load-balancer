import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { LoadBalancer, parseStrategy } from './core/loadbalancer.js';
import { initMetrics, register } from './core/metrics.js';
import { RateLimiter, rateLimitMiddleware } from './middleware/rateLimit.js';
import { AdaptiveLimiter } from './core/adaptiveLimiter.js';
import { loadShedMiddleware } from './middleware/loadShed.js';
import { AdminHandler } from './controller/admin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROUTES = join(__dirname, '..', 'routes.json');

// Boots the data-plane and control-plane servers. Returns handles plus a
// `stop()` for graceful shutdown. Exposed as a function so tests can run it on
// ephemeral ports without going through process env.
export async function start(opts = {}) {
  const port = opts.port ?? Number(process.env.PORT || 8080);
  const adminPort = opts.adminPort ?? Number(process.env.ADMIN_PORT || 8090);
  const adminToken = opts.adminToken ?? process.env.ADMIN_TOKEN ?? '';
  const healthIntervalMs = opts.healthIntervalMs ?? Number(process.env.HEALTH_INTERVAL_MS || 5000);
  const proxyTimeoutMs = opts.proxyTimeoutMs ?? Number(process.env.PROXY_TIMEOUT_MS || 30000);
  const enableMetrics = opts.metrics !== false; // collect metrics
  // Serve the /metrics endpoint here. In cluster mode the primary aggregates
  // and serves them instead, so workers set this to false.
  const serveMetricsEndpoint = opts.serveMetricsEndpoint ?? enableMetrics;

  if (enableMetrics) {
    initMetrics();
  }

  const lb = new LoadBalancer({
    proxyTimeoutMs,
    maxRetries: opts.maxRetries ?? 2,
    breakerOptions: opts.breakerOptions,
    retryBudget: opts.retryBudget,
    maxSockets: opts.maxSockets,
  });
  const rl = await buildRateLimiter(opts);

  let routes = opts.routes;
  if (!routes) {
    const cfg = JSON.parse(await readFile(opts.routesPath ?? process.env.ROUTES_PATH ?? DEFAULT_ROUTES, 'utf8'));
    routes = cfg.routes;
  }
  for (const r of routes) {
    lb.addRoute(r.prefix, r.backends, parseStrategy(r.strategy), {
      hedgeDelayMs: r.hedgeDelayMs ?? 0,
    });
  }

  if (healthIntervalMs > 0) {
    lb.startHealthChecks(healthIntervalMs, '/health');
  }

  // ---- Data plane (proxying + metrics) ----
  // Optional load shedding: adaptive concurrency limit in front of the balancer.
  let limiter = null;
  let handler = (req, res) => lb.handle(req, res);
  const adaptiveConcurrency = opts.adaptiveConcurrency ?? process.env.ADAPTIVE_CONCURRENCY === 'true';
  if (adaptiveConcurrency) {
    limiter = new AdaptiveLimiter(opts.concurrency || {});
    handler = loadShedMiddleware(limiter, handler);
  }
  // Rate limit (per-client) is outermost, then load shed (global admission).
  const proxied = rateLimitMiddleware(rl, handler);
  const dataServer = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (serveMetricsEndpoint && path === '/metrics') {
      register.metrics().then((m) => {
        res.writeHead(200, { 'Content-Type': register.contentType });
        res.end(m);
      });
      return;
    }
    proxied(req, res);
  });

  // ---- Control plane (admin API on a separate port, token-gated) ----
  const admin = new AdminHandler(lb);
  const adminServer = http.createServer((req, res) => {
    if (adminToken) {
      const provided = bearerToken(req) || req.headers['x-admin-token'];
      if (provided !== adminToken) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('Unauthorized\n');
        return;
      }
    }
    admin.handle(req, res);
  });

  await Promise.all([listen(dataServer, port), listen(adminServer, adminPort)]);

  if (!adminToken) {
    console.warn('WARNING: ADMIN_TOKEN is not set — the admin API is unauthenticated');
  }
  console.log(`Load balancer (data plane) listening on :${dataServer.address().port}`);
  console.log(`Admin API (control plane) listening on :${adminServer.address().port}`);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    lb.stop();
    rl.stop();
    await Promise.all([closeServer(dataServer), closeServer(adminServer)]);
  };

  return {
    dataServer,
    adminServer,
    lb,
    rl,
    limiter,
    stop,
    ports: { data: dataServer.address().port, admin: adminServer.address().port },
  };
}

// Picks the rate limiter: an injected one (tests), Redis-backed when REDIS_URL
// is configured (shared across workers/instances), otherwise in-memory.
async function buildRateLimiter(opts) {
  if (opts.rateLimiter) {
    return opts.rateLimiter;
  }
  const redisUrl = opts.redisUrl ?? process.env.REDIS_URL;
  if (redisUrl) {
    const [{ RedisRateLimiter }, { default: Redis }] = await Promise.all([
      import('./middleware/redisRateLimiter.js'),
      import('ioredis'),
    ]);
    const client = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    client.on('error', (e) => console.error('redis error:', e.message));
    console.log(`Rate limiter: Redis (${redisUrl})`);
    return new RedisRateLimiter({ client, rate: opts.rate ?? 5, burst: opts.burst ?? 10 });
  }
  return new RateLimiter(opts.rate ?? 5, opts.burst ?? 10);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function bearerToken(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

// Run directly (node src/server.js) — not when imported by tests.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const ctx = await start();
  const shutdown = async () => {
    console.log('\nShutting down...');
    await ctx.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
