// Prometheus metrics. prom-client auto-registers each metric on the default
// registry at construction time, so importing this module is enough to make
// them collectable; initMetrics() additionally turns on Node process metrics.
import client from 'prom-client';

export const register = client.register;

const latencyBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// ===== ROUTE-LEVEL METRICS =====

export const RouteRequestsTotal = new client.Counter({
  name: 'lb_route_requests_total',
  help: 'Total number of requests received per route and HTTP method',
  labelNames: ['route', 'method', 'status_code'],
});

export const RouteRequestDuration = new client.Histogram({
  name: 'lb_route_request_duration_seconds',
  help: 'Request latency distribution per route',
  buckets: latencyBuckets,
  labelNames: ['route', 'method'],
});

export const RouteActiveRequests = new client.Gauge({
  name: 'lb_route_active_requests',
  help: 'Current number of active requests being processed per route',
  labelNames: ['route'],
});

export const RouteErrorsTotal = new client.Counter({
  name: 'lb_route_errors_total',
  help: 'Total number of errors per route and error type',
  labelNames: ['route', 'error_type'],
});

export const RouteRequestSize = new client.Histogram({
  name: 'lb_route_request_size_bytes',
  help: 'Size of HTTP requests per route',
  buckets: [100, 1000, 10000, 100000, 1000000],
  labelNames: ['route'],
});

export const RouteResponseSize = new client.Histogram({
  name: 'lb_route_response_size_bytes',
  help: 'Size of HTTP responses per route',
  buckets: [100, 1000, 10000, 100000, 1000000, 10000000],
  labelNames: ['route'],
});

export const RouteStrategyChanges = new client.Counter({
  name: 'lb_route_strategy_changes_total',
  help: 'Number of times load balancing strategy was changed per route',
  labelNames: ['route', 'from_strategy', 'to_strategy'],
});

export const RouteHedgedRequests = new client.Counter({
  name: 'lb_route_hedged_requests_total',
  help: 'Number of requests for which a hedge (backup) request was fired',
  labelNames: ['route'],
});

export const RouteHedgeWins = new client.Counter({
  name: 'lb_route_hedge_wins_total',
  help: 'Number of requests where the hedge (backup) backend responded first',
  labelNames: ['route'],
});

// ===== CASCADING-FAILURE PREVENTION =====

export const RetriesTotal = new client.Counter({
  name: 'lb_retries_total',
  help: 'Total number of retry attempts (failover to another backend)',
  labelNames: ['route'],
});

export const RetriesExhausted = new client.Counter({
  name: 'lb_retries_exhausted_total',
  help: 'Retries denied because the retry budget was exhausted',
  labelNames: ['route'],
});

export const ConcurrencyLimit = new client.Gauge({
  name: 'lb_concurrency_limit',
  help: 'Current adaptive concurrency limit (max in-flight before shedding)',
});

export const InflightRequests = new client.Gauge({
  name: 'lb_inflight_requests',
  help: 'Current number of in-flight requests counted against the concurrency limit',
});

export const ShedTotal = new client.Counter({
  name: 'lb_shed_requests_total',
  help: 'Total number of requests shed (503) due to the concurrency limit',
});

// ===== BACKEND-LEVEL METRICS =====

export const BackendHealthStatus = new client.Gauge({
  name: 'lb_backend_health_status',
  help: 'Backend health status (1 = healthy, 0 = unhealthy)',
  labelNames: ['route', 'backend', 'backend_host'],
});

export const BackendRequestsTotal = new client.Counter({
  name: 'lb_backend_requests_total',
  help: 'Total number of requests sent to each backend',
  labelNames: ['route', 'backend', 'backend_host', 'status_code'],
});

export const BackendRequestDuration = new client.Histogram({
  name: 'lb_backend_request_duration_seconds',
  help: 'Request latency distribution per backend',
  buckets: latencyBuckets,
  labelNames: ['route', 'backend', 'backend_host'],
});

export const BackendActiveConnections = new client.Gauge({
  name: 'lb_backend_active_connections',
  help: 'Current number of active connections to each backend',
  labelNames: ['route', 'backend', 'backend_host'],
});

export const BackendFailuresTotal = new client.Counter({
  name: 'lb_backend_failures_total',
  help: 'Total number of backend failures by failure type',
  labelNames: ['route', 'backend', 'backend_host', 'failure_type'],
});

export const BackendSelectionTotal = new client.Counter({
  name: 'lb_backend_selection_total',
  help: 'Number of times each backend was selected by load balancing strategy',
  labelNames: ['route', 'backend', 'backend_host', 'strategy'],
});

export const BackendHealthCheckDuration = new client.Histogram({
  name: 'lb_backend_health_check_duration_seconds',
  help: 'Duration of health checks per backend',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  labelNames: ['route', 'backend', 'backend_host'],
});

export const BackendHealthCheckFailures = new client.Counter({
  name: 'lb_backend_health_check_failures_total',
  help: 'Total number of health check failures per backend',
  labelNames: ['route', 'backend', 'backend_host'],
});

export const BackendLoadScore = new client.Gauge({
  name: 'lb_backend_load_score',
  help: 'Current load score of each backend (used by least-loaded strategy)',
  labelNames: ['route', 'backend', 'backend_host'],
});

export function initMetrics() {
  // Expose Node.js process/runtime metrics alongside the load balancer's own.
  client.collectDefaultMetrics();
}
