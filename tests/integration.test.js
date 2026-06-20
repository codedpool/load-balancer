import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { start } from '../src/server.js';

// --- helpers -------------------------------------------------------------

function makeBackend(tag) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200);
      res.end();
      return;
    }
    res.end(tag);
  });
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function request(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// --- shared fixture ------------------------------------------------------

const backends = [];
let ctx;

before(async () => {
  const a = makeBackend('A');
  const b = makeBackend('B');
  const pa = await listen(a);
  const pb = await listen(b);
  backends.push(a, b);

  // A third backend port that is NOT listening -> connection refused.
  const dead = makeBackend('DEAD');
  const pDead = await listen(dead);
  await close(dead); // free the port so connections are refused

  ctx = await start({
    port: 0,
    adminPort: 0,
    metrics: false,
    healthIntervalMs: 0, // no active checks; deterministic
    burst: 1000, // don't let rate limiting interfere
    adminToken: 'secret',
    maxRetries: 2,
    routes: [
      { prefix: '/svc', backends: [`http://127.0.0.1:${pa}`, `http://127.0.0.1:${pb}`] },
      // dead backend alongside a live one -> failover should hide the dead one
      { prefix: '/ha', backends: [`http://127.0.0.1:${pDead}`, `http://127.0.0.1:${pa}`] },
      // only-dead route -> nowhere to fail over to
      { prefix: '/dead', backends: [`http://127.0.0.1:${pDead}`] },
    ],
  });
});

after(async () => {
  if (ctx) await ctx.stop();
  await Promise.all(backends.map(close));
});

// --- tests ---------------------------------------------------------------

test('routes a request to a backend', async () => {
  const res = await request(ctx.ports.data, '/svc/anything');
  assert.equal(res.status, 200);
  assert.ok(['A', 'B'].includes(res.body));
});

test('distributes across both backends (round robin)', async () => {
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    const res = await request(ctx.ports.data, '/svc/x');
    seen.add(res.body);
  }
  assert.deepEqual([...seen].sort(), ['A', 'B']);
});

test('fails over past a dead backend (no 5xx leaks to client)', async () => {
  // Route /ha has a refused backend + a live one. Every request must succeed
  // via failover, regardless of which backend round robin picks first.
  for (let i = 0; i < 8; i++) {
    const res = await request(ctx.ports.data, '/ha/x');
    assert.equal(res.status, 200, `request ${i} should succeed via failover`);
    assert.equal(res.body, 'A');
  }
});

test('returns 404 for an unknown route', async () => {
  const res = await request(ctx.ports.data, '/nope');
  assert.equal(res.status, 404);
});

test('admin API rejects requests without the token', async () => {
  const res = await request(ctx.ports.admin, '/admin/list');
  assert.equal(res.status, 401);
});

test('admin API serves routes with a valid token', async () => {
  const res = await request(ctx.ports.admin, '/admin/list', {
    headers: { 'x-admin-token': 'secret' },
  });
  assert.equal(res.status, 200);
  const routes = JSON.parse(res.body);
  assert.ok(Array.isArray(routes));
  assert.ok(routes.some((r) => r.prefix === '/svc'));
});

test('non-idempotent POST is not retried (dead backend -> 502)', async () => {
  // A POST hits the dead backend once and must not fail over (could duplicate
  // side effects), so the client gets a 502.
  const res = await request(ctx.ports.data, '/dead/x', { method: 'POST' });
  assert.equal(res.status, 502);
});

test('idempotent GET attempts failover, then 503 when nothing is reachable', async () => {
  // GET retries, but the only backend is dead, so it exhausts and returns 503.
  const res = await request(ctx.ports.data, '/dead/x', { method: 'GET' });
  assert.equal(res.status, 503);
});
