const { Duplex } = require('stream');
const net = require('net');
const { FRAME_TYPES, ATYP, MAX_DATA_CHUNK } = require('./protocol');

class TunnelManager {
  constructor(tunnelServer, config) {
    this._server = tunnelServer;
    this._tunnelDomains = config.tunnel_domains || [];
    this._proxyPort = config.proxy_port || 8001;
    this._reqidCounter = 0;
    this._rrCounter = 0;
    this._activeRequests = new Map();
    this._connected = false;
    this._clientAddress = null;

    this._server.onFrame((frame, socket) => this._handleFrame(frame, socket));
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
      const { Duplex } = require('stream');
      const stream = new Duplex({ read() {}, write(c, e, cb) { cb(); } });
      process.nextTick(() => stream.destroy(new Error(code)));
      return stream;
    };

    if (!this._connected) return createErrorStream('tunnel-disconnected');

    const socket = this._selectSocket();
    if (!socket) return createErrorStream('tunnel-disconnected');

    const reqid = this._allocateReqid();
    const stream = new TunnelDuplex(this, reqid);

    this._activeRequests.set(reqid, {
      reqid, stream, confirmed: false, timeout: null, direction: 'reverse',
      socket
    });
    const entry = this._activeRequests.get(reqid);

    this._server.sendFrame({
      type: FRAME_TYPES.CONNECT,
      reqid,
      atyp: ATYP.DOMAIN,
      addr: host,
      port
    }, socket);

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

  _selectSocket() {
    const sockets = [...this._server._clientSockets];
    if (sockets.length === 0) return null;
    this._rrCounter++;
    return sockets[this._rrCounter % sockets.length];
  }

  _allocateReqid() {
    this._reqidCounter++;
    if (this._reqidCounter > 0x7FFF) this._reqidCounter = 1;
    return this._reqidCounter;
  }

  _handleFrame(frame, socket) {
    // Forward CONNECT: client initiates connection through tunnel to target
    if (frame.type === FRAME_TYPES.CONNECT) {
      this._handleForwardConnect(frame, socket);
      return;
    }

    // Look up the request associated with this reqid
    const entry = this._activeRequests.get(frame.reqid);
    if (!entry) return;

    switch (frame.type) {
      case FRAME_TYPES.CONNECT_OK: {
        entry.confirmed = true;
        entry.stream.emit('tunnel-connect-ok');
        break;
      }

      case FRAME_TYPES.DATA: {
        if (entry.direction === 'forward' && entry._anyproxySocket) {
          const canContinue = entry._anyproxySocket.write(frame.data);
          if (!canContinue) {
            const tunnelSocket = entry.socket;
            if (tunnelSocket) {
              tunnelSocket.pause();
              entry._anyproxySocket.once('drain', () => tunnelSocket.resume());
            }
          }
        } else {
          entry.stream.push(frame.data);
        }
        break;
      }

      case FRAME_TYPES.CLOSE: {
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
        if (entry.direction === 'forward' && entry._anyproxySocket) {
          entry._anyproxySocket.destroy();
        }
        entry.stream.destroy(new Error('tunnel-connect-failed'));
        this._clearActiveRequest(frame.reqid);
        break;
      }
    }
  }

