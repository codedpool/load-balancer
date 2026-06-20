# Load Balancer

A high-performance HTTP load balancer written in Node.js with health checking, multiple load balancing strategies, Prometheus metrics, structured logging, and a runtime admin API.

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Load Balancing Strategies](#load-balancing-strategies)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Monitoring & Metrics](#monitoring--metrics)
- [Admin API](#admin-api)
- [Project Structure](#project-structure)
- [Usage Examples](#usage-examples)
- [License](#license)
- [Roadmap](#roadmap)

## Features

### Core Functionality
- Multiple load balancing strategies (Round Robin, Least Latency, Least Active, IP Hash)
- Active health checking with automatic failure/recovery detection
- HTTP reverse proxying (powered by `http-proxy`)
- Per-client token-bucket rate limiting
- Request/response size tracking

### Monitoring & Observability
- Prometheus metrics endpoint (`/metrics`)
- Grafana dashboard included as code
- Structured JSON logging with per-request correlation IDs
- Real-time health status and performance metrics (latency, throughput, error rates)

### Management
- HTTP admin API for runtime configuration
- Dynamic route and backend management without a restart

## Architecture

```
┌─────────────┐
│   Clients   │
└──────┬──────┘
       │
       v
┌─────────────────────────────────────┐
│      Load Balancer (Port 8080)      │
│  ┌───────────────────────────────┐  │
│  │   Route Matching (Trie) +     │  │
│  │   Strategy Selection          │  │
│  └───────────┬───────────────────┘  │
│              │                      │
│  ┌───────────v───────────────────┐  │
│  │     Health Check Manager      │  │
│  └───────────┬───────────────────┘  │
│              │                      │
│  ┌───────────v───────────────────┐  │
│  │      Metrics Collection       │  │
│  └───────────────────────────────┘  │
└──────────────────┬──────────────────┘
                   │
        ┌──────────┼───────────┐
        │          │           │
        v          v           v
    ┌────────┐ ┌────────┐ ┌────────┐
    │Backend1│ │Backend2│ │Backend3│
    └────────┘ └────────┘ └────────┘
```

Routes are matched by longest path prefix using a segment Trie. Each matched
route owns a pool of backends and a selection strategy.

## Load Balancing Strategies

Configure a strategy per route via the `strategy` field in `routes.json`
(default: `round_robin`).

### 1. Round Robin — `round_robin`
Distributes requests sequentially across all healthy backends.
**Use case**: Even distribution with similar backend capacity.

### 2. Weighted Round Robin — `weighted_round_robin`
Distributes requests proportionally to each backend's `weight` using a smooth
weighted round robin algorithm. Requires per-backend weights (see Configuration).
**Use case**: Backends with different capacities (CPU, memory).

### 3. Least Latency — `least_latency`
Routes to the healthy backend with the lowest observed average latency.
**Use case**: Mixed workloads with varying response times.

### 4. Least Active / Least Connections — `least_active` (alias: `least_connections`)
Routes to the healthy backend with the fewest in-flight requests.
**Use case**: Long-running requests, streaming.

### 5. Least Loaded — `least_loaded`
Routes to the healthy backend with the lowest combined score of active requests
and normalized latency (`active + avgLatencyMs / 100`).
**Use case**: Mixed workloads where both concurrency and latency matter.

### 6. IP Hash — `ip_hash`
Consistent routing based on the client IP address (FNV-1a hash).
**Use case**: Session affinity, stateful applications.

## Installation

### Prerequisites
- Node.js 18 or higher
- Prometheus (optional, for metrics)
- Grafana (optional, for visualization)

### Install dependencies

```bash
npm install
```

## Quick Start

```bash
# 1. Start the mock backend servers (ports 8081-8083, 8091-8092)
npm run mock

# 2. In another terminal, start the load balancer (port 8080)
npm start

# 3. Send a request
curl http://localhost:8080/users
```

## Configuration

### Configuration File (`routes.json`)

```json
{
  "routes": [
    {
      "prefix": "/users",
      "backends": [
        "http://localhost:8081",
        "http://localhost:8083"
      ]
    },
    {
      "prefix": "/posts",
      "backends": [
        "http://localhost:8091",
        "http://localhost:8092"
      ],
      "strategy": "least_latency"
    }
  ]
}
```

Each route has:
- `prefix` — the path prefix to match (longest match wins)
- `backends` — list of upstream backends (see below)
- `strategy` — optional; one of `round_robin`, `weighted_round_robin`, `least_latency`, `least_active` (alias `least_connections`), `least_loaded`, `ip_hash` (default `round_robin`)

A backend entry may be a plain URL string, or an object with a `weight`
(used by `weighted_round_robin`; defaults to `1`):

```json
{
  "prefix": "/posts",
  "backends": [
    { "url": "http://localhost:8091", "weight": 3 },
    { "url": "http://localhost:8092", "weight": 1 }
  ],
  "strategy": "weighted_round_robin"
}
```

### Environment Variables
- `PORT` — port the load balancer listens on (default `8080`)

## Monitoring & Metrics

### Prometheus Metrics

The load balancer exposes metrics at `http://localhost:8080/metrics`.

#### Route-Level Metrics
```
lb_route_requests_total{route, method, status_code}
lb_route_request_duration_seconds{route, method}
lb_route_active_requests{route}
lb_route_errors_total{route, error_type}
lb_route_request_size_bytes{route}
lb_route_response_size_bytes{route}
lb_route_strategy_changes_total{route, from_strategy, to_strategy}
```

#### Backend-Level Metrics
```
lb_backend_health_status{route, backend, backend_host}
lb_backend_health_check_duration_seconds{route, backend, backend_host}
lb_backend_health_check_failures_total{route, backend, backend_host}
lb_backend_requests_total{route, backend, backend_host, status_code}
lb_backend_request_duration_seconds{route, backend, backend_host}
lb_backend_active_connections{route, backend, backend_host}
lb_backend_load_score{route, backend, backend_host}
lb_backend_selection_total{route, backend, backend_host, strategy}
lb_backend_failures_total{route, backend, backend_host, failure_type}
```

Node.js process/runtime metrics (`process_*`, `nodejs_*`) are also exposed
automatically.

### Grafana Dashboard

Snapshots of the included dashboard:

![Load Balancer Overview](assets/grafana1.png)
![Backend Health and Load Distribution](assets/grafana2.png)
![Request/Response analysis and health monitoring](assets/grafana3.png)
![Individual Backend performance analysis](assets/grafana4.png)

Import the included dashboard:

```bash
curl -X POST http://localhost:3000/api/dashboards/db \
  -H "Content-Type: application/json" \
  -d @load-balancer-dashboard.json
```

### Running Prometheus + Grafana

```bash
docker-compose up -d
```

Prometheus is configured (`prometheus.yml`) to scrape the load balancer at
`host.docker.internal:8080/metrics`.

## Admin API

The admin API is available at `http://localhost:8080/admin/`.

#### List Routes
```bash
GET /admin/list
```

#### Add Backend to Route
```bash
POST /admin/add-backend
Content-Type: application/json

{ "prefix": "/users", "url": "http://localhost:8084", "strategy": "round_robin" }
```

#### Remove Backend from Route
```bash
POST /admin/remove-backend
Content-Type: application/json

{ "prefix": "/users", "url": "http://localhost:8084" }
```

#### Update Route
```bash
PUT /admin/update
Content-Type: application/json

{
  "prefix": "/users",
  "backends": ["http://localhost:8081", "http://localhost:8082"],
  "strategy": "least_active"
}
```

## Project Structure

```
load-balancer/
├── src/
│   ├── core/
│   │   ├── backend.js          # Backend, BackendPool, selection strategies
│   │   ├── loadbalancer.js     # Core load balancer logic + health checks
│   │   ├── trie.js             # Path-prefix Trie for route matching
│   │   └── metrics.js          # Prometheus metrics
│   ├── middleware/
│   │   └── rateLimit.js        # Token-bucket rate limiter
│   ├── controller/
│   │   └── admin.js            # Admin API handlers
│   ├── logger/
│   │   └── logger.js           # Structured JSON logging
│   ├── utils/
│   │   └── utils.js            # HTTP helpers
│   └── server.js               # Application entry point
├── mock_servers/               # Mock backend servers for testing
│   ├── backend_user1.js ... backend_post2.js
│   └── start.js                # Spawns all mock servers
├── routes.json                 # Routes configuration
├── prometheus.yml              # Prometheus config
├── load-balancer-dashboard.json# Grafana dashboard as code
├── docker-compose.yml          # Prometheus + Grafana stack
├── package.json
└── README.md
```

## Usage Examples

```bash
# Add a backend to an existing route
curl -X POST http://localhost:8080/admin/add-backend \
  -H "Content-Type: application/json" \
  -d '{"prefix":"/users","url":"http://localhost:8084","strategy":"round_robin"}'

# Remove a backend from a route
curl -X POST http://localhost:8080/admin/remove-backend \
  -H "Content-Type: application/json" \
  -d '{"prefix":"/users","url":"http://localhost:8084"}'

# Update an entire route configuration
curl -X PUT http://localhost:8080/admin/update \
  -H "Content-Type: application/json" \
  -d '{"prefix":"/users","backends":["http://localhost:8081","http://localhost:8082"],"strategy":"least_active"}'

# List all routes and their backends
curl http://localhost:8080/admin/list

# Send test traffic
for i in $(seq 1 100); do curl -s http://localhost:8080/users > /dev/null; done
```

## License

This project is licensed under the MIT License.

## Roadmap
- [ ] Circuit breaker pattern
- [ ] WebSocket proxying
- [ ] Configuration hot-reload
- [ ] Configuration validation
```
