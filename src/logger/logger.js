// Structured JSON logging with a per-request correlation id.
// INFO goes to stdout, ERROR to stderr, one JSON object per line.
import { randomUUID } from 'node:crypto';

export function newRequestId() {
  return randomUUID();
}

export function info(requestId, msg, fields) {
  writeLog('INFO', requestId, msg, fields, process.stdout);
}

export function error(requestId, msg, fields) {
  writeLog('ERROR', requestId, msg, fields, process.stderr);
}

function writeLog(level, requestId, msg, fields, stream) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
  };
  if (requestId) entry.request_id = requestId;
  entry.message = msg;

  if (fields) {
    if (fields.method) entry.method = fields.method;
    if (fields.path) entry.path = fields.path;
    if (fields.target) entry.target = fields.target;
    if (fields.duration) entry.duration = fields.duration;
    if (fields.status) entry.status = fields.status;
  }

  stream.write(JSON.stringify(entry) + '\n');
}