  _handleForwardConnect(frame, socket) {
    const reqid = frame.reqid;
    const targetHost = frame.addr;
    const targetPort = frame.port;

    console.log(`[Tunnel] Forward CONNECT ${reqid}: ${targetHost}:${targetPort}`);

    const stream = new TunnelDuplex(this, reqid);
    const entry = {
      reqid, stream, confirmed: false, timeout: null,
      direction: 'forward', _anyproxySocket: null,
      socket
    };
    this._activeRequests.set(reqid, entry);

    const anyproxySocket = new net.Socket();
    anyproxySocket.setNoDelay(true);
    anyproxySocket.setKeepAlive(true, 60000);
    entry._anyproxySocket = anyproxySocket;

    const cleanup = () => {
      this._clearActiveRequest(reqid);
      if (!anyproxySocket.destroyed) anyproxySocket.destroy();
    };

    const timeout = setTimeout(() => {
      console.log(`[Tunnel] Forward CONNECT timeout ${targetHost}:${targetPort} (reqid=${reqid})`);
      this._server.sendFrame({ type: FRAME_TYPES.CONNECT_FAILED, reqid }, entry.socket);
      cleanup();
    }, 30000);
    entry.timeout = timeout;

    anyproxySocket.connect(this._proxyPort, '127.0.0.1', () => {
      const connectReq = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`;
      anyproxySocket.write(connectReq);
    });

    let responseBuffer = '';
    anyproxySocket.on('data', (data) => {
      if (!entry.confirmed) {
        responseBuffer += data.toString();
        const headerEnd = responseBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const statusLine = responseBuffer.substring(0, responseBuffer.indexOf('\r\n'));
        if (statusLine.indexOf(' 2') === -1) {
          this._server.sendFrame({ type: FRAME_TYPES.CONNECT_FAILED, reqid }, entry.socket);
          cleanup();
          return;
        }

        clearTimeout(timeout);
        entry.confirmed = true;
        this._server.sendFrame({ type: FRAME_TYPES.CONNECT_OK, reqid }, entry.socket);

        // Forward any remaining data after headers
        const remaining = responseBuffer.substring(headerEnd + 4);
        if (remaining.length > 0) {
          this._sendDataToClient(reqid, Buffer.from(remaining), entry.socket).catch(() => {});
        }
        responseBuffer = '';
        return;
      }

      // Relay data from AnyProxy to client
      this._sendDataToClient(reqid, data, entry.socket).catch(() => {});
    });

    anyproxySocket.on('close', () => {
      if (entry.confirmed && this._activeRequests.has(reqid)) {
        this._sendCloseToClient(reqid, entry.socket);
      }
      this._clearActiveRequest(reqid);
    });

    anyproxySocket.on('error', (err) => {
      console.log(`[Tunnel] Forward anyproxy error ${reqid}: ${err.message}`);
      if (!entry.confirmed) {
        this._server.sendFrame({ type: FRAME_TYPES.CONNECT_FAILED, reqid }, entry.socket);
      } else if (this._activeRequests.has(reqid)) {
        this._sendCloseToClient(reqid, entry.socket);
      }
      cleanup();
    });
  }

  async _sendDataToClient(reqid, data, socket) {
    for (let offset = 0; offset < data.length; offset += MAX_DATA_CHUNK) {
      await this._server.sendFrame({
        type: FRAME_TYPES.DATA,
        reqid,
        data: data.slice(offset, offset + MAX_DATA_CHUNK)
      }, socket);
      await new Promise(r => setImmediate(r));
    }
  }

  _sendCloseToClient(reqid, socket) {
    this._server.sendFrame({ type: FRAME_TYPES.CLOSE, reqid }, socket);
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
    for (let offset = 0; offset < data.length; offset += MAX_DATA_CHUNK) {
      await this._server.sendFrame({
        type: FRAME_TYPES.DATA,
        reqid,
        data: data.slice(offset, offset + MAX_DATA_CHUNK)
      }, entry.socket);
      await new Promise(r => setImmediate(r));
    }
  }

  _sendClose(reqid) {
    const entry = this._activeRequests.get(reqid);
    if (!entry) return;
    this._server.sendFrame({ type: FRAME_TYPES.CLOSE, reqid }, entry.socket);
    this._clearActiveRequest(reqid);
  }

  reloadConfig(config) {
    this._tunnelDomains = config.tunnel_domains || [];
  }

  getStatus() {
    return {
      connected: this._connected,
      clientAddress: this._clientAddress,
      activeRequests: this._activeRequests.size,
      connections: this._server._clientSockets.size
    };
  }

  setConnected(socket, connected, clientAddress) {
    if (connected) {
      this._connected = true;
      this._clientAddress = clientAddress || this._clientAddress;
    } else {
      // 只清理该 socket 上的请求
      for (const [reqid, entry] of this._activeRequests) {
        if (entry.socket === socket) {
          if (entry.timeout) clearTimeout(entry.timeout);
          if (entry._anyproxySocket && !entry._anyproxySocket.destroyed) {
            entry._anyproxySocket.destroy();
          }
          if (entry.direction === 'reverse') {
            entry.stream.destroy(new Error('tunnel-disconnected'));
          }
          this._activeRequests.delete(reqid);
        }
      }
      // 根据剩余连接数更新状态
      this._connected = this._server._clientSockets.size > 0;
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
  }

  _read() {
    // Data is pushed via manager._handleFrame
  }

  _write(chunk, encoding, callback) {
    this._manager._sendData(this._reqid, chunk)
      .then(() => callback())
      .catch(() => callback());
  }

  _final(callback) {
    this._manager._sendClose(this._reqid);
    callback();
  }

  _destroy(err, callback) {
    this._manager._sendClose(this._reqid);
    callback(err);
  }
}

module.exports = TunnelManager;
