// Live dashboard web service.
//
// One process that:
//   - boots the REAL load balancer + a set of mock backends in-memory,
//   - serves a single-page UI on $PORT (default 3000),
//   - on "Start Test", fires real traffic THROUGH the proxy and streams live
//     throughput / latency / per-backend stats to the browser over SSE,
//   - lets you kill/revive backends and switch strategy live and watch it react.
//
// Run: npm run dashboard   (then open http://localhost:3000)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { start } from './server.js';
import { setLevel } from './logger/logger.js';

setLevel('silent'); // don't flood logs during load tests

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, '..', 'public', 'dashboard.html');
const PORT = Number(process.env.PORT || 3000);
const WORKERS = Number(process.env.DASH_WORKERS || 24);

// Backends with different base latencies so latency-aware strategies differ and
// there's an obviously "slow" one to watch.
const BACKEND_DEFS = [
  { id: 'A', label: 'backend-A (fast)', latency: 4 },
  { id: 'B', label: 'backend-B', latency: 12 },
  { id: 'C', label: 'backend-C', latency: 22 },
  { id: 'D', label: 'backend-D (slow)', latency: 45 },
];

function makeBackend(def) {
  let dead = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(dead ? 503 : 200);
      res.end();
      return;
    }
    if (dead) {
      res.socket.destroy(); // simulate a crashed/unreachable instance
      return;
    }
    setTimeout(() => {
      res.setHeader('x-backend', def.id);
      res.end(def.id);
    }, def.latency);
  });
  return {
    server,
    get dead() {
      return dead;
    },
    setDead(v) {
      dead = v;
    },
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));
}
const round = (n) => Math.round(n * 10) / 10;

