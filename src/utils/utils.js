// Small HTTP helpers shared across handlers.

export function respondJSON(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export function boolToFloat(ok) {
  return ok ? 1 : 0;
}
