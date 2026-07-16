class WakeBuffer {
  constructor(options = {}) {
    this._sseControlHandler = options.sseControlHandler;
    this._wakeTimeout = options.wakeTimeout || 10_000;
    this._maxWakeAttempts = options.maxWakeAttempts || 3;
    this._retryIntervalMs = options.retryIntervalMs || 3_000;
    this._buffers = new Map();
  }

  waitForTunnel(clientToken) {
    let buf = this._buffers.get(clientToken);
    if (buf && buf.promise) return buf.promise;

    buf = { promise: null, resolve: null, reject: null, timer: null };
    this._buffers.set(clientToken, buf);

    const promise = this._wakeWithRetry(clientToken, buf).finally(() => {
      this._cleanup(clientToken);
    });
    buf.promise = promise;
    return promise;
  }

  onTunnelReconnected(clientToken) {
    const buf = this._buffers.get(clientToken);
    if (!buf) return;
    if (buf.timer) clearTimeout(buf.timer);
    if (buf.resolve) buf.resolve();
  }

  onClientDisconnected(clientToken) {
    const buf = this._buffers.get(clientToken);
    if (buf && buf.reject) {
      buf.reject(new Error('client-offline'));
    }
    this._cleanup(clientToken);
  }

  _cleanup(clientToken) {
    const buf = this._buffers.get(clientToken);
    if (!buf) return;
    if (buf.timer) clearTimeout(buf.timer);
    this._buffers.delete(clientToken);
  }

  async _wakeWithRetry(clientToken, buf) {
    for (let attempt = 1; attempt <= this._maxWakeAttempts; attempt += 1) {
      const result = await this._tryWake(clientToken, buf);
      if (result === 'ready') return;
      if (result === 'client-offline') throw new Error('client-offline');
      if (attempt < this._maxWakeAttempts) {
        await delay(this._retryIntervalMs);
      }
    }
    throw new Error('wake-timeout after 3 attempts');
  }

  _tryWake(clientToken, buf) {
    return new Promise((resolve, reject) => {
      buf.resolve = () => resolve('ready');
      buf.reject = reject;
      buf.timer = setTimeout(() => resolve('timeout'), this._wakeTimeout);
      buf.timer.unref();

      const woke = this._sseControlHandler && this._sseControlHandler.sendWakeSignal(clientToken);
      if (!woke) {
        clearTimeout(buf.timer);
        resolve('client-offline');
      }
    });
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = WakeBuffer;
