const { Duplex } = require('stream');
const net = require('net');
const { FRAME_TYPES, ATYP, MAX_DATA_CHUNK, encodeFrame } = require('./protocol');

const MAX_FORWARD_CONNECTIONS = 100;
const FORWARD_IDLE_TIMEOUT = 300 * 1000; // 5 min idle timeout for established connections

class TunnelManager {
  constructor(tunnelServer, config) {
    this._server = tunnelServer;
    this._tunnelDomains = config.tunnel_domains || [];
    this._proxyPort = config.proxy_port || 8001;
    this._reqidCounter = 0;
    this._activeRequests = new Map();
    this._forwardCount = 0;
    this._connected = false;
    this._clientAddress = null;
    /** @type {Map<string, string>} sessionId → token */
    this._sessionTokens = new Map();

    // Frame handler is now set up via xhttpHandler callback (sessionId-based)
    if (typeof this._server.setTunnelManager === 'function') {
      this._server.setTunnelManager(this);
    }
  }

  matchesTunnelDomain(host) {
    return this._tunnelDomains.some(domain => {
      if (host === domain) return true;
      if (host.endsWith('.' + domain)) return true;
      return false;
    });
  }

  isAvailable() {
    return this._connected;
  }

  forward(host, port, callback) {
    const createErrorStream = (code) => {
      const stream = new Duplex({ read() {}, write(c, e, cb) { cb(); } });
      process.nextTick(() => stream.destroy(new Error(code)));
      return stream;
    };

    if (!this._connected) {
      console.log(`[Tunnel] Forward rejected: tunnel disconnected for ${host}:${port}`);
      return createErrorStream('tunnel-disconnected');
    }

    const sessionId = this._selectSessionId();
    if (!sessionId) return createErrorStream('tunnel-disconnected');

    return this._createReverseForwardStream(sessionId, host, port, callback);
  }

  _createReverseForwardStream(sessionId, host, port, callback, existingStream = null) {
    const reqid = this._allocateReqid();
    const stream = existingStream || new TunnelDuplex(this, reqid);
    stream.setReqid(reqid);

    this._activeRequests.set(reqid, {
      reqid, stream, confirmed: false, timeout: null, direction: 'reverse',
      sessionId, lastActivityAt: Date.now()
    });
    const entry = this._activeRequests.get(reqid);

    this._server.sendFrame({
      type: FRAME_TYPES.CONNECT,
      reqid,
      atyp: ATYP.DOMAIN,
      addr: host,
      port
    }, sessionId);

    const timeout = setTimeout(() => {
      if (this._activeRequests.has(reqid) && !entry.confirmed) {
        console.log(`[Tunnel] CONNECT timeout for ${host}:${port} (reqid=${reqid})`);
        this._clearActiveRequest(reqid);
        stream.destroy(new Error('tunnel-connect-timeout'));
      }
    }, 30000);
    entry.timeout = timeout;

    stream.once('tunnel-connect-ok', () => {
      clearTimeout(timeout);
      callback();
    });

    stream.once('error', () => {
      clearTimeout(timeout);
    });

    return stream;
  }

  _selectSessionId() {
    if (typeof this._server.getActiveSessionId === 'function') {
      return this._server.getActiveSessionId();
    }
    return null;
  }

  _allocateReqid() {
    this._reqidCounter++;
    if (this._reqidCounter > 0x7FFF) this._reqidCounter = 1;
    return this._reqidCounter;
  }

