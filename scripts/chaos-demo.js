// Chaos demo: drives steady traffic through the balancer, kills a backend
// mid-flight, then brings it back — printing a per-second timeline so you can
// watch failover + the circuit breaker keep success ~100% with no manual steps.
//
// Run: npm run demo:chaos
import http from 'node:http';
import { start } from '../src/server.js';
import { setLevel } from '../src/logger/logger.js';

setLevel('silent');

const WORKERS = 15;
const DURATION_MS = 6000;
const KILL_AT = 1500;
const REVIVE_AT = 3500;

// A backend with a "dead" toggle: when dead, /health fails and requests get
// their socket destroyed (simulating a crashed/unreachable instance) without
// any port churn, so kill/revive is clean and deterministic.
function makeBackend(tag) {
  let dead = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(dead ? 503 : 200);
      res.end();
      return;
    }
    if (dead) {
      res.socket.destroy();
      return;
    }
    res.end(tag);
  });
  return new Promise((resolve) =>
    server.listen(0, () => resolve({ server, setDead: (v) => (dead = v) }))
  );
}
function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}
function get(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/svc/x' }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const a = await makeBackend('A');
  const b = await makeBackend('B');
  const c = await makeBackend('C');
  const portA = a.server.address().port;
  const portB = b.server.address().port;
  const portC = c.server.address().port;

  const ctx = await start({
    port: 0,
    adminPort: 0,
    metrics: false,
    healthIntervalMs: 500,
    burst: 100000,
    breakerOptions: { failureThreshold: 5, cooldownMs: 1000, successThreshold: 2 },
    routes: [
      {
        prefix: '/svc',
        backends: [`http://127.0.0.1:${portA}`, `http://127.0.0.1:${portB}`, `http://127.0.0.1:${portC}`],
        strategy: 'round_robin',
      },
    ],
  });
  const lbPort = ctx.ports.data;

  let stop = false;
  let bucket = { ok: 0, fail: 0, tags: {} };
  const total = { ok: 0, fail: 0 };

  async function worker() {
    while (!stop) {
      const { status, body } = await get(lbPort);
      if (status === 200) {
        bucket.ok += 1;
        total.ok += 1;
        if (body) bucket.tags[body] = (bucket.tags[body] || 0) + 1;
      } else {
        bucket.fail += 1;
        total.fail += 1;
      }
    }
  }

  const breakerOf = (host) => {
    const route = ctx.lb.getRoutesInfo()[0];
    const be = route.backends.find((x) => x.url.endsWith(`:${host}`));
    return be ? `${be.alive ? 'up' : 'DOWN'}/${be.breaker}` : '?';
  };

  console.log('Chaos demo: 3 backends (A,B,C), 15 concurrent workers.\n');
  console.log('time  ok  fail   served (A/B/C)        backend B');
  console.log('----------------------------------------------------------');
  let t = 0;
  const ticker = setInterval(() => {
    t += 1;
    const tags = bucket.tags;
    const served = `${tags.A || 0}/${tags.B || 0}/${tags.C || 0}`;
    console.log(
      `${String(t).padStart(2)}s  ${String(bucket.ok).padStart(4)} ${String(bucket.fail).padStart(4)}   ${served.padEnd(20)}  ${breakerOf(portB)}`
    );
    bucket = { ok: 0, fail: 0, tags: {} };
  }, 1000);

  const workers = Array.from({ length: WORKERS }, worker);

  setTimeout(() => {
    console.log('   >> killing backend B');
    b.setDead(true);
  }, KILL_AT);
  setTimeout(() => {
    console.log('   >> reviving backend B');
    b.setDead(false);
  }, REVIVE_AT);

  await sleep(DURATION_MS);
  stop = true;
  clearInterval(ticker);
  await Promise.all(workers);

  const pct = ((total.ok / (total.ok + total.fail)) * 100).toFixed(2);
  console.log('----------------------------------------------------------');
  console.log(`Total: ${total.ok} ok, ${total.fail} failed -> ${pct}% success despite a backend dying mid-traffic.`);

  await ctx.stop();
  await Promise.all([close(a.server), close(b.server), close(c.server)]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
