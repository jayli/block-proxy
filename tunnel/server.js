const http2 = require('http2');
const crypto = require('crypto');
const { FRAME_TYPES, MAX_FRAME_PAYLOAD, CAP_PADDING, encodeFrame, decodeFrame } = require('./protocol');

const DEFAULT_H2_PATH = '/h2-tunnel';
const DEFAULT_GRPC_PATH = '/blockproxy.tunnel.TunnelService/Connect';
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
    this.h2Path = options.h2Path || options.tunnel_h2_path || DEFAULT_H2_PATH;
    this.grpcPath = options.grpcPath || options.tunnel_grpc_path || DEFAULT_GRPC_PATH;
    this.heartbeatMin = options.heartbeatMin || options.tunnel_heartbeat_min || DEFAULT_HEARTBEAT_MIN;
    this.heartbeatMax = options.heartbeatMax || options.tunnel_heartbeat_max || DEFAULT_HEARTBEAT_MAX;
    this.heartbeatTimeout = options.heartbeatTimeout || options.tunnel_heartbeat_timeout || DEFAULT_HEARTBEAT_TIMEOUT;
    this.rotationDrainTimeout = options.rotationDrainTimeout || options.tunnel_rotation_drain_timeout || DEFAULT_ROTATION_DRAIN_TIMEOUT;
    this.rotationDrainIdleTimeout = options.rotationDrainIdleTimeout || options.tunnel_rotation_drain_idle_timeout || DEFAULT_ROTATION_DRAIN_IDLE_TIMEOUT;
    this.paddingEnabled = options.paddingEnabled ?? true;
    this.paddingProbability = Math.max(0, Math.min(1, options.paddingProbability ?? 0.3));
    this.paddingMinBytes = Math.max(0, Math.min(65534, options.paddingMinBytes ?? 64));
    this.paddingMaxBytes = Math.max(this.paddingMinBytes, Math.min(65534, options.paddingMaxBytes ?? 512));
    this.onConnect = options.onConnect || (() => {});
    this.onDisconnect = options.onDisconnect || (() => {});

    this._frameHandlers = [];
    this._clientSockets = new Set();
    this._server = null;
    this._clientWs = null;
    this._records = new Map();
    this._heartbeatTimer = null;
    this._drainCheckCallback = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this._server = http2.createSecureServer({
        key: this.key,
        cert: this.cert,
        minVersion: 'TLSv1.2',
        sessionTimeout: 300,
        allowHTTP1: true,
      });
      this._server.on('stream', (stream, headers) => this._handleH2Stream(stream, headers));
      this._server.on('request', (req, res) => this._handleHttp1Request(req, res));

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
    this._drainCheckCallback = null;

    const sockets = [...this._records.keys()];
    for (const record of this._records.values()) {
      if (record.drainTimer) {
        clearTimeout(record.drainTimer);
        record.drainTimer = null;
      }
    }
    for (const ws of sockets) {
      this._closeConnection(ws, 'server stopping');
    }
    setTimeout(() => {
      for (const ws of sockets) {
        if (!ws.closed) ws.terminate();
      }
    }, 50).unref();
    this._records.clear();
    this._clientSockets.clear();
    this._clientWs = null;

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

    await closeServer;
  }

  _handleH2Stream(stream, headers) {
    const method = headers[':method'];
    const path = headers[':path'];
    const contentType = String(headers['content-type'] || '');
    console.log(
      `[Tunnel] HTTP/2 ingress: method=${method} path=${path} content-type=${contentType || '-'} ` +
      `authority=${headers[':authority'] || '-'} cf-ray=${headers['cf-ray'] || '-'}`
    );
    if (method === 'POST' && path === this.grpcPath && contentType.startsWith('application/grpc')) {
      this._handleGrpcStream(stream);
      return;
    }

    if (method !== 'POST' || path !== this.h2Path) {
      stream.respond({
        ':status': 404,
        'content-type': 'text/plain; charset=utf-8',
      });
      stream.end('Not found');
      return;
    }

    stream.respond({
      ':status': 200,
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
    });

    const socket = stream.session && stream.session.socket;
    const ws = new H2TunnelConnection(stream);
    this._registerTunnelConnection(ws, socket);
  }

  _handleGrpcStream(stream) {
    stream.respond({
      ':status': 200,
      'content-type': 'application/grpc',
      'cache-control': 'no-store',
    });

    const socket = stream.session && stream.session.socket;
    const ws = new GrpcTunnelConnection(stream);
    this._registerTunnelConnection(ws, socket);
  }

  _handleHttp1Request(req, res) {
    if (req.httpVersionMajor !== 1) return;
    const requestUrl = new URL(req.url, 'https://localhost');
    console.log(
      `[Tunnel] HTTP/1.1 ingress: method=${req.method} path=${requestUrl.pathname} ` +
      `content-type=${req.headers['content-type'] || '-'} host=${req.headers.host || '-'} ` +
      `cf-ray=${req.headers['cf-ray'] || '-'}`
    );
    if (req.method !== 'POST' || requestUrl.pathname !== this.h2Path) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      req.resume();
      return;
    }

    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-tunnel-relay': '1',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const ws = new Http1TunnelConnection(req, res);
    this._registerTunnelConnection(ws, req.socket);
  }

  _registerTunnelConnection(ws, socket) {
    const record = {
      ws,
      authenticated: false,
      state: 'candidate',
      remoteAddress: socket && socket.remoteAddress,
      remotePort: socket && socket.remotePort,
      connectedAt: Date.now(),
      pongTime: Date.now(),
      pendingPingPayload: null,
      capabilities: new Set(),
      drainTimer: null,
    };
    this._records.set(ws, record);

    ws.onFrame((data) => {
      this._handleWsMessage(ws, data);
    });

    ws.onClose(() => this._handleWsClose(ws));
    ws.onError((err) => {
      console.error('[Tunnel] HTTP/2 stream error:', err.message);
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
        this._closeConnection(ws, 'auth required');
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

    if (frame.type === FRAME_TYPES.PADDING) {
      return;
    }

    this._frameHandlers.forEach(handler => handler(frame, ws));
  }

  _handleAuth(record, frame) {
    const { ws } = record;
    const { username, password } = frame;

    if (username !== this.credentials.username || password !== this.credentials.password) {
      this._sendWsFrame(ws, { type: FRAME_TYPES.AUTH_FAIL }).finally(() => {
        this._closeConnection(ws, 'auth failed');
      });
      return;
    }

    const counts = this.getConnectionCounts();
    if (counts.active >= 1 && counts.draining >= 1) {
      this._sendWsFrame(ws, { type: FRAME_TYPES.ERROR, message: 'Tunnel connection limit (2)' }).finally(() => {
        this._closeConnection(ws, 'connection limit');
      });
      return;
    }

    record.authenticated = true;
    record.pongTime = Date.now();
    const clientCapabilities = new Set(frame.capabilities || []);
    if (this.paddingEnabled && clientCapabilities.has(CAP_PADDING)) {
      record.capabilities.add(CAP_PADDING);
    }
    this._promoteRecord(record);

    this._sendWsFrame(ws, { type: FRAME_TYPES.AUTH_OK }).then(() => {
      if (record.capabilities.size > 0) {
        return this._sendWsFrame(ws, {
          type: FRAME_TYPES.CAPABILITIES,
          capabilities: [...record.capabilities],
        }).then((ok) => {
          if (ok && record.capabilities.has(CAP_PADDING)) {
            console.log(`[Tunnel] Padding negotiated: ${record.remoteAddress} (${record.state})`);
          }
          return ok;
        });
      }
      return true;
    }).then(() => {
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
      return this._sendWsFrame(targetSocket, frame).then((ok) => {
        if (ok && frame.type === FRAME_TYPES.DATA) this._maybePadAfterSend(targetSocket);
        return ok;
      });
    }

    if (!this._clientWs || !this._clientSockets.has(this._clientWs)) {
      return Promise.resolve(false);
    }
    return this._sendWsFrame(this._clientWs, frame).then((ok) => {
      if (ok && frame.type === FRAME_TYPES.DATA) this._maybePadAfterSend(this._clientWs);
      return ok;
    });
  }

  _sendWsFrame(ws, frame) {
    if (!ws || ws.closed) {
      return Promise.resolve(false);
    }

    const data = encodeFrame(frame);
    return new Promise((resolve) => {
      ws.send(data, (err) => {
        if (err) {
          console.warn('[Tunnel] HTTP/2 send failed:', err.message);
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }

  _closeConnection(ws, reason) {
    if (!ws) return;
    if (!ws.closed) {
      try { ws.close(reason); } catch (err) { ws.terminate(); }
      setTimeout(() => {
        if (!ws.closed) ws.terminate();
      }, 100).unref();
    }
  }

  onFrame(handler) {
    this._frameHandlers.push(handler);
  }

  getActiveSocket() {
    return this._clientWs && !this._clientWs.closed ? this._clientWs : null;
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
    if (!record.ws.closed) {
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
        console.log(`[Tunnel] Heartbeat timeout (${this.heartbeatTimeout}s no valid PONG), closing H2 stream`);
        this._closeConnection(record.ws, 'heartbeat timeout');
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

  _randomPaddingBytes() {
    const size = this.paddingMinBytes +
      Math.floor(Math.random() * (this.paddingMaxBytes - this.paddingMinBytes + 1));
    return crypto.randomBytes(size);
  }

  _maybePadAfterSend(ws) {
    if (!this.paddingEnabled) return;
    const record = this._records.get(ws);
    if (!record || !record.capabilities || !record.capabilities.has(CAP_PADDING)) return;
    if (Math.random() >= this.paddingProbability) return;
    this._sendWsFrame(ws, {
      type: FRAME_TYPES.PADDING,
      data: this._randomPaddingBytes(),
    }).catch(() => {});
  }

}

class H2TunnelConnection {
  constructor(stream) {
    this.stream = stream;
    this.closed = false;
    this._buffer = Buffer.alloc(0);
    this._frameHandlers = [];
    this._closeHandlers = [];
    this._errorHandlers = [];

    stream.on('data', (chunk) => this._onData(Buffer.from(chunk)));
    stream.on('close', () => {
      this.closed = true;
      this._closeHandlers.forEach(handler => handler());
    });
    stream.on('error', (err) => {
      this._errorHandlers.forEach(handler => handler(err));
    });
  }

  onFrame(handler) {
    this._frameHandlers.push(handler);
  }

  onClose(handler) {
    this._closeHandlers.push(handler);
  }

  onError(handler) {
    this._errorHandlers.push(handler);
  }

  send(data, callback) {
    if (this.closed || this.stream.destroyed) {
      callback(new Error('stream closed'));
      return;
    }
    this.stream.write(data, callback);
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.stream.close(http2.constants.NGHTTP2_NO_ERROR);
    } catch (_) {
      try { this.stream.end(); } catch (_) {}
    }
  }

  terminate() {
    if (this.closed) return;
    this.closed = true;
    try { this.stream.destroy(); } catch (_) {}
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (this._buffer.length >= 2) {
      const length = this._buffer.readUInt16BE(0);
      if (length > MAX_FRAME_PAYLOAD) {
        this.terminate();
        return;
      }
      if (this._buffer.length < 2 + length) return;
      const frameBytes = this._buffer.slice(0, 2 + length);
      this._buffer = this._buffer.slice(2 + length);
      this._frameHandlers.forEach(handler => handler(frameBytes));
    }
  }
}

class GrpcTunnelConnection {
  constructor(stream) {
    this.stream = stream;
    this.closed = false;
    this._buffer = Buffer.alloc(0);
    this._frameHandlers = [];
    this._closeHandlers = [];
    this._errorHandlers = [];

    stream.on('data', (chunk) => this._onData(Buffer.from(chunk)));
    stream.on('close', () => {
      this.closed = true;
      this._closeHandlers.forEach(handler => handler());
    });
    stream.on('error', (err) => {
      this._errorHandlers.forEach(handler => handler(err));
    });
  }

  onFrame(handler) {
    this._frameHandlers.push(handler);
  }

  onClose(handler) {
    this._closeHandlers.push(handler);
  }

  onError(handler) {
    this._errorHandlers.push(handler);
  }

  send(data, callback) {
    if (this.closed || this.stream.destroyed) {
      callback(new Error('stream closed'));
      return;
    }
    this.stream.write(encodeGrpcTunnelMessage(data), callback);
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.stream.sendTrailers({ 'grpc-status': '0' });
    } catch (_) {}
    try {
      this.stream.close(http2.constants.NGHTTP2_NO_ERROR);
    } catch (_) {
      try { this.stream.end(); } catch (_) {}
    }
  }

  terminate() {
    if (this.closed) return;
    this.closed = true;
    try { this.stream.destroy(); } catch (_) {}
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (this._buffer.length >= 5) {
      if (this._buffer[0] !== 0) {
        this.terminate();
        return;
      }
      const messageLength = this._buffer.readUInt32BE(1);
      if (messageLength > MAX_FRAME_PAYLOAD + 16) {
        this.terminate();
        return;
      }
      if (this._buffer.length < 5 + messageLength) return;
      const message = this._buffer.slice(5, 5 + messageLength);
      this._buffer = this._buffer.slice(5 + messageLength);

      let frameBytes;
      try {
        frameBytes = decodeGrpcTunnelMessage(message);
      } catch (_) {
        this.terminate();
        return;
      }
      this._frameHandlers.forEach(handler => handler(frameBytes));
    }
  }
}

function encodeGrpcTunnelMessage(frameBytes) {
  const message = Buffer.concat([encodeBytesField(1, frameBytes), frameBytes]);
  const header = Buffer.alloc(5);
  header[0] = 0;
  header.writeUInt32BE(message.length, 1);
  return Buffer.concat([header, message]);
}

function encodeBytesField(fieldNumber, bytes) {
  return Buffer.concat([
    Buffer.from([(fieldNumber << 3) | 2]),
    encodeVarint(bytes.length),
  ]);
}

function encodeVarint(value) {
  const parts = [];
  let remaining = value >>> 0;
  while (remaining >= 0x80) {
    parts.push((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  parts.push(remaining);
  return Buffer.from(parts);
}

function decodeGrpcTunnelMessage(message) {
  let offset = 0;
  while (offset < message.length) {
    const tag = message[offset++];
    const fieldNumber = tag >> 3;
    const wireType = tag & 0x07;
    if (wireType !== 2) throw new Error('Unsupported TunnelFrame field wire type');
    const lengthResult = decodeVarint(message, offset);
    offset = lengthResult.offset;
    const end = offset + lengthResult.value;
    if (end > message.length) throw new Error('TunnelFrame field exceeds message length');
    if (fieldNumber === 1) {
      return message.slice(offset, end);
    }
    offset = end;
  }
  throw new Error('TunnelFrame missing data field');
}

function decodeVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  while (offset < buffer.length) {
    const b = buffer[offset++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, offset };
    shift += 7;
    if (shift > 28) throw new Error('Varint too long');
  }
  throw new Error('Incomplete varint');
}

class Http1TunnelConnection {
  constructor(req, res) {
    this.req = req;
    this.res = res;
    this.closed = false;
    this._buffer = Buffer.alloc(0);
    this._frameHandlers = [];
    this._closeHandlers = [];
    this._errorHandlers = [];

    req.on('data', (chunk) => this._onData(Buffer.from(chunk)));
    req.on('close', () => this._emitClose());
    req.on('error', (err) => this._emitError(err));
    res.on('close', () => this._emitClose());
    res.on('error', (err) => this._emitError(err));
  }

  onFrame(handler) {
    this._frameHandlers.push(handler);
  }

  onClose(handler) {
    this._closeHandlers.push(handler);
  }

  onError(handler) {
    this._errorHandlers.push(handler);
  }

  send(data, callback) {
    if (this.closed || this.res.destroyed) {
      callback(new Error('stream closed'));
      return;
    }
    this.res.write(data, callback);
  }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    try { this.res.end(); } catch (_) {}
    try { this.req.destroy(); } catch (_) {}
  }

  terminate() {
    if (this.closed) return;
    this.closed = true;
    try { this.res.destroy(); } catch (_) {}
    try { this.req.destroy(); } catch (_) {}
  }

  _emitClose() {
    if (this.closed) return;
    this.closed = true;
    this._closeHandlers.forEach(handler => handler());
  }

  _emitError(err) {
    this._errorHandlers.forEach(handler => handler(err));
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (this._buffer.length >= 2) {
      const length = this._buffer.readUInt16BE(0);
      if (length > MAX_FRAME_PAYLOAD) {
        this.terminate();
        return;
      }
      if (this._buffer.length < 2 + length) return;
      const frameBytes = this._buffer.slice(0, 2 + length);
      this._buffer = this._buffer.slice(2 + length);
      this._frameHandlers.forEach(handler => handler(frameBytes));
    }
  }
}

module.exports = TunnelServer;
