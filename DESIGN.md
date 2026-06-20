# Design Notes

This document explains the architecture, the trade-offs behind it, the failure
model, and how the system would scale. It's meant to make the *why* explicit,
not just the *what*.

## 1. Goals and non-goals

**Goals**
- A correct, observable HTTP reverse-proxy load balancer.
- Pluggable balancing strategies.
- Resilience: a single failing backend must not surface as client-visible
  errors.
- First-class metrics and structured logs.
- Runtime reconfiguration without a restart.

**Non-goals (deliberately out of scope)**
- TLS termination (would sit in front, or be added at the listener).
- Layer-4 / TCP balancing — this is an L7 (HTTP) balancer.
- Distributed/clustered coordination of state (discussed in §7).

## 2. Request lifecycle

```
client → rate limiter → route match (Trie) → strategy pick → circuit-breaker gate
       → proxy.web(target)  ──success──→ relay response, record latency (EWMA)
                            ──conn err──→ record failure, fail over to next backend
```

1. **Rate limiting** (per client IP, token bucket) runs first so abusive
   clients are shed before any routing work.
2. **Route matching** uses a path-segment Trie for longest-prefix match.
3. **Backend selection** applies the route's strategy over backends that are
   both health-check-alive and not ejected by their circuit breaker.
4. **Proxying** streams through `http-proxy` over a pooled keep-alive agent.
5. On a connection-level failure of an **idempotent** request, the balancer
   **fails over** to the next backend (bounded retries).

## 3. Key data-structure & algorithm choices

### Trie for routing
Routes are matched by longest registered prefix. A segment Trie gives O(path
segments) matching independent of the number of routes, and makes
longest-prefix resolution natural (keep walking; the deepest `isEnd` wins).
A flat list would be O(routes × segments) per request.