  /**
   * xhttp 帧处理入口（由 xhttpHandler 调用）。
   *
   * @param {object} frame — 解码后的帧
   * @param {string} sessionId — 来源 session
   */
  handleFrame(frame, sessionId) {
    // Forward CONNECT: client initiates connection through tunnel to target
    if (frame.type === FRAME_TYPES.CONNECT) {
      this._handleForwardConnect(frame, sessionId);
      return;
    }

    // PING → PONG
    if (frame.type === FRAME_TYPES.PING) {
      this._server.sendFrame({
        type: FRAME_TYPES.PONG,
        payload: frame.payload
      }, sessionId);
      return;
    }

    // PONG — 忽略（xhttp 模式无心跳）
    if (frame.type === FRAME_TYPES.PONG) {
      return;
    }

    // PADDING — 忽略
    if (frame.type === FRAME_TYPES.PADDING) {
      return;
    }

    // Look up the request associated with this reqid
    const entry = this._activeRequests.get(frame.reqid);
    if (!entry) return;

    switch (frame.type) {
      case FRAME_TYPES.CONNECT_OK: {
        entry.lastActivityAt = Date.now();
        entry.confirmed = true;
        entry.stream.emit('tunnel-connect-ok');
        break;
      }

      case FRAME_TYPES.DATA: {
        entry.lastActivityAt = Date.now();
        if (entry.direction === 'forward' && entry._anyproxySocket) {
          const canContinue = entry._anyproxySocket.write(frame.data);
          if (!canContinue) {
            // 背压：暂停 uploadQueue 消费（简单方案：用 setImmediate 延迟）
            // xhttp 模式下无法直接暂停 HTTP POST，此处依赖 TCP 层流控
          }
        } else {
          entry.stream.push(frame.data);
        }
        break;
      }

      case FRAME_TYPES.CLOSE: {
        entry.lastActivityAt = Date.now();
        if (entry.direction === 'forward' && entry._anyproxySocket) {
          entry._anyproxySocket.destroy();
        }
        this._clearActiveRequest(frame.reqid);
        if (entry.direction === 'reverse') {
          entry.stream.push(null);
        }
        break;
      }

      case FRAME_TYPES.CONNECT_FAILED: {
        entry.lastActivityAt = Date.now();
        if (entry.direction === 'forward' && entry._anyproxySocket) {
          entry._anyproxySocket.destroy();
        }
        entry.stream.destroy(new Error('tunnel-connect-failed'));
        this._clearActiveRequest(frame.reqid);
        break;
      }
    }
  }

  _handleForwardConnect(frame, sessionId) {
    const reqid = frame.reqid;
    const targetHost = frame.addr;
    const targetPort = frame.port;

    if (this.matchesTunnelDomain(targetHost)) {
      console.warn(`[Tunnel] Reject recursive forward CONNECT ${reqid}: ${targetHost}:${targetPort}`);
      this._server.sendFrame({ type: FRAME_TYPES.CONNECT_FAILED, reqid }, sessionId);
      return;
    }

    // Concurrency limit
    if (this._forwardCount >= MAX_FORWARD_CONNECTIONS) {
      console.log(`[Tunnel] Forward rejected: too many concurrent connections (${this._forwardCount}/${MAX_FORWARD_CONNECTIONS}) reqid=${reqid}`);
      this._server.sendFrame({ type: FRAME_TYPES.CONNECT_FAILED, reqid }, sessionId);
      return;
    }

    console.log(`[Tunnel] Forward CONNECT ${reqid}: ${targetHost}:${targetPort} (active=${this._forwardCount})`);

    const stream = new TunnelDuplex(this, reqid);
    const entry = {
      reqid, stream, confirmed: false, timeout: null,
      direction: 'forward', _anyproxySocket: null,
      sessionId, lastActivityAt: Date.now()
    };
    this._activeRequests.set(reqid, entry);

    const anyproxySocket = new net.Socket();
    anyproxySocket.setNoDelay(true);
    anyproxySocket.setKeepAlive(true, 60000);
    entry._anyproxySocket = anyproxySocket;

    let cleaned = false;
    this._forwardCount++;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      this._forwardCount--;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      this._clearActiveRequest(reqid);
      if (!anyproxySocket.destroyed) anyproxySocket.destroy();
    };

