import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { start } from '../src/server.js';

const SLOW_MS = 300;
const HEDGE_MS = 50;

function makeBackend(tag, delayMs = 0) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (delayMs > 0) {
      setTimeout(() => res.end(tag), delayMs);
    } else {
      res.end(tag);
    }
  });
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}
function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function timedGet(port, path) {
  const startedAt = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
        resolve({ status: res.statusCode, body, ms });
      });
    });
    req.on('error', reject);
  });
}

const servers = [];
let ctx;

before(async () => {
  const slow = makeBackend('SLOW', SLOW_MS);
  const fast = makeBackend('FAST', 0);
  const pSlow = await listen(slow);
  const pFast = await listen(fast);
  servers.push(slow, fast);

  ctx = await start({
    port: 0,
    adminPort: 0,
    metrics: false,
    healthIntervalMs: 0,
    burst: 1000,
    routes: [
      {
        prefix: '/h',
        backends: [`http://127.0.0.1:${pSlow}`, `http://127.0.0.1:${pFast}`],
        hedgeDelayMs: HEDGE_MS,
      },
    ],
  });
});

after(async () => {
  if (ctx) await ctx.stop();
  await Promise.all(servers.map(close));
});

test('hedging bounds tail latency when the primary is slow', async () => {
  // Round robin alternates primary between the slow and fast backend. Without
  // hedging, ~half the requests would take SLOW_MS (300ms). With hedging, a slow
  // primary is rescued by the backup after HEDGE_MS, so every request is fast.
  const latencies = [];
  for (let i = 0; i < 8; i++) {
    const res = await timedGet(ctx.ports.data, '/h/x');
    assert.equal(res.status, 200);
    latencies.push(res.ms);
  }
  const max = Math.max(...latencies);
  assert.ok(
    max < SLOW_MS - 50,
    `max latency ${max.toFixed(1)}ms should be well under the slow backend's ${SLOW_MS}ms`
  );
});
