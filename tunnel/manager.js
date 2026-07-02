const { Duplex } = require('stream');
const net = require('net');
const { FRAME_TYPES, ATYP, MAX_DATA_CHUNK } = require('./protocol');

class TunnelManager {
  constructor(tunnelServer, config) {
    this._server = tunnelServer;
    this._tunnelDomains = config.tunnel_domains || [];
    this._proxyPort = config.proxy_port || 8001;
    this._reqidCounter = 0;
    this._activeRequests = new Map();
    this._connected = false;
    this._clientAddress = null;

    this._server.onFrame((frame) => this._handleFrame(frame));
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

    const reqid = this._allocateReqid();
    const stream = new TunnelDuplex(this, reqid);

    this._activeRequests.set(reqid, {
      reqid, stream, confirmed: false, timeout: null, direction: 'reverse'
    });
    const entry = this._activeRequests.get(reqid);

    this._server.sendFrame({
      type: FRAME_TYPES.CONNECT,
      reqid,
      atyp: ATYP.DOMAIN,
      addr: host,
      port
    });

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

  _allocateReqid() {
    this._reqidCounter++;
    if (this._reqidCounter > 0x7FFF) this._reqidCounter = 1;
    return this._reqidCounter;
  }

  _handleFrame(frame) {
    // Forward CONNECT: client initiates connection through tunnel to target
    if (frame.type === FRAME_TYPES.CONNECT) {
      this._handleForwardConnect(frame);
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
          entry._anyproxySocket.write(frame.data);
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

  _handleForwardConnect(frame) {
    const reqid = frame.reqid;
    const targetHost = frame.addr;
    const targetPort = frame.port;

    console.log(`[Tunnel] Forward CONNECT ${reqid}: ${targetHost}:${targetPort}`);

    const stream = new TunnelDuplex(this, reqid);
    const entry = {
      reqid, stream, confirmed: false, timeout: null,
      direction: 'forward', _anyproxySocket: null
    };
    this._activeRequests.set(reqid, entry);

    const anyproxySocket = new net.Socket();
    entry._anyproxySocket = anyproxySocket;

    const cleanup = () => {
      this._clearActiveRequest(reqid);
      if (!anyproxySocket.destroyed) anyproxySocket.destroy();
    };

    const timeout = setTimeout(() => {
      console.log(`[Tunnel] Forward CONNECT timeout ${targetHost}:${targetPort} (reqid=${reqid})`);
      this._server.sendFrame({ type: FRAME_TYPES.CONNECT_FAILED, reqid });
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
          this._server.sendFrame({ type: FRAME_TYPES.CONNECT_FAILED, reqid });
          cleanup();
          return;
        }

        clearTimeout(timeout);
        entry.confirmed = true;
        this._server.sendFrame({ type: FRAME_TYPES.CONNECT_OK, reqid });

        // Forward any remaining data after headers
        const remaining = responseBuffer.substring(headerEnd + 4);
        if (remaining.length > 0) {
          this._sendDataToClient(reqid, Buffer.from(remaining));
        }
        responseBuffer = '';
        return;
      }

      // Relay data from AnyProxy to client
      this._sendDataToClient(reqid, data);
    });

    anyproxySocket.on('close', () => {
      if (entry.confirmed && this._activeRequests.has(reqid)) {
        this._sendCloseToClient(reqid);
      }
      this._clearActiveRequest(reqid);
    });

    anyproxySocket.on('error', (err) => {
      console.log(`[Tunnel] Forward anyproxy error ${reqid}: ${err.message}`);
      if (!entry.confirmed) {
        this._server.sendFrame({ type: FRAME_TYPES.CONNECT_FAILED, reqid });
      } else if (this._activeRequests.has(reqid)) {
        this._sendCloseToClient(reqid);
      }
      cleanup();
    });
  }

  _sendDataToClient(reqid, data) {
    for (let offset = 0; offset < data.length; offset += MAX_DATA_CHUNK) {
      this._server.sendFrame({
        type: FRAME_TYPES.DATA,
        reqid,
        data: data.slice(offset, offset + MAX_DATA_CHUNK)
      });
    }
  }

  _sendCloseToClient(reqid) {
    this._server.sendFrame({ type: FRAME_TYPES.CLOSE, reqid });
  }

  _clearActiveRequest(reqid) {
    const entry = this._activeRequests.get(reqid);
    if (!entry) return;
    if (entry.timeout) clearTimeout(entry.timeout);
    this._activeRequests.delete(reqid);
  }

  _sendData(reqid, data) {
    const entry = this._activeRequests.get(reqid);
    if (!entry) return;
    for (let offset = 0; offset < data.length; offset += MAX_DATA_CHUNK) {
      this._server.sendFrame({
        type: FRAME_TYPES.DATA,
        reqid,
        data: data.slice(offset, offset + MAX_DATA_CHUNK)
      });
    }
  }

  _sendClose(reqid) {
    if (!this._activeRequests.has(reqid)) return;
    this._server.sendFrame({ type: FRAME_TYPES.CLOSE, reqid });
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
    };
  }

  setConnected(connected, clientAddress) {
    this._connected = connected;
    this._clientAddress = clientAddress || null;

    if (!connected) {
      for (const [reqid, entry] of this._activeRequests) {
        if (entry.timeout) clearTimeout(entry.timeout);
        if (entry._anyproxySocket && !entry._anyproxySocket.destroyed) {
          entry._anyproxySocket.destroy();
        }
        if (entry.direction === 'reverse') {
          entry.stream.destroy(new Error('tunnel-disconnected'));
        }
      }
      this._activeRequests.clear();
    }
  }
}

class TunnelDuplex extends Duplex {
  constructor(manager, reqid) {
    super();
    this._manager = manager;
    this._reqid = reqid;
  }

  _read() {
    // Data is pushed via manager._handleFrame
  }

  _write(chunk, encoding, callback) {
    this._manager._sendData(this._reqid, chunk);
    callback();
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
