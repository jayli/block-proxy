const tls = require('tls');
const { FRAME_TYPES, encodeFrame, decodeFrame } = require('./protocol');

class TunnelServer {
  constructor(options) {
    this.port = options.port;
    this.cert = options.cert;
    this.key = options.key;
    this.credentials = options.credentials;
    this.onConnect = options.onConnect || (() => {});
    this.onDisconnect = options.onDisconnect || (() => {});

    this._frameHandlers = [];
    this._clientSockets = new Set();
    this._server = null;

    // Per-socket receive buffer: Map<socket, Buffer>
    this._socketBuffers = new Map();

    // Heartbeat state
    this._pingTimer = null;
    this._socketPongTimes = new Map();
  }

  start() {
    return new Promise((resolve) => {
      const tlsOptions = {
        key: this.key,
        cert: this.cert,
        minVersion: 'TLSv1.2',
        sessionTimeout: 300
      };

      this._server = tls.createServer(tlsOptions, (socket) => {
        this._handleConnection(socket);
      });

      this._server.listen(this.port, () => {
        console.log(`[Tunnel] Server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    this._stopHeartbeat();
    for (const socket of this._clientSockets) {
      socket.destroy();
    }
    this._clientSockets.clear();
    // Destroy all pending sockets
    for (const [socket] of this._socketBuffers) {
      socket.destroy();
    }
    this._socketBuffers.clear();
    if (!this._server) return Promise.resolve();

    const server = this._server;
    this._server = null;
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  _handleConnection(socket) {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60000);

    // Per-socket buffer
    this._socketBuffers.set(socket, Buffer.alloc(0));

    socket.on('data', (chunk) => {
      const buf = this._socketBuffers.get(socket);
      if (!buf) return;
      this._socketBuffers.set(socket, Buffer.concat([buf, chunk]));
      this._processBuffer(socket);
    });

    socket.on('close', () => {
      this._socketBuffers.delete(socket);
      this._socketPongTimes.delete(socket);
      const wasAuthenticated = this._clientSockets.has(socket);
      this._clientSockets.delete(socket);
      if (wasAuthenticated) {
        console.log(`[Tunnel] Client disconnected (${this._clientSockets.size} remaining)`);
        this.onDisconnect(socket);
      }
      if (this._clientSockets.size === 0) {
        this._stopHeartbeat();
      }
    });

    socket.on('error', (err) => {
      console.error('[Tunnel] Socket error:', err.message);
    });
  }

  _processBuffer(socket) {
    let buf = this._socketBuffers.get(socket);
    if (!buf) return;

    while (buf.length >= 2) {
      const length = buf.readUInt16BE(0);
      if (buf.length < 2 + length) break;

      const frameData = buf.slice(0, 2 + length);
      buf = buf.slice(2 + length);
      this._socketBuffers.set(socket, buf);

      try {
        const frame = decodeFrame(frameData);

        if (frame.type === FRAME_TYPES.AUTH && !this._clientSockets.has(socket)) {
          this._handleAuth(socket, frame);
        } else if (this._clientSockets.has(socket)) {
          // Per-socket pong tracking
          if (frame.type === FRAME_TYPES.PONG) {
            this._socketPongTimes.set(socket, Date.now());
          }
          // Forward to handlers with socket reference
          this._frameHandlers.forEach(handler => handler(frame, socket));
        }
      } catch (err) {
        console.error('[Tunnel] Frame decode error:', err.message);
      }
    }
  }

  _handleAuth(socket, frame) {
    const { username, password } = frame;

    if (this._clientSockets.size >= 2) {
      socket.write(encodeFrame({ type: FRAME_TYPES.ERROR, message: 'Tunnel connection limit (2)' }));
      socket.destroy();
      return;
    }

    if (username === this.credentials.username &&
        password === this.credentials.password) {
      this._clientSockets.add(socket);
      // 为新连接初始化 pong 时间（心跳已启动时）
      if (this._pingTimer) {
        this._socketPongTimes.set(socket, Date.now());
      }
      socket.write(encodeFrame({ type: FRAME_TYPES.AUTH_OK }));
      console.log(`[Tunnel] Client authenticated: ${socket.remoteAddress} (${this._clientSockets.size}/2)`);
      if (this._clientSockets.size === 1) {
        this._startHeartbeat();
      }
      this.onConnect(socket, socket.remoteAddress, socket.remotePort);
    } else {
      socket.write(encodeFrame({ type: FRAME_TYPES.AUTH_FAIL }));
      socket.destroy();
    }
  }

  sendFrame(frame, targetSocket) {
    const data = encodeFrame(frame);

    if (targetSocket) {
      if (!this._clientSockets.has(targetSocket)) {
        return Promise.resolve();
      }
      return this._writeToSocket(targetSocket, data);
    }

    const sockets = [...this._clientSockets];
    if (sockets.length === 0) {
      throw new Error('No client connected');
    }
    return Promise.all(sockets.map(s => this._writeToSocket(s, data)));
  }

  _writeToSocket(socket, data) {
    return new Promise((resolve) => {
      if (socket.write(data)) {
        resolve();
      } else {
        const onDrain = () => { socket.removeListener('close', onClose); resolve(); };
        const onClose = () => { socket.removeListener('drain', onDrain); resolve(); };
        socket.once('drain', onDrain);
        socket.once('close', onClose);
      }
    });
  }

  onFrame(handler) {
    this._frameHandlers.push(handler);
  }

  // --- Heartbeat ---

  _startHeartbeat() {
    this._stopHeartbeat();
    for (const socket of this._clientSockets) {
      this._socketPongTimes.set(socket, Date.now());
    }

    this._pingTimer = setInterval(() => {
      if (this._clientSockets.size === 0) { this._stopHeartbeat(); return; }

      const now = Date.now();
      for (const socket of this._clientSockets) {
        const lastPong = this._socketPongTimes.get(socket) || 0;
        if (now - lastPong > 60000) {
          console.log('[Tunnel] Heartbeat timeout (60s no PONG), destroying socket');
          socket.destroy();
        }
      }

      try {
        this.sendFrame({ type: FRAME_TYPES.PING }).catch(() => {});
      } catch (e) {
        // ignore
      }
    }, 30000);
  }

  _stopHeartbeat() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    this._socketPongTimes.clear();
  }
}

module.exports = TunnelServer;
