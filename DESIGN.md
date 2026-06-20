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

### EWMA latency (not a lifetime average)
Latency feeds `least_latency` and `least_loaded`. A naive cumulative average
(`totalLatency / totalRequests`) never forgets: a backend that was briefly slow
at startup stays "slow" forever and a backend that degrades later is masked by a
long good history. We use an exponentially weighted moving average
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

## 7. Scaling story (what I'd do next)

This balancer is a single Node process. To scale:

1. **Vertical / multi-core**: run one instance per core behind the OS
   (`SO_REUSEPORT`) or `cluster`. The catch: **in-process state diverges** across
   workers — each would have its own rate-limiter buckets and breaker state.
   - Rate limiting → move to a shared store (Redis) with an atomic
     token-bucket Lua script, or accept per-worker limits (limit × workers).
   - Circuit-breaker / health → either per-worker (acceptable; each learns
     independently) or shared via a coordination channel.
2. **Horizontal**: multiple hosts behind a Layer-4 balancer (or DNS). Health and
   config need a shared source of truth — a control plane pushing config, or a
   service-discovery backend (Consul/etcd) instead of a static `routes.json`.
3. **Config**: today config is static at boot + mutable via the admin API, but
   changes aren't persisted. Next step is hot-reload from a watched file or a
   config service, with validation on load.

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
- Single-process state model (see §7).
- Benchmarks are single-host loopback (no network), so they measure CPU/proxy
  overhead, not real-network latency.
