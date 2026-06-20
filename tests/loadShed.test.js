import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { start } from '../src/server.js';

function slowBackend(delayMs) {
  return http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end();
      return;
    }
    setTimeout(() => res.end('OK'), delayMs);
  });
}
function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}
function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}
function get(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/svc/x' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
}

let backend;
let ctx;

before(async () => {
  backend = slowBackend(200);
  const port = await listen(backend);
  ctx = await start({
    port: 0,
    adminPort: 0,
    metrics: false,
    healthIntervalMs: 0,
    burst: 1000, // keep the rate limiter out of the way
    adaptiveConcurrency: true,
    concurrency: { initialLimit: 2, minLimit: 2, maxLimit: 2 }, // fixed limit of 2
    routes: [{ prefix: '/svc', backends: [`http://127.0.0.1:${port}`] }],
  });
});

after(async () => {
  if (ctx) await ctx.stop();
  await close(backend);
});

test('sheds excess concurrency with 503 instead of queuing', async () => {
  // 6 requests hit a slow backend at once; the limiter only admits 2.
  const statuses = await Promise.all(Array.from({ length: 6 }, () => get(ctx.ports.data)));
  const served = statuses.filter((s) => s === 200).length;
  const shed = statuses.filter((s) => s === 503).length;
  assert.equal(served, 2, `expected 2 served, got ${served} (${statuses.join(',')})`);
  assert.equal(shed, 4, `expected 4 shed, got ${shed} (${statuses.join(',')})`);
});
