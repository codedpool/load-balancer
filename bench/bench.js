// Reproducible load benchmark: measures proxy overhead and failover resilience.
//
//   1. baseline   - autocannon hitting a single backend directly
//   2. via-lb     - same backend behind the load balancer (3 healthy backends)
//   3. degraded   - same, but 1 of 3 backends is dead (exercises failover)
//
// Run: npm run bench
import os from 'node:os';
import http from 'node:http';
import autocannon from 'autocannon';
import { start } from '../src/server.js';
import { setLevel } from '../src/logger/logger.js';

// Don't let synchronous per-request logging skew the throughput numbers.
setLevel('silent');

const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS || 50);
const DURATION = Number(process.env.BENCH_DURATION || 10);

function makeBackend(tag) {
  return http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end();
      return;
    }
    res.end(tag);
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function run(title, url) {
  return autocannon({ url, connections: CONNECTIONS, duration: DURATION, title });
}

function row(name, r) {
  const rps = r.requests.average.toFixed(0);
  const p50 = r.latency.p50.toFixed(2);
  const p99 = r.latency.p99.toFixed(2);
  const nonOk = (r.non2xx || 0) + (r.errors || 0);
  return `${name.padEnd(12)} ${String(rps).padStart(10)} ${String(p50).padStart(9)} ${String(p99).padStart(9)} ${String(nonOk).padStart(10)}`;
}

async function main() {
  const backends = [makeBackend('A'), makeBackend('B'), makeBackend('C')];
  const ports = [];
  for (const b of backends) ports.push(await listen(b));

  // High rate/burst so the per-IP rate limiter doesn't throttle the load test.
  const ctx = await start({
    port: 0,
    adminPort: 0,
    metrics: false,
    healthIntervalMs: 0,
    rate: 1e9,
    burst: 1e9,
    routes: [{ prefix: '/svc', backends: ports.map((p) => `http://127.0.0.1:${p}`) }],
  });

  const directURL = `http://127.0.0.1:${ports[0]}/`;
  const lbURL = `http://127.0.0.1:${ctx.ports.data}/svc`;

  console.log(`\nEnvironment: Node ${process.version}, ${os.cpus()[0].model}, ${os.cpus().length} cores`);
  console.log(`Load: ${CONNECTIONS} connections x ${DURATION}s per scenario\n`);

  const baseline = await run('baseline (direct)', directURL);
  const vialb = await run('via load balancer', lbURL);

  // Degraded: kill one backend, then drive traffic through the LB.
  await close(backends[1]);
  const degraded = await run('1 of 3 backends down', lbURL);

  console.log('\nResults');
  console.log('Scenario          req/sec   p50 (ms)  p99 (ms)   failed');
  console.log('-----------------------------------------------------------');
  console.log(row('baseline', baseline));
  console.log(row('via-lb', vialb));
  console.log(row('degraded', degraded));

  const overhead = (1 - vialb.requests.average / baseline.requests.average) * 100;
  const addedP99 = vialb.latency.p99 - baseline.latency.p99;
  console.log('-----------------------------------------------------------');
  console.log(`Proxy throughput overhead: ${overhead.toFixed(1)}%`);
  console.log(`Added p99 latency:         ${addedP99.toFixed(2)} ms`);
  console.log(
    `Failover: ${(degraded.non2xx || 0) + (degraded.errors || 0)} failed requests with 1/3 backends down\n`
  );

  await ctx.stop();
  await Promise.all(backends.map(close));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
