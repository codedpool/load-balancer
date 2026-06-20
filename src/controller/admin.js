// Runtime admin API for inspecting and mutating routes without a restart.
import { parseStrategy } from '../core/backend.js';
import { respondJSON } from '../utils/utils.js';

export class AdminHandler {
  constructor(lb) {
    this.lb = lb;
  }

  handle(req, res) {
    const path = req.url.split('?')[0];

    if (req.method === 'POST' && path === '/admin/add-backend') {
      return this.handleAddBackend(req, res);
    }
    if (req.method === 'POST' && path === '/admin/remove-backend') {
      return this.handleRemoveBackend(req, res);
    }
    if (req.method === 'GET' && path === '/admin/list') {
      return this.handleListRoutes(req, res);
    }
    if (req.method === 'PUT' && path === '/admin/update') {
      return this.handleUpdateRoute(req, res);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Unknown or unsupported admin endpoint\n');
  }

  async handleAddBackend(req, res) {
    const body = await readJSON(req);
    if (!body) {
      return badRequest(res, 'Invalid request');
    }
    const strategy = parseStrategy(body.strategy);
    try {
      this.lb.addBackendToRoute(body.prefix, body.url, strategy, body.weight ?? 1);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to add backend\n');
      return;
    }
    respondJSON(res, 200, {
      status: 'success',
      action: 'add-backend',
      prefix: body.prefix,
      url: body.url,
      weight: body.weight ?? 1,
      strategy,
    });
  }

  async handleRemoveBackend(req, res) {
    const body = await readJSON(req);
    if (!body) {
      return badRequest(res, 'Invalid request');
    }
    this.lb.removeBackendFromRoute(body.prefix, body.url);
    respondJSON(res, 200, {
      status: 'success',
      action: 'remove-backend',
      prefix: body.prefix,
      url: body.url,
    });
  }

  handleListRoutes(_req, res) {
    respondJSON(res, 200, this.lb.getRoutesInfo());
  }

  async handleUpdateRoute(req, res) {
    const body = await readJSON(req);
    if (!body) {
      return badRequest(res, 'Invalid JSON');
    }
    try {
      this.lb.updateRoute(body.prefix, body.backends, body.strategy);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Failed to update route: ${err.message}\n`);
      return;
    }
    respondJSON(res, 200, {
      status: 'success',
      action: 'update-route',
      prefix: body.prefix,
      strategy: body.strategy,
    });
  }
}

function badRequest(res, msg) {
  res.writeHead(400, { 'Content-Type': 'text/plain' });
  res.end(`${msg}\n`);
}

// Reads and JSON-parses the request body; resolves null on invalid JSON.
function readJSON(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}
