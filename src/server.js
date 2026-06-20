import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { LoadBalancer, parseStrategy } from './core/loadbalancer.js';
import { initMetrics, register } from './core/metrics.js';
import { RateLimiter, rateLimitMiddleware } from './middleware/rateLimit.js';
import { AdminHandler } from './controller/admin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTES_PATH = join(__dirname, '..', 'routes.json');
const PORT = Number(process.env.PORT || 8080);

async function loadConfig(path) {
  const data = await readFile(path, 'utf8');
  return JSON.parse(data);
}

async function main() {
  initMetrics();

  const lb = new LoadBalancer();
  const rl = new RateLimiter(5, 10);

  const cfg = await loadConfig(ROUTES_PATH);
  for (const r of cfg.routes) {
    const strategy = parseStrategy(r.strategy);
    lb.addRoute(r.prefix, r.backends, strategy);
  }

  lb.startHealthChecks(5000, '/health');

  const admin = new AdminHandler(lb);
  const proxied = rateLimitMiddleware(rl, (req, res) => lb.handle(req, res));

  const server = http.createServer(async (req, res) => {
    const path = req.url.split('?')[0];

    if (path === '/metrics') {
      res.writeHead(200, { 'Content-Type': register.contentType });
      res.end(await register.metrics());
      return;
    }

    if (path.startsWith('/admin/')) {
      admin.handle(req, res);
      return;
    }

    proxied(req, res);
  });

  server.listen(PORT, () => {
    console.log(`Load Balancer started at :${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