async function main() {
  // --- boot backends ---
  const ctrls = new Map(); // id -> control
  const urlToId = new Map(); // backend origin -> id
  const routeBackends = [];
  for (const def of BACKEND_DEFS) {
    const ctrl = makeBackend(def);
    const port = await listen(ctrl.server);
    ctrls.set(def.id, ctrl);
    const url = `http://127.0.0.1:${port}`;
    urlToId.set(url, def.id);
    routeBackends.push(url);
  }

  // --- boot the real load balancer ---
  const ctx = await start({
    port: 0,
    adminPort: 0,
    metrics: false,
    healthIntervalMs: 1000,
    rate: 1e9,
    burst: 1e9, // don't let rate limiting interfere with the load test
    breakerOptions: { failureThreshold: 3, cooldownMs: 3000, successThreshold: 2 },
    routes: [{ prefix: '/api', backends: routeBackends, strategy: 'round_robin' }],
  });
  const TARGET = `http://127.0.0.1:${ctx.ports.data}/api/req`;
  const pool = ctx.lb.routes.get('/api');

  // --- live state ---
  const state = {
    running: false,
    startedAt: 0,
    strategy: 'round_robin',
    totals: { ok: 0, failed: 0, total: 0 },
    byBackend: {}, // id -> cumulative served (lifetime total)
    tick: { count: 0, lat: [], byBackend: {} },
    recentWindow: [], // last N ticks of per-backend counts -> live traffic share
    series: { rps: [], p50: [], p99: [] },
    events: [],
  };
  const SHARE_WINDOW = 6; // ticks (~3s) the live distribution is averaged over
  const labelOf = (id) => BACKEND_DEFS.find((d) => d.id === id)?.label || id;

  function addEvent(msg, kind = 'info') {
    state.events.push({ msg, kind, ts: Date.now() });
    if (state.events.length > 60) state.events.shift();
  }

  // --- load test workers ---
  async function worker() {
    while (state.running) {
      const t0 = performance.now();
      try {
        const r = await fetch(TARGET);
        const body = await r.text();
        const dt = performance.now() - t0;
        state.tick.count += 1;
        state.tick.lat.push(dt);
        state.totals.total += 1;
        if (r.ok) {
          state.totals.ok += 1;
          const id = r.headers.get('x-backend') || body.trim();
          state.byBackend[id] = (state.byBackend[id] || 0) + 1;
          state.tick.byBackend[id] = (state.tick.byBackend[id] || 0) + 1;
        } else {
          state.totals.failed += 1;
        }
      } catch {
        state.tick.count += 1;
        state.totals.total += 1;
        state.totals.failed += 1;
      }
    }
  }
  function startTest() {
    if (state.running) return;
    state.running = true;
    state.startedAt = Date.now();
    state.totals = { ok: 0, failed: 0, total: 0 };
    state.byBackend = {};
    state.recentWindow = [];
    state.tick = { count: 0, lat: [], byBackend: {} };
    state.series = { rps: [], p50: [], p99: [] };
    addEvent(`Load test started — ${WORKERS} workers`, 'good');
    for (let i = 0; i < WORKERS; i += 1) worker();
  }
  function stopTest() {
    if (!state.running) return;
    state.running = false;
    addEvent('Load test stopped', 'info');
  }
  function toggleBackend(id) {
    const c = ctrls.get(id);
    if (!c) return;
    c.setDead(!c.dead);
    addEvent(c.dead ? `Killed ${labelOf(id)}` : `Revived ${labelOf(id)}`, c.dead ? 'bad' : 'good');
  }
  function setStrategy(strategy) {
    try {
      ctx.lb.updateRoute('/api', null, strategy);
      state.strategy = pool.strategy;
      addEvent(`Strategy changed to "${state.strategy}"`, 'info');
    } catch {
      /* ignore invalid */
    }
  }

  // --- SSE clients ---
  const clients = new Set();
  function broadcast(obj) {
    const data = `data: ${JSON.stringify(obj)}\n\n`;
    for (const res of clients) res.write(data);
  }

  function snapshot() {
    // Live traffic share over the recent window (+ the current partial tick),
    // so the bars reflect what the balancer is routing *now*, not lifetime totals.
    const recent = {};
    let recentTotal = 0;
    for (const m of state.recentWindow) {
      for (const k in m) { recent[k] = (recent[k] || 0) + m[k]; recentTotal += m[k]; }
    }
    for (const k in state.tick.byBackend) {
      recent[k] = (recent[k] || 0) + state.tick.byBackend[k]; recentTotal += state.tick.byBackend[k];
    }
    recentTotal = recentTotal || 1;
    const backends = pool.backends.map((b) => {
      const id = urlToId.get(b.target) || b.host;
      return {
        id,
        label: labelOf(id),
        dead: ctrls.get(id)?.dead ?? false,
        alive: b.isAlive(),
        breaker: b.breaker.state,
        active: b.activeRequests(),
        latency: round(b.avgLatency()),
        served: state.byBackend[id] || 0,
        share: Math.round(((recent[id] || 0) / recentTotal) * 100),
      };
    });
    const successPct = state.totals.total ? (state.totals.ok / state.totals.total) * 100 : 100;
    return {
      running: state.running,
      strategy: state.strategy,
      workers: WORKERS,
      elapsed: state.running ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
      totals: state.totals,
      successPct: round(successPct),
      rps: state.series.rps.at(-1) || 0,
      p50: state.series.p50.at(-1) || 0,
      p99: state.series.p99.at(-1) || 0,
      series: state.series,
      backends,
      events: state.events.slice(-25),
    };
  }

  // --- ticker: compute per-interval stats + detect breaker transitions ---
  const INTERVAL = 500;
  const prevState = {};
  setInterval(() => {
    const { count, lat } = state.tick;
    const rps = Math.round(count / (INTERVAL / 1000));
    lat.sort((a, b) => a - b);
    const pct = (q) => (lat.length ? round(lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]) : 0);
    state.series.rps.push(rps);
    state.series.p50.push(pct(0.5));
    state.series.p99.push(pct(0.99));
    for (const k of Object.keys(state.series)) {
      if (state.series[k].length > 120) state.series[k].shift();
    }
    state.recentWindow.push(state.tick.byBackend);
    if (state.recentWindow.length > SHARE_WINDOW) state.recentWindow.shift();
    state.tick = { count: 0, lat: [], byBackend: {} };

    for (const b of pool.backends) {
      const id = urlToId.get(b.target) || b.host;
      const cur = `${b.isAlive() ? 'up' : 'down'}/${b.breaker.state}`;
      if (prevState[id] && prevState[id] !== cur) {
        const opened = b.breaker.state === 'open';
        const recovered = prevState[id].includes('open') && b.breaker.state === 'closed';
        addEvent(
          `${labelOf(id)}: ${prevState[id]} → ${cur}`,
          opened ? 'bad' : recovered ? 'good' : 'info'
        );
      }
      prevState[id] = cur;
    }
    broadcast(snapshot());
  }, INTERVAL).unref();

  // --- HTTP server (UI + control API + SSE) ---
  const html = await readFile(HTML_PATH, 'utf8');
  const readBody = (req) =>
    new Promise((resolve) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(d || '{}'));
        } catch {
          resolve({});
        }
      });
    });
  const json = (res, obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer(async (req, res) => {
    const path = req.url.split('?')[0];

    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && path === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && path === '/api/test/start') {
      startTest();
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/test/stop') {
      stopTest();
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && path === '/api/strategy') {
      const b = await readBody(req);
      setStrategy(b.strategy);
      return json(res, { ok: true, strategy: state.strategy });
    }
    const m = path.match(/^\/api\/backend\/([A-Z])\/toggle$/);
    if (req.method === 'POST' && m) {
      toggleBackend(m[1]);
      return json(res, { ok: true });
    }
    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PORT, () => {
    console.log(`\n  Load Balancer dashboard:  http://localhost:${PORT}`);
    console.log(`  (proxy running internally on :${ctx.ports.data}, ${BACKEND_DEFS.length} backends)\n`);
  });

  const shutdown = async () => {
    stopTest();
    server.close();
    await ctx.stop();
    for (const c of ctrls.values()) c.server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
