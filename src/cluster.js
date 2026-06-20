// Multi-core entry point: forks one worker per CPU (override with WORKERS).
//
// Each worker runs the full data + control plane; the OS load-balances incoming
// connections across the shared listen socket (round-robin on Linux, shared on
// Windows). In-process state therefore diverges per worker — which is exactly
// why rate limiting must move to a shared store (set REDIS_URL); see DESIGN.md.
//
// Per-worker metric fragmentation is solved by having the PRIMARY gather every
// worker's metrics over IPC and merge them (prom-client's AggregatorRegistry
// sums same-named series) into one endpoint on METRICS_PORT.
import cluster from 'node:cluster';
import os from 'node:os';
import http from 'node:http';
import client from 'prom-client';

const WORKERS = Number(process.env.WORKERS || os.cpus().length);
const METRICS_PORT = Number(process.env.METRICS_PORT || 9100);

if (cluster.isPrimary) {
  console.log(`Primary ${process.pid} starting ${WORKERS} workers`);
  for (let i = 0; i < WORKERS; i++) {
    cluster.fork();
  }

  let shuttingDown = false;
  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) return;
    console.warn(`Worker ${worker.process.pid} died (${signal || code}); restarting`);
    cluster.fork();
  });

  // Ask each worker for its metrics over IPC, then merge.
  let requestId = 0;
  function gatherWorkerMetrics(timeoutMs = 3000) {
    return new Promise((resolve) => {
      const id = ++requestId;
      const workers = Object.values(cluster.workers);
      if (workers.length === 0) return resolve([]);

      const results = [];
      let pending = workers.length;
      const onMessage = (worker, msg) => {
        if (msg && msg.type === 'metrics' && msg.id === id) {
          results.push(msg.data);
          if (--pending === 0) {
            clearTimeout(timer);
            cluster.off('message', onMessage);
            resolve(results);
          }
        }
      };
      const timer = setTimeout(() => {
        cluster.off('message', onMessage);
        resolve(results); // partial result rather than hang
      }, timeoutMs);

      cluster.on('message', onMessage);
      for (const worker of workers) {
        worker.send({ type: 'collect-metrics', id });
      }
    });
  }

  const metricsServer = http.createServer(async (req, res) => {
    if (req.url.split('?')[0] !== '/metrics') {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const perWorker = await gatherWorkerMetrics();
      const merged = client.AggregatorRegistry.aggregate(perWorker);
      res.writeHead(200, { 'Content-Type': merged.contentType });
      res.end(await merged.metrics());
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  metricsServer.listen(METRICS_PORT, () => {
    console.log(`Aggregated metrics on :${METRICS_PORT}/metrics`);
  });

  const shutdown = () => {
    shuttingDown = true;
    console.log('\nPrimary shutting down workers...');
    for (const worker of Object.values(cluster.workers)) {
      worker.kill('SIGTERM');
    }
    metricsServer.close();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else {
  const [{ start }, { register }] = await Promise.all([
    import('./server.js'),
    import('./core/metrics.js'),
  ]);
  // Workers collect metrics but don't serve the endpoint (the primary merges).
  const ctx = await start({ serveMetricsEndpoint: false });

  process.on('message', async (msg) => {
    if (msg && msg.type === 'collect-metrics') {
      process.send({ type: 'metrics', id: msg.id, data: await register.getMetricsAsJSON() });
    }
  });

  const shutdown = async () => {
    await ctx.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
