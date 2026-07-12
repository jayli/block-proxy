const https = require('https');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { FRAME_TYPES, MAX_FRAME_PAYLOAD, encodeFrame, decodeFrame } = require('./protocol');
const { handleDisguiseRequest } = require('./disguiseResponse');

const DEFAULT_WS_PATH = '/ws';
const DEFAULT_HEARTBEAT_MIN = 15;
const DEFAULT_HEARTBEAT_MAX = 40;
const DEFAULT_HEARTBEAT_TIMEOUT = 60;
const DEFAULT_ROTATION_DRAIN_TIMEOUT = 10;
const DEFAULT_ROTATION_DRAIN_IDLE_TIMEOUT = 20;

class TunnelServer {
  constructor(options) {
    this.port = options.port;
    this.cert = options.cert;
    this.key = options.key;
    this.credentials = options.credentials;
    this.wsPath = options.wsPath || options.tunnel_ws_path || DEFAULT_WS_PATH;
    this.heartbeatMin = options.heartbeatMin || options.tunnel_heartbeat_min || DEFAULT_HEARTBEAT_MIN;
    this.heartbeatMax = options.heartbeatMax || options.tunnel_heartbeat_max || DEFAULT_HEARTBEAT_MAX;
    this.heartbeatTimeout = options.heartbeatTimeout || options.tunnel_heartbeat_timeout || DEFAULT_HEARTBEAT_TIMEOUT;
    this.rotationDrainTimeout = options.rotationDrainTimeout || options.tunnel_rotation_drain_timeout || DEFAULT_ROTATION_DRAIN_TIMEOUT;
    this.rotationDrainIdleTimeout = options.rotationDrainIdleTimeout || options.tunnel_rotation_drain_idle_timeout || DEFAULT_ROTATION_DRAIN_IDLE_TIMEOUT;
    this.onConnect = options.onConnect || (() => {});
    this.onDisconnect = options.onDisconnect || (() => {});

    this._frameHandlers = [];
    this._clientSockets = new Set();
    this._server = null;
    this._wss = null;
    this._clientWs = null;
    this._records = new Map();
    this._heartbeatTimer = null;
    this._drainCheckCallback = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this._server = https.createServer({
        key: this.key,
        cert: this.cert,
        minVersion: 'TLSv1.2',
        sessionTimeout: 300,
      }, (req, res) => this._handleHttpRequest(req, res));

      this._wss = new WebSocketServer({
        server: this._server,
        path: this.wsPath,
        maxPayload: MAX_FRAME_PAYLOAD + 2,
      });
      this._wss.on('connection', (ws, req) => this._handleWsConnection(ws, req));

      this._server.once('error', reject);
      this._server.listen(this.port, () => {
        this._server.removeListener('error', reject);
        const localIp = require('../proxy/domain').getLocalIp();
        console.log(`✅ \x1b[32m隧道服务启动，IP ${localIp}, 端口 ${this.port}\x1b[0m`);
        resolve();
      });
    });
  }

  async stop() {
    this._stopHeartbeat();

    const sockets = [...this._records.keys()];
    for (const ws of sockets) {
      this._closeWs(ws, 1001, 'server stopping');
    }
    setTimeout(() => {
      for (const ws of sockets) {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      }
    }, 50).unref();
    this._records.clear();
    this._clientSockets.clear();
    this._clientWs = null;

    const closeWss = this._wss
      ? new Promise((resolve) => {
        const wss = this._wss;
        this._wss = null;
        const timer = setTimeout(resolve, 500);
        wss.close(() => {
          clearTimeout(timer);
          resolve();
        });
      })
      : Promise.resolve();

    const closeServer = this._server
      ? new Promise((resolve) => {
        const server = this._server;
        this._server = null;
        const timer = setTimeout(resolve, 500);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      })
      : Promise.resolve();

    await Promise.all([closeWss, closeServer]);
  }

  _handleHttpRequest(req, res) {
    handleDisguiseRequest(req, res);
  }

  _handleWsConnection(ws, req) {
    const socket = req.socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60000);

    const record = {
      ws,
      authenticated: false,
      state: 'candidate',
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
      connectedAt: Date.now(),
      pongTime: Date.now(),
      pendingPingPayload: null,
      drainTimer: null,
    };
    this._records.set(ws, record);

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        this._closeWs(ws, 1003, 'binary frames required');
        return;
      }
      this._handleWsMessage(ws, Buffer.from(data));
    });

    ws.on('close', () => this._handleWsClose(ws));
    ws.on('error', (err) => {
      console.error('[Tunnel] WebSocket error:', err.message);
    });
  }

  _handleWsMessage(ws, data) {
    const record = this._records.get(ws);
    if (!record) return;

    let frame;
    try {
      frame = decodeFrame(data);
    } catch (err) {
      console.error('[Tunnel] Frame decode error:', err.message);
      this._closeWs(ws, 1002, 'bad frame');
      return;
    }

    if (!record.authenticated) {
      if (frame.type !== FRAME_TYPES.AUTH) {
        this._closeWs(ws, 1008, 'auth required');
        return;
      }
      this._handleAuth(record, frame);
      return;
    }

    if (frame.type === FRAME_TYPES.PING) {
      this._sendWsFrame(ws, { type: FRAME_TYPES.PONG, payload: frame.payload }).catch(() => {});
      return;
    }

    if (frame.type === FRAME_TYPES.PONG) {
      if (!record.pendingPingPayload || frame.payload.equals(record.pendingPingPayload)) {
        record.pongTime = Date.now();
        record.pendingPingPayload = null;
      }
      return;
    }

    this._frameHandlers.forEach(handler => handler(frame, ws));
  }

  _handleAuth(record, frame) {
    const { ws } = record;
    const { username, password } = frame;

    if (username !== this.credentials.username || password !== this.credentials.password) {
      this._sendWsFrame(ws, { type: FRAME_TYPES.AUTH_FAIL }).finally(() => {
        this._closeWs(ws, 1008, 'auth failed');
      });
      return;
    }

    const counts = this.getConnectionCounts();
    if (counts.active >= 1 && counts.draining >= 1) {
      this._sendWsFrame(ws, { type: FRAME_TYPES.ERROR, message: 'Tunnel connection limit (2)' }).finally(() => {
        this._closeWs(ws, 1008, 'connection limit');
      });
      return;
    }

    record.authenticated = true;
    record.pongTime = Date.now();
    this._promoteRecord(record);

    this._sendWsFrame(ws, { type: FRAME_TYPES.AUTH_OK }).then(() => {
      console.log(`[Tunnel] Client authenticated: ${record.remoteAddress} (${record.state})`);
      this._startHeartbeat();
      this.onConnect(ws, record.remoteAddress, record.remotePort);
    });
  }

  _promoteRecord(record) {
    const oldActive = this._clientWs;
    if (oldActive && oldActive !== record.ws) {
      const oldRecord = this._records.get(oldActive);
      if (oldRecord && oldRecord.authenticated) {
        oldRecord.state = 'draining';
        if (oldRecord.drainTimer) clearTimeout(oldRecord.drainTimer);
        oldRecord.drainTimer = setTimeout(() => {
          this._tryDrainSocket(oldRecord);
        }, Math.max(1, this.rotationDrainTimeout * 1000));
        oldRecord.drainTimer.unref();
      }
    }

    record.state = 'active';
    this._clientWs = record.ws;
    this._clientSockets.add(record.ws);
  }

  _handleWsClose(ws) {
    const record = this._records.get(ws);
    if (!record) return;

    this._records.delete(ws);
    this._clientSockets.delete(ws);
    if (record.drainTimer) {
      clearTimeout(record.drainTimer);
      record.drainTimer = null;
    }
    if (this._clientWs === ws) {
      this._clientWs = null;
    }

    if (record.authenticated) {
      console.log(`[Tunnel] Client disconnected (${this._clientSockets.size} remaining)`);
      this.onDisconnect(ws);
    }

    if (this._clientSockets.size === 0) {
      this._stopHeartbeat();
    }
  }

  sendFrame(frame, targetSocket) {
    if (targetSocket) {
      if (!this._clientSockets.has(targetSocket)) {
        return Promise.resolve(false);
      }
      return this._sendWsFrame(targetSocket, frame);
    }

    if (!this._clientWs || !this._clientSockets.has(this._clientWs)) {
      return Promise.resolve(false);
    }
    return this._sendWsFrame(this._clientWs, frame);
  }

  _sendWsFrame(ws, frame) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve(false);
    }

    const data = encodeFrame(frame);
    return new Promise((resolve) => {
      ws.send(data, { binary: true }, (err) => {
        if (err) {
          console.warn('[Tunnel] WebSocket send failed:', err.message);
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }

  _closeWs(ws, code, reason) {
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close(code, reason);
      } catch (err) {
        ws.terminate();
      }
      setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      }, 100).unref();
    }
  }

  onFrame(handler) {
    this._frameHandlers.push(handler);
  }

  getActiveSocket() {
    return this._clientWs && this._clientWs.readyState === WebSocket.OPEN ? this._clientWs : null;
  }

  setActiveRequestChecker(fn) {
    this._drainCheckCallback = fn;
  }

  _tryDrainSocket(record) {
    if (this._drainCheckCallback) {
      const drainState = this._drainCheckCallback(record.ws);
      const activeCount = typeof drainState === 'number' ? drainState : (drainState && drainState.activeCount) || 0;
      if (activeCount > 0) {
        const lastActivityAt = typeof drainState === 'number' ? null : drainState.lastActivityAt;
        const idleMs = Math.max(0, this.rotationDrainIdleTimeout * 1000);
        if (!idleMs || !lastActivityAt || Date.now() - lastActivityAt < idleMs) {
          const delay = lastActivityAt && idleMs
            ? Math.min(1000, Math.max(10, idleMs - (Date.now() - lastActivityAt)))
            : 1000;
          record.drainTimer = setTimeout(() => this._tryDrainSocket(record), delay);
          record.drainTimer.unref();
          return;
        }
        console.warn(`[Tunnel] Draining connection idle for ${this.rotationDrainIdleTimeout}s; closing stale requests`);
      } else {
        record.drainTimer = null;
      }
    }
    if (record.ws.readyState !== WebSocket.CLOSED) {
      record.ws.terminate();
    }
  }

  getConnectionCounts() {
    const counts = { active: 0, candidate: 0, draining: 0, total: 0 };
    for (const record of this._records.values()) {
      if (!record.authenticated) continue;
      counts.total += 1;
      if (record.state === 'active') counts.active += 1;
      if (record.state === 'candidate') counts.candidate += 1;
      if (record.state === 'draining') counts.draining += 1;
    }
    return counts;
  }

  _startHeartbeat() {
    if (this._heartbeatTimer) return;
    this._scheduleHeartbeat();
  }

  _scheduleHeartbeat() {
    this._stopHeartbeat();
    if (this._clientSockets.size === 0) return;

    const minMs = Math.max(1, this.heartbeatMin * 1000);
    const maxMs = Math.max(minMs, this.heartbeatMax * 1000);
    const delay = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
    this._heartbeatTimer = setTimeout(() => {
      this._heartbeatTimer = null;
      this._sendHeartbeat();
      this._scheduleHeartbeat();
    }, delay);
    this._heartbeatTimer.unref();
  }

  _sendHeartbeat() {
    const now = Date.now();
    const timeoutMs = this.heartbeatTimeout * 1000;

    for (const record of this._records.values()) {
      if (!record.authenticated || (record.state !== 'active' && record.state !== 'draining')) continue;
      if (now - record.pongTime > timeoutMs) {
        console.log(`[Tunnel] Heartbeat timeout (${this.heartbeatTimeout}s no valid PONG), closing WS`);
        this._closeWs(record.ws, 1001, 'heartbeat timeout');
        continue;
      }

      const payloadLen = 8 + Math.floor(Math.random() * 33);
      const payload = crypto.randomBytes(payloadLen);
      record.pendingPingPayload = payload;
      this._sendWsFrame(record.ws, { type: FRAME_TYPES.PING, payload }).catch(() => {});
    }
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearTimeout(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }
}

module.exports = TunnelServer;
