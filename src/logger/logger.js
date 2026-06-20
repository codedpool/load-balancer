// Structured JSON logging with a per-request correlation id.
// INFO goes to stdout, ERROR to stderr, one JSON object per line.
// Level is controlled by LOG_LEVEL (silent | error | info; default info).
import { randomUUID } from 'node:crypto';

const LEVELS = { silent: 0, error: 1, info: 2 };
let currentLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

export function setLevel(name) {
  if (name in LEVELS) {
    currentLevel = LEVELS[name];
  }
}

export function newRequestId() {
  return randomUUID();
}

export function info(requestId, msg, fields) {
  if (currentLevel < LEVELS.info) return;
  writeLog('INFO', requestId, msg, fields, process.stdout);
}

export function error(requestId, msg, fields) {
  if (currentLevel < LEVELS.error) return;
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