### Balancing strategies
- `round_robin` — counter modulo pool size.
- `weighted_round_robin` — **smooth** WRR (nginx's algorithm): each pick adds
  `weight` to a running `currentWeight`, the max is chosen and decremented by the
  total weight. This spreads picks evenly *over time* (e.g. `A A B A A A B A` for
  3:1) instead of bursty (`A A A B`).
- `least_active` / `least_connections` — fewest in-flight requests.
- `least_latency` — lowest EWMA latency.
- `least_loaded` — `activeRequests + avgLatency/100`, blending concurrency and
  speed.
- `ip_hash` — FNV-1a hash of the client IP for session affinity, with probing
  to skip unavailable backends.

- `p2c` — **power of two choices**: sample two backends at random, pick the less
  loaded. Mitzenmacher's result is that two random probes give load
  *exponentially* closer to optimal than one, while a full least-loaded scan has
  a known failure mode at scale — the "herd effect", where every chooser sees the
  same momentarily-best backend and stampedes it. P2C's randomness breaks that.
  O(1) per pick, and a strong general-purpose default (it's Envoy's `LEAST_REQUEST`).

### EWMA latency (not a lifetime average)
Latency feeds `least_latency`, `least_loaded`, and `p2c`. A naive cumulative
average (`totalLatency / totalRequests`) never forgets: a backend that was briefly
slow at startup stays "slow" forever and a backend that degrades later is masked
by a long good history. We use an exponentially weighted moving average
(`α = 0.3`) so recent samples dominate and old ones decay — the metric tracks
*current* behaviour, which is what a routing decision needs.

## 4. Resilience model

Two independent mechanisms detect bad backends:

| Mechanism | Signal | Effect |
|-----------|--------|--------|
| **Active health checks** | periodic `GET /health` | flips `alive` flag |
| **Circuit breaker** (passive) | real request failures / 5xx | ejects backend from selection |

**Why both?** Active checks catch a backend that's down *before* a user hits it,
but they're coarse (one probe every few seconds) and only test `/health`, not
real traffic. The circuit breaker reacts to *actual* request outcomes within a
single request and ejects a backend that's failing in-band, then probes for
recovery via a half-open state. Together: proactive + reactive.

**Circuit breaker** is a 3-state machine per backend:
`closed → (N consecutive failures) → open → (cooldown) → half-open →
(successes) → closed`, with any half-open failure re-opening it. This is classic
outlier ejection.

**Failover / retries.** A connection-level failure (refused/reset/timeout) on an
**idempotent** method (GET/HEAD/PUT/DELETE/OPTIONS) is retried on the next
backend, up to a bound. Non-idempotent methods (POST/PATCH) are **not** retried
— retrying them could duplicate side effects. This is the same stance as nginx's
`proxy_next_upstream` defaults. The benchmark confirms it: with 1 of 3 backends
killed, **0 requests fail**.

**Upstream timeout.** `proxyTimeout` bounds how long we wait on a backend so a
hung upstream fails over instead of hanging the client.

**Hedged requests (tail-latency mitigation).** Failover only helps when a backend
*errors*. A backend that's merely *slow* still drags the tail. For routes with
`hedgeDelayMs` set, if the chosen backend hasn't responded within that delay, a
backup request is fired to a second backend and the first response wins (the
loser is aborted). This is the core idea of Dean & Barroso's *"The Tail at
Scale"*. The benchmark shows p99 dropping ~48% (95 → 49 ms) with one slow backend
in the pool.

Trade-offs, made explicit:
- It costs extra work — the slow primary's request is still in flight when the
  backup fires, so p50 rises slightly. Hedging optimizes the *tail*, not the
  median; the `hedgeDelayMs` knob (ideally set near the route's p95) bounds how
  much duplicate load you take.
- Only **body-less idempotent reads** (GET/HEAD) are hedged — you can't safely
  duplicate a request with a body or side effects. This is implemented on a raw
  `http` path (the proxy library pipes straight to the client, which can't race
  two upstreams), reusing the same keep-alive agent and metrics.

### Preventing cascading failure

Resilience mechanisms can themselves *cause* outages if they amplify load. Two
guards address that:

**Retry budget.** Retries are great until a backend wobble makes *everything*
retry at once — now the fleet sees 2× traffic exactly when it's least able to
cope, and the failure cascades. So retries draw from a budget: a token bucket
where each request deposits `ratio` tokens (default 0.2) plus a `minPerSec` floor,
and each retry withdraws one. Retries are essentially free when rare, but globally
capped at ~20% of traffic — a wobble can't become a storm. Same design as
Envoy/Finagle retry budgets, and strictly better than a fixed per-request retry
count, which has no global ceiling.

**Adaptive concurrency / load shedding.** Under overload, the worst outcome is a
*brownout*: unbounded queues where every request times out and nothing succeeds.
Better to serve what you can and reject the rest fast. The limiter derives a
max-in-flight from observed latency using a gradient algorithm (Netflix
concurrency-limits / TCP Vegas):

> `gradient = minRTT / recentRTT` (1.0 = no queueing, < 1 = congestion)
> `newLimit = limit × gradient + √limit` (smoothed)

When latency inflates above the no-load baseline (`minRTT`), the gradient drops
and the limit shrinks, shedding excess with a fast `503 + Retry-After`; when
healthy, it grows back. It needs no hand-tuned magic number — it discovers the
backend's real capacity. The benchmark shows p99 under 200-connection overload
dropping from **651 ms (brownout) to 104 ms** while shedding the excess. Load
shedding sits in front of the balancer and is opt-in (`ADAPTIVE_CONCURRENCY`).

## 5. Consistency / correctness model

All shared state (rate-limiter buckets, backend counters, breaker state) lives
**in-process**. Node executes JS on a single thread, so there are no data races
on these counters — increments are atomic by virtue of the event loop. This is a
deliberate simplification that holds **only for a single process** (see §7 for
what changes when you scale out).

The response wrapper intercepts `writeHead`/`write`/`end` to capture status code
and byte count without buffering the body, so metrics are exact and streaming is
preserved.

## 6. Observability

- **Metrics**: route- and backend-level Prometheus series (requests, latency
  histograms, active gauges, errors, health, selection counts, load score) plus
  Node runtime metrics. This is what makes strategy behaviour and failures
  *visible* rather than guessed at.
- **Logs**: structured JSON, one object per line, with a per-request UUID for
  correlation. Level-gated (`LOG_LEVEL`) — per-request INFO logging is a
  throughput footgun under load, so it can be turned down.

## 7. Scaling

### 7.1 Multi-core (implemented)

`src/cluster.js` forks one worker per CPU behind a shared listen socket (OS
round-robin on Linux, shared handle on Windows) and restarts dead workers.

**The state-divergence problem.** Each worker is a separate process with its own
memory, so anything held in-process diverges:

- **Rate limiting** — a client capped at 10 gets `10 × workers` through, because
  the OS spreads its connections across independent per-worker buckets.
  Measured on a 2-worker cluster (30 concurrent requests, burst 10): **20
  allowed** with the in-memory limiter vs **10 allowed** with the Redis limiter.
  *Fix (implemented):* set `REDIS_URL` and the limiter runs an **atomic Lua
  token bucket** in Redis — refill, consume, and TTL eviction in one script, so
  there's no read-modify-write race between workers. One global budget.
- **Circuit breaker / health** — left **per-worker on purpose**. Each worker
  independently learning a backend is bad is acceptable (and converges quickly);
  coordinating it would add cost for little benefit. A reasonable trade-off to be
  able to defend, not an oversight.
- **Metrics** — each worker has partial counts. The primary gathers every
  worker's metrics over IPC and merges them (`AggregatorRegistry.aggregate`,
  which sums same-named series) into one endpoint, instead of N fragmented views.

**Fail-open vs fail-closed.** On a Redis error the rate limiter fails *open*
(allows the request). For rate limiting, keeping real traffic flowing usually
beats strict enforcement during a Redis blip; a security-critical limiter might
choose to fail closed. It's a config flag.

### 7.2 Horizontal (next)

Multiple hosts behind a Layer-4 balancer (or DNS). The same Redis gives a global
rate-limit budget across hosts, not just across local workers. Health and config
then need a shared source of truth — a control plane pushing config or a
service-discovery backend (Consul/etcd) instead of a static `routes.json`.

### 7.3 Config (next)

Config is static at boot + mutable via the admin API, but changes aren't
persisted. Next step is hot-reload from a watched file or a config service, with
schema validation on load (the Envoy xDS pattern).

## 8. Security posture

- **Control/data plane split**: the admin API runs on a **separate port** from
  proxied traffic and is **token-gated** (`ADMIN_TOKEN`). You don't want the
  endpoint that can re-route all traffic sharing the public listener.
- `X-Forwarded-For` is appended (`xfwd`). In a real deployment you'd only trust
  it from known upstream proxies.

## 9. Known limitations / honest gaps

- Retries re-pipe the original request; bodies aren't buffered, so failover is
  meaningful mainly for connection-time failures (the common case). Buffering to
  retry mid-stream body uploads is intentionally not done.
- Half-open breaker state allows multiple concurrent trial requests rather than
  strictly one.
- Circuit-breaker and health state are per-worker in cluster mode (deliberate;
  see §7.1), so each worker learns backend health independently.
- Benchmarks are single-host loopback (no network), so they measure CPU/proxy
  overhead, not real-network latency.
