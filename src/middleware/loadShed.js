// Load-shedding middleware: admits a request only if the adaptive concurrency
// limiter has headroom, otherwise sheds it immediately with 503 + Retry-After.
// Shedding a few requests fast is far better than letting an overloaded system
// queue everything and time out (brownout). The request's total latency feeds
// back into the limiter so it can adapt.
import { performance } from 'node:perf_hooks';
import { ConcurrencyLimit, InflightRequests, ShedTotal } from '../core/metrics.js';

export function loadShedMiddleware(limiter, next) {
  return (req, res) => {
    if (!limiter.tryAcquire()) {
      ShedTotal.inc();
      res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '1' });
      res.end('Service Overloaded\n');
      return;
    }
    InflightRequests.set(limiter.inflight);

    const start = performance.now();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      limiter.record(performance.now() - start);
      InflightRequests.set(limiter.inflight);
      ConcurrencyLimit.set(limiter.limit);
    };
    res.on('finish', release);
    res.on('close', release);

    next(req, res);
  };
}
