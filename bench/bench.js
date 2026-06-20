// Reproducible load benchmark.
//
// Throughput / overhead:
//   1. baseline  - autocannon hitting a single backend directly
//   2. via-lb    - same backend behind the load balancer (3 healthy backends)
//   3. degraded  - same, but 1 of 3 backends is dead (exercises failover)
//
// Tail latency (one slow backend in the pool):
//   4. plain     - round robin, no hedging  (slow backend drags p99 up)
//   5. hedged    - round robin + hedged requests (backup rescues the tail)
//
// Run: npm run bench
import os from 'node:os';
import http from 'node:http';
import autocannon from 'autocannon';
import { start } from '../src/server.js';
import { setLevel } from '../src/logger/logger.js';

setLevel('silent'); // don't let per-request logging skew throughput

const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS || 50);
const DURATION = Number(process.env.BENCH_DURATION || 10);
const SLOW_MS = Number(process.env.BENCH_SLOW_MS || 80);
const HEDGE_MS = Number(process.env.BENCH_HEDGE_MS || 20);

function makeBackend(tag, delayMs = 0) {
  return http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (delayMs > 0) setTimeout(() => res.end(tag), delayMs);
    else res.end(tag);
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
  const failed = (r.non2xx || 0) + (r.errors || 0);
  return `${name.padEnd(14)} ${String(rps).padStart(9)} ${String(p50).padStart(9)} ${String(p99).padStart(9)} ${String(failed).padStart(8)}`;
}

async function main() {
  const fast = [makeBackend('A'), makeBackend('B'), makeBackend('C')];
  const slow = makeBackend('SLOW', SLOW_MS);
  const fastPorts = [];
  for (const b of fast) fastPorts.push(await listen(b));
  const slowPort = await listen(slow);

  const ctx = await start({
    port: 0,
    adminPort: 0,
    metrics: false,
    healthIntervalMs: 0,
    rate: 1e9,
    burst: 1e9, // don't let the rate limiter throttle the load test
    routes: [
      { prefix: '/svc', backends: fastPorts.map((p) => `http://127.0.0.1:${p}`) },
      { prefix: '/plain', backends: [`http://127.0.0.1:${fastPorts[0]}`, `http://127.0.0.1:${fastPorts[1]}`, `http://127.0.0.1:${slowPort}`] },
      { prefix: '/hedged', backends: [`http://127.0.0.1:${fastPorts[0]}`, `http://127.0.0.1:${fastPorts[1]}`, `http://127.0.0.1:${slowPort}`], hedgeDelayMs: HEDGE_MS },
    ],
  });

  const lb = ctx.ports.data;
  console.log(`\nEnvironment: Node ${process.version}, ${os.cpus()[0].model}, ${os.cpus().length} cores`);
  console.log(`Load: ${CONNECTIONS} connections x ${DURATION}s per scenario\n`);

  const baseline = await run('baseline', `http://127.0.0.1:${fastPorts[0]}/`);
  const vialb = await run('via-lb', `http://127.0.0.1:${lb}/svc`);

  // Tail latency: one slow (SLOW_MS) backend in the pool.
  const plain = await run('tail-plain', `http://127.0.0.1:${lb}/plain`);
  const hedged = await run('tail-hedged', `http://127.0.0.1:${lb}/hedged`);

  // Degraded: kill a healthy backend, then drive /svc.
  await close(fast[1]);
  const degraded = await run('degraded', `http://127.0.0.1:${lb}/svc`);

  console.log('\nThroughput / overhead');
  console.log('Scenario          req/sec  p50 (ms)  p99 (ms)   failed');
  console.log('-------------------------------------------------------------');
  console.log(row('baseline', baseline));
  console.log(row('via-lb', vialb));
  console.log(row('degraded', degraded));
  console.log(`Proxy overhead: ${((1 - vialb.requests.average / baseline.requests.average) * 100).toFixed(1)}%   ` +
    `failover failures (1/3 down): ${(degraded.non2xx || 0) + (degraded.errors || 0)}`);

  console.log(`\nTail latency (one ${SLOW_MS}ms backend in a 3-backend pool, hedge after ${HEDGE_MS}ms)`);
  console.log('Scenario          req/sec  p50 (ms)  p99 (ms)   failed');
  console.log('-------------------------------------------------------------');
  console.log(row('no hedge', plain));
  console.log(row('hedged', hedged));
  console.log(`p99 reduction from hedging: ${((1 - hedged.latency.p99 / plain.latency.p99) * 100).toFixed(1)}%\n`);

  await ctx.stop();
  await Promise.all([...fast, slow].map(close));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