    const timeout = setTimeout(() => {
      console.log(`[Tunnel] Forward CONNECT timeout ${targetHost}:${targetPort} (reqid=${reqid})`);
      this._server.sendFrame({ type: FRAME_TYPES.CONNECT_FAILED, reqid }, entry.sessionId);
      cleanup();
    }, 30000);
    entry.timeout = timeout;

    const resetIdleTimer = () => {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = setTimeout(() => {
        console.log(`[Tunnel] Forward idle timeout ${targetHost}:${targetPort} (reqid=${reqid})`);
        cleanup();
      }, FORWARD_IDLE_TIMEOUT);
      entry.idleTimer.unref();
    };

    anyproxySocket.connect(this._proxyPort, '127.0.0.1', () => {
      const connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`;
      anyproxySocket.write(connectReq);
    });

    let responseBuffer = Buffer.alloc(0);
    anyproxySocket.on('data', (data) => {
      if (!entry.confirmed) {
        entry.lastActivityAt = Date.now();
        responseBuffer = Buffer.concat([responseBuffer, data]);
        const headerEnd = responseBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const statusLine = responseBuffer.slice(0, responseBuffer.indexOf('\r\n')).toString();
        if (statusLine.indexOf(' 2') === -1) {
          this._server.sendFrame({ type: FRAME_TYPES.CONNECT_FAILED, reqid }, entry.sessionId);
          cleanup();
          return;
        }

        clearTimeout(timeout);
        entry.confirmed = true;
        this._server.sendFrame({ type: FRAME_TYPES.CONNECT_OK, reqid }, entry.sessionId);

        resetIdleTimer();

        const remaining = responseBuffer.slice(headerEnd + 4);
        if (remaining.length > 0) {
          this._sendDataToClient(reqid, remaining, entry.sessionId).catch(() => {});
        }
        responseBuffer = Buffer.alloc(0);
        return;
      }

      entry.lastActivityAt = Date.now();
      resetIdleTimer();
      this._sendDataToClient(reqid, data, entry.sessionId).catch(() => {});
    });

    anyproxySocket.on('close', () => {
      if (entry.confirmed && this._activeRequests.has(reqid)) {
        this._sendCloseToClient(reqid, entry.sessionId);
      }
      cleanup();
    });

    anyproxySocket.on('error', (err) => {
      console.log(`[Tunnel] Forward anyproxy error ${reqid}: ${err.message}`);
      if (!entry.confirmed) {
        this._server.sendFrame({ type: FRAME_TYPES.CONNECT_FAILED, reqid }, entry.sessionId);
      } else if (this._activeRequests.has(reqid)) {
        this._sendCloseToClient(reqid, entry.sessionId);
      }
      cleanup();
    });
  }

  async _sendDataToClient(reqid, data, sessionId) {
    const entry = this._activeRequests.get(reqid);
    if (entry) entry.lastActivityAt = Date.now();
    for (let offset = 0; offset < data.length; offset += MAX_DATA_CHUNK) {
      const encoded = encodeFrame({
        type: FRAME_TYPES.DATA,
        reqid,
        data: data.slice(offset, offset + MAX_DATA_CHUNK)
      });
      this._server.sendEncodedFrame(sessionId, encoded);
      await new Promise(r => setImmediate(r));
    }
  }

  _sendCloseToClient(reqid, sessionId) {
    const entry = this._activeRequests.get(reqid);
    if (entry) entry.lastActivityAt = Date.now();
    this._server.sendFrame({ type: FRAME_TYPES.CLOSE, reqid }, sessionId);
  }

  _clearActiveRequest(reqid) {
    const entry = this._activeRequests.get(reqid);
    if (!entry) return;
    if (entry.timeout) clearTimeout(entry.timeout);
    this._activeRequests.delete(reqid);
  }

  async _sendData(reqid, data) {
    const entry = this._activeRequests.get(reqid);
    if (!entry) return;
    entry.lastActivityAt = Date.now();
    for (let offset = 0; offset < data.length; offset += MAX_DATA_CHUNK) {
      const encoded = encodeFrame({
        type: FRAME_TYPES.DATA,
        reqid,
        data: data.slice(offset, offset + MAX_DATA_CHUNK)
      });
      this._server.sendEncodedFrame(entry.sessionId, encoded);
      await new Promise(r => setImmediate(r));
    }
  }

  _sendClose(reqid) {
    const entry = this._activeRequests.get(reqid);
    if (!entry) return;
    entry.lastActivityAt = Date.now();
    this._server.sendFrame({ type: FRAME_TYPES.CLOSE, reqid }, entry.sessionId);
    this._clearActiveRequest(reqid);
  }

  reloadConfig(config) {
    this._tunnelDomains = config.tunnel_domains || [];
  }

  getStatus() {
    const counts = typeof this._server.getConnectionCounts === 'function'
      ? this._server.getConnectionCounts()
      : { total: 0 };
    return {
      connected: this._connected,
      clientAddress: this._clientAddress,
      activeRequests: this._activeRequests.size,
      forwardConnections: this._forwardCount,
      maxForwardConnections: MAX_FORWARD_CONNECTIONS,
      connections: counts.total,
      activeConnections: counts.active || 0,
      candidateConnections: counts.candidate || 0,
      drainingConnections: counts.draining || 0
    };
  }

  getSessionActiveRequestCount(sessionId) {
    let count = 0;
    for (const entry of this._activeRequests.values()) {
      if (entry.sessionId === sessionId) count++;
    }
    return count;
  }

  getSessionDrainState(sessionId) {
    let activeCount = 0;
    let lastActivityAt = 0;
    for (const entry of this._activeRequests.values()) {
      if (entry.sessionId !== sessionId) continue;
      activeCount++;
      lastActivityAt = Math.max(lastActivityAt, entry.lastActivityAt || Date.now());
    }
    return { activeCount, lastActivityAt };
  }

  setConnected(sessionId, connected, clientAddress) {
    if (connected) {
      this._connected = true;
      this._clientAddress = clientAddress || this._clientAddress;
      const token = this._server.getSessionToken
        ? this._server.getSessionToken(sessionId)
        : null;
      this._sessionTokens.set(sessionId, token);
      console.log(`[Tunnel] Client session connected: ${sessionId}`);
    } else {
      this._sessionTokens.delete(sessionId);

      // 清理该 session 上的请求
      for (const [reqid, entry] of this._activeRequests) {
        if (entry.sessionId === sessionId) {
          if (entry.timeout) clearTimeout(entry.timeout);
          if (entry.idleTimer) clearTimeout(entry.idleTimer);
          if (entry._anyproxySocket && !entry._anyproxySocket.destroyed) {
            entry._anyproxySocket.destroy();
          }
          if (entry.direction === 'reverse') {
            entry.stream.destroy(new Error('tunnel-disconnected'));
          }
          this._activeRequests.delete(reqid);
        }
      }

      const activeSessionId = this._selectSessionId();
      this._connected = Boolean(activeSessionId);
      if (!this._connected) {
        this._clientAddress = null;
      }
    }
  }
}

class TunnelDuplex extends Duplex {
  constructor(manager, reqid) {
    super({ highWaterMark: 65536 });
    this._manager = manager;
    this._reqid = reqid;
    this.isTunnelStream = true;
  }

  setReqid(reqid) {
    this._reqid = reqid;
  }

  _read() {
    // Data is pushed via manager.handleFrame
  }

  _write(chunk, encoding, callback) {
    if (this._reqid == null) {
      callback(new Error('tunnel-pending-wake'));
      return;
    }
    this._manager._sendData(this._reqid, chunk)
      .then(() => callback())
      .catch(() => callback());
  }

  _final(callback) {
    if (this._reqid != null) this._manager._sendClose(this._reqid);
    callback();
  }

  _destroy(err, callback) {
    if (this._reqid != null) this._manager._sendClose(this._reqid);
    callback(err);
  }
}

module.exports = TunnelManager;
