const { Duplex } = require('stream');
const { FRAME_TYPES, ATYP, MAX_DATA_CHUNK } = require('./protocol');

class TunnelManager {
  constructor(tunnelServer, config) {
    this._server = tunnelServer;
    this._tunnelDomains = config.tunnel_domains || [];
    this._reqidCounter = 0;
    this._activeRequest = null;
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

    if (this._activeRequest) return createErrorStream('tunnel-busy');

    const reqid = this._allocateReqid();
    const stream = new TunnelDuplex(this, reqid);

    this._activeRequest = { reqid, stream, confirmed: false, timeout: null };

    this._server.sendFrame({
      type: FRAME_TYPES.CONNECT,
      reqid,
      atyp: ATYP.DOMAIN,
      addr: host,
      port
    });

    const timeout = setTimeout(() => {
      if (this._activeRequest && this._activeRequest.reqid === reqid && !this._activeRequest.confirmed) {
        console.log(`[Tunnel] CONNECT timeout for ${host}:${port} (reqid=${reqid})`);
        this._activeRequest = null;
        stream.destroy(new Error('tunnel-connect-timeout'));
      }
    }, 30000);
    this._activeRequest.timeout = timeout;

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
    if (this._reqidCounter > 0xFFFF) this._reqidCounter = 1;
    return this._reqidCounter;
  }

  _handleFrame(frame) {
    if (!this._activeRequest) return;
    if (frame.reqid !== undefined && frame.reqid !== this._activeRequest.reqid) return;

    switch (frame.type) {
      case FRAME_TYPES.CONNECT_OK: {
        this._activeRequest.confirmed = true;
        this._activeRequest.stream.emit('tunnel-connect-ok');
        break;
      }

      case FRAME_TYPES.DATA: {
        this._activeRequest.stream.push(frame.data);
        break;
      }

      case FRAME_TYPES.CLOSE: {
        const stream = this._activeRequest.stream;
        this._clearActiveRequest(frame.reqid);
        stream.push(null);
        break;
      }

      case FRAME_TYPES.CONNECT_FAILED: {
        this._activeRequest.stream.destroy(new Error('tunnel-connect-failed'));
        this._clearActiveRequest(frame.reqid);
        break;
      }
    }
  }

  _clearActiveRequest(reqid) {
    if (!this._activeRequest || this._activeRequest.reqid !== reqid) return;
    if (this._activeRequest.timeout) clearTimeout(this._activeRequest.timeout);
    this._activeRequest = null;
  }

  _sendData(reqid, data) {
    if (!this._activeRequest || this._activeRequest.reqid !== reqid) return;
    for (let offset = 0; offset < data.length; offset += MAX_DATA_CHUNK) {
      this._server.sendFrame({
        type: FRAME_TYPES.DATA,
        reqid,
        data: data.slice(offset, offset + MAX_DATA_CHUNK)
      });
    }
  }

  _sendClose(reqid) {
    if (!this._activeRequest || this._activeRequest.reqid !== reqid) return;
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
      activeRequest: this._activeRequest ? this._activeRequest.reqid : null
    };
  }

  setConnected(connected, clientAddress) {
    this._connected = connected;
    this._clientAddress = clientAddress || null;

    if (!connected && this._activeRequest) {
      this._activeRequest.stream.destroy(new Error('tunnel-disconnected'));
      this._activeRequest = null;
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
