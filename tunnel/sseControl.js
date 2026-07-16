const crypto = require('crypto');

class SseControlHandler {
  constructor(options = {}) {
    this._connections = new Map();
    this._credentials = null;
    this._path = options.path || '/api/v1/events';
    this._keepaliveMinMs = options.keepaliveMinMs || 35_000;
    this._keepaliveMaxMs = options.keepaliveMaxMs || 45_000;
    this._onAuthenticated = options.onAuthenticated || (() => {});
    this._onDisconnected = options.onDisconnected || (() => {});
  }

  setCredentials(credentials) {
    this._credentials = credentials;
  }

  handleRequest(req, res) {
    const url = new URL(req.url, 'https://localhost');
    if (url.pathname !== this._path) return false;

    if (req.method !== 'GET') {
      this._send(res, 405, { error: 'method not allowed' });
      return true;
    }

    const token = url.searchParams.get('token');
    if (!this._verifyToken(token)) {
      console.warn('[Tunnel/SSE] authentication failed');
      this._send(res, 401, { error: 'invalid token' });
      return true;
    }

    this._closeExistingConnection(token);
    this._onAuthenticated(token);
    console.log('[Tunnel/SSE] authenticated, opening event stream');

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 5000\n\n');

    const connection = { res, keepaliveTimer: null };
    this._connections.set(token, connection);
    this._scheduleKeepalive(token);

    if (typeof req.on === 'function') {
      req.on('close', () => {
        if (this._connections.get(token) === connection) {
          this._closeExistingConnection(token);
          this._onDisconnected(token);
          console.log('[Tunnel/SSE] event stream disconnected');
        }
      });
    }

    return true;
  }

  sendWakeSignal(token) {
    const connection = this._connections.get(token);
    if (!connection) {
      console.log('[Tunnel/SSE] wake skipped: no active event stream');
      return false;
    }
    connection.res.write('event: wake\ndata: {}\n\n');
    console.log('[Tunnel/SSE] wake event sent');
    return true;
  }

  hasActiveConnection(token) {
    return this._connections.has(token);
  }

  clearConnection(token) {
    this._closeExistingConnection(token);
  }

  _verifyToken(token) {
    if (!token || !this._credentials) return false;
    const expected = crypto
      .createHash('sha256')
      .update(`${this._credentials.username}:${this._credentials.password}`)
      .digest('hex');
    return token === expected;
  }

  _closeExistingConnection(token) {
    const existing = this._connections.get(token);
    if (!existing) return;
    if (existing.keepaliveTimer) clearTimeout(existing.keepaliveTimer);
    this._connections.delete(token);
    try {
      existing.res.end();
    } catch (_) {
      // ignore close races
    }
  }

  _scheduleKeepalive(token) {
    const connection = this._connections.get(token);
    if (!connection) return;

    const minMs = Math.max(1, this._keepaliveMinMs);
    const maxMs = Math.max(minMs, this._keepaliveMaxMs);
    const delay = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
    connection.keepaliveTimer = setTimeout(() => {
      const current = this._connections.get(token);
      if (!current) return;
      current.res.write(': keepalive\n\n');
      this._scheduleKeepalive(token);
    }, delay);
    connection.keepaliveTimer.unref();
  }

  _send(res, statusCode, body) {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);
  }
}

module.exports = SseControlHandler;
