const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const TunnelManager = require('../manager');
const { decodeFrame } = require('../protocol');

function createMockServer() {
  const handlers = [];
  const sentFrames = [];
  const sessionA = 'session-a';
  const sessionB = 'session-b';
  const sessions = new Set([sessionA]);
  let activeSessionId = sessionA;
  let manager = null;

  return {
    credentials: { username: 'admin', password: 'secret' },
    onFrame: (h) => handlers.push(h),
    sendFrame: (frame, sessionId) => {
      sentFrames.push({ frame, sessionId });
      return Promise.resolve(true);
    },
    sendEncodedFrame: (sessionId, encodedFrame) => {
      sentFrames.push({ frame: decodeFrame(encodedFrame), sessionId });
      return true;
    },
    getActiveSessionId: () => activeSessionId,
    getSessionToken: () => 'token',
    getConnectionCounts: () => ({
      active: activeSessionId ? 1 : 0,
      candidate: 0,
      draining: Math.max(0, sessions.size - (activeSessionId ? 1 : 0)),
      total: sessions.size,
    }),
    setTunnelManager: (value) => { manager = value; },
    _setActiveSessionId: (sessionId) => {
      activeSessionId = sessionId;
      if (sessionId) sessions.add(sessionId);
    },
    _emit: (frame, sessionId = sessionA) => {
      if (manager) {
        manager.handleFrame(frame, sessionId);
      }
      handlers.forEach(h => h(frame, sessionId));
    },
    _handlers: handlers,
    _sentFrames: sentFrames,
    _sessions: sessions,
    _sessionA: sessionA,
    _sessionB: sessionB,
  };
}

describe('TunnelManager.matchesTunnelDomain', () => {
  it('should match exact domain', () => {
    const manager = new TunnelManager(createMockServer(), { tunnel_domains: ['example.com'] });
    assert.equal(manager.matchesTunnelDomain('example.com'), true);
    assert.equal(manager.matchesTunnelDomain('other.com'), false);
  });

  it('should match subdomain', () => {
    const manager = new TunnelManager(createMockServer(), { tunnel_domains: ['example.com'] });
    assert.equal(manager.matchesTunnelDomain('sub.example.com'), true);
    assert.equal(manager.matchesTunnelDomain('deep.sub.example.com'), true);
  });

  it('should NOT match partial domain suffix', () => {
    const manager = new TunnelManager(createMockServer(), { tunnel_domains: ['example.com'] });
    assert.equal(manager.matchesTunnelDomain('notexample.com'), false);
    assert.equal(manager.matchesTunnelDomain('example.com.evil.com'), false);
  });

  it('should match regardless of connection state', () => {
    const manager = new TunnelManager(createMockServer(), { tunnel_domains: ['a.com'] });
    assert.equal(manager.matchesTunnelDomain('a.com'), true);
    assert.equal(manager.isAvailable(), false);
  });
});

describe('TunnelManager.isAvailable', () => {
  it('should be false when no client connected', () => {
    const manager = new TunnelManager(createMockServer(), { tunnel_domains: [] });
    assert.equal(manager.isAvailable(), false);
  });

  it('should be true after setConnected(true)', () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: [] });
    manager.setConnected(server._sessionA, true, '127.0.0.1:12345');
    assert.equal(manager.isAvailable(), true);
  });
});

describe('TunnelManager.forward', () => {
  it('should support multiple concurrent reverse connections', async () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: ['a.com'] });
    manager.setConnected(server._sessionA, true);

    const stream1 = manager.forward('a.com', 443, () => {});
    assert.ok(stream1, 'First forward should return stream');

    const stream2 = manager.forward('b.com', 443, () => {});
    assert.ok(stream2, 'Second forward should return stream');

    stream1.destroy();
    stream2.destroy();
  });

  it('should return error stream when disconnected', async () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: ['a.com'] });

    const stream = manager.forward('a.com', 443, () => {});
    assert.ok(stream, 'Disconnected forward should return error stream');
    const [disconnectedErr] = await once(stream, 'error');
    assert.equal(disconnectedErr.message, 'tunnel-disconnected');
  });

  it('rejects reverse forwards above the configured concurrency limit', async () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, {
      tunnel_domains: ['a.com'],
      maxReverseConnections: 1,
    });
    manager.setConnected(server._sessionA, true);

    const first = manager.forward('a.com', 443, () => {});
    const second = manager.forward('b.com', 443, () => {});

    const [limitErr] = await once(second, 'error');
    assert.equal(limitErr.message, 'tunnel-reverse-limit');
    assert.equal(manager.getStatus().reverseConnections, 1);

    first.destroy();
  });

  it('cleans up established idle reverse forwards', async () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, {
      tunnel_domains: ['a.com'],
      reverseIdleTimeoutMs: 20,
    });
    manager.setConnected(server._sessionA, true);

    const stream = manager.forward('idle.test', 443, () => {});
    const reqid = server._sentFrames[0].frame.reqid;
    server._emit({ type: 0x04, reqid }, server._sessionA);

    // 生产 idle timer 已 unref；测试自身保留一个引用计时器，确保能观察其结果。
    const [idleErr] = await Promise.all([
      once(stream, 'error').then(([error]) => error),
      new Promise(resolve => setTimeout(resolve, 40)),
    ]).then(([error]) => [error]);
    assert.equal(idleErr.message, 'tunnel-reverse-idle-timeout');
    assert.equal(manager.getStatus().activeRequests, 0);
    assert.equal(manager.getStatus().reverseConnections, 0);
  });

  it('logs tunnel stats with connection counters and fd count', async () => {
    const logs = [];
    const server = createMockServer();
    const manager = new TunnelManager(server, {
      tunnel_domains: ['a.com'],
      statsLogIntervalMs: 20,
      fdCountProvider: () => 44,
      logger: { log: (message) => logs.push(message), warn: () => {} },
    });
    manager.setConnected(server._sessionA, true);

    const stream = manager.forward('stats.test', 443, () => {});

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(logs.some((line) =>
      line.includes('[Tunnel] stats') &&
      line.includes('activeRequests=1') &&
      line.includes('reverseConnections=1') &&
      line.includes('forwardConnections=0') &&
      line.includes('sessions=1') &&
      line.includes('activeSessions=1') &&
      line.includes('fds=44')
    ));

    stream.destroy();
  });

  it('should reject recursive forward CONNECT to tunnel domains', () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, {
      tunnel_domains: ['a.com'],
      proxy_port: 65535
    });

    server._emit({
      type: 0x01,
      reqid: 0x8001,
      atyp: 0x03,
      addr: 'a.com',
      port: 443
    }, server._sessionA);

    assert.deepEqual(server._sentFrames, [
      { frame: { type: 0x81, reqid: 0x8001 }, sessionId: server._sessionA }
    ]);
    assert.equal(manager.getStatus().activeRequests, 0);
  });

  it('selects the current active session for new reverse forwards', () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: [] });
    manager.setConnected(server._sessionA, true);

    const stream1 = manager.forward('first.test', 443, () => {});
    server._setActiveSessionId(server._sessionB);
    const stream2 = manager.forward('second.test', 443, () => {});

    assert.equal(server._sentFrames[0].sessionId, server._sessionA);
    assert.equal(server._sentFrames[1].sessionId, server._sessionB);
    stream1.destroy();
    stream2.destroy();
  });

  it('stores selected session and sends existing DATA/CLOSE to the bound session', async () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: [] });
    manager.setConnected(server._sessionA, true);

    const stream = manager.forward('bound.test', 443, () => {});
    const reqid = server._sentFrames[0].frame.reqid;

    server._setActiveSessionId(server._sessionB);
    await manager._sendData(reqid, Buffer.from('hello'));
    manager._sendClose(reqid);

    assert.equal(server._sentFrames[1].sessionId, server._sessionA);
    assert.equal(server._sentFrames[1].frame.type, 0x02);
    assert.equal(server._sentFrames[2].sessionId, server._sessionA);
    assert.equal(server._sentFrames[2].frame.type, 0x03);
    stream.destroy();
  });

  it('clears idle timer when active request is cleared', () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: [] });

    const idleTimer = setTimeout(() => {}, 300000);
    manager._activeRequests.set(123, {
      reqid: 123,
      timeout: null,
      idleTimer,
      sessionId: server._sessionA,
    });

    manager._clearActiveRequest(123);

    assert.equal(manager._activeRequests.has(123), false);
    assert.equal(idleTimer._destroyed, true);
  });

  it('disconnect of one session clears only entries bound to that session', () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: [] });
    manager.setConnected(server._sessionA, true);

    const streamA = manager.forward('a.test', 443, () => {});
    server._setActiveSessionId(server._sessionB);
    const streamB = manager.forward('b.test', 443, () => {});

    manager.setConnected(server._sessionA, false);

    assert.equal(manager.getStatus().activeRequests, 1);
    const [entry] = manager._activeRequests.values();
    assert.equal(entry.sessionId, server._sessionB);
    streamA.destroy();
    streamB.destroy();
  });

  it('is unavailable when no active session exists even if a draining session remains', () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: [] });
    manager.setConnected(server._sessionA, true);
    server._setActiveSessionId(null);

    manager.setConnected(server._sessionA, false);

    assert.equal(manager.isAvailable(), false);
  });

  it('reports active and draining connection counts from the server', () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: [] });
    manager.setConnected(server._sessionA, true, 'client');
    server._setActiveSessionId(server._sessionB);

    const status = manager.getStatus();

    assert.equal(status.connections, 2);
    assert.equal(status.activeConnections, 1);
    assert.equal(status.drainingConnections, 1);
  });

  it('returns disconnected without wake buffering when no active session exists', async () => {
    const server = createMockServer();
    server._setActiveSessionId(null);
    const manager = new TunnelManager(server, { tunnel_domains: [] });

    const stream = manager.forward('sleep.test', 443, () => {});

    const [err] = await once(stream, 'error');
    assert.equal(err.message, 'tunnel-disconnected');
  });

  it('counts active requests only for the selected socket', () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: [] });
    manager.setConnected(server._sessionA, true);

    const streamA = manager.forward('a.test', 443, () => {});
    server._setActiveSessionId(server._sessionB);
    const streamB = manager.forward('b.test', 443, () => {});

    assert.equal(manager.getSessionActiveRequestCount(server._sessionA), 1);
    assert.equal(manager.getSessionActiveRequestCount(server._sessionB), 1);
    assert.equal(manager.getSessionActiveRequestCount('other'), 0);
    assert.equal(manager.getSessionDrainState(server._sessionA).activeCount, 1);
    assert.ok(manager.getSessionDrainState(server._sessionA).lastActivityAt > 0);

    streamA.destroy();
    streamB.destroy();
  });
});

describe('TunnelManager forward idle timeout', () => {
  /**
   * 构造一条已确认（CONNECT_OK）的 forward 连接。
   *
   * forward 方向由客户端发 CONNECT 发起：服务端先连本地 8001，收到
   * "200 Connection Established" 后才开始计 idle。测试里替换 net.Socket
   * 为假 socket，避免真的去连 8001（否则 ECONNREFUSED 会立刻清掉 entry）。
   */
  async function openForward(manager, server, { reqid = 0x8001 } = {}) {
    manager.handleFrame(
      { type: 0x01, reqid, atyp: 0x03, addr: 'api.example.com', port: 443 },
      server._sessionA
    );
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const entry = manager._activeRequests.get(reqid);
    assert.ok(entry, 'forward entry should be registered');
    entry._anyproxySocket.emit(
      'data',
      Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n')
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(entry.confirmed, true);
    return { entry, sock: entry._anyproxySocket };
  }

  /**
   * 用假 socket 替换 net.Socket，模拟本地 8001 通道。
   * 返回恢复函数。
   */
  function installFakeSocket() {
    const { EventEmitter } = require('node:events');
    const net = require('net');
    const original = net.Socket;

    class FakeSocket extends EventEmitter {
      constructor() {
        super();
        this.destroyed = false;
        this.writes = [];
        this._connected = false;
      }
      setNoDelay() {}
      setKeepAlive() {}
      connect(port, host, cb) {
        this.port = port;
        this.host = host;
        this._connected = true;
        setImmediate(cb);
      }
      write(chunk) {
        this.writes.push(chunk);
        return true;
      }
      destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.emit('close');
      }
    }

    net.Socket = FakeSocket;
    return () => { net.Socket = original; };
  }

  function closeFrameCount(server) {
    return server._sentFrames.filter((f) => f.frame && f.frame.type === 0x03).length;
  }

  it('uplink-only traffic keeps the connection alive (no false idle kill)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });
    const restoreSocket = installFakeSocket();
    t.after(restoreSocket);

    const server = createMockServer();
    // 不传 forwardIdleTimeoutMs：走默认 300s，确保该用例在旧实现上必然失败
    // （旧构造函数本来就没有这个配置项，传了也不会生效）。
    const manager = new TunnelManager(server, {
      tunnel_domains: [],
      proxy_port: 8001,
    });
    manager.setConnected(server._sessionA, true);

    await openForward(manager, server);

    // 客户端每 1s 上行一帧，本地 8001 全程不回包（覆盖 2 倍默认超时窗口）
    for (let sec = 1; sec <= 660; sec++) {
      t.mock.timers.tick(1000);
      manager.handleFrame(
        { type: 0x02, reqid: 0x8001, data: Buffer.alloc(256) },
        server._sessionA
      );
    }

    assert.equal(manager.getStatus().activeRequests, 1);
    assert.equal(manager.getStatus().forwardConnections, 1);
    assert.equal(closeFrameCount(server), 0);
  });

  it('downlink-only traffic keeps the connection alive', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });
    const restoreSocket = installFakeSocket();
    t.after(restoreSocket);

    const server = createMockServer();
    const manager = new TunnelManager(server, {
      tunnel_domains: [],
      proxy_port: 8001,
    });
    manager.setConnected(server._sessionA, true);

    const { sock } = await openForward(manager, server);

    // 客户端发完 CONNECT 后不再上行，仅由 8001 持续回包（LLM 流式形态）
    for (let sec = 1; sec <= 660; sec++) {
      t.mock.timers.tick(1000);
      sock.emit('data', Buffer.from('streaming-chunk'));
    }

    assert.equal(manager.getStatus().activeRequests, 1);
    assert.equal(closeFrameCount(server), 0);
  });

  it('idle connection is reclaimed and client is told via CLOSE', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });
    const restoreSocket = installFakeSocket();
    t.after(restoreSocket);

    const server = createMockServer();
    const manager = new TunnelManager(server, {
      tunnel_domains: [],
      proxy_port: 8001,
      forwardIdleTimeoutMs: 5000,
    });
    manager.setConnected(server._sessionA, true);

    await openForward(manager, server);

    t.mock.timers.tick(5001);

    assert.equal(manager.getStatus().activeRequests, 0);
    assert.equal(manager.getStatus().forwardConnections, 0);
    // 超时必须通知客户端，而不是静默销毁
    assert.equal(closeFrameCount(server), 1);
  });

  it('idle timeout is configurable and 0 disables it', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() });
    const restoreSocket = installFakeSocket();
    t.after(restoreSocket);

    const server = createMockServer();
    const manager = new TunnelManager(server, {
      tunnel_domains: [],
      proxy_port: 8001,
      forwardIdleTimeoutMs: 0,
    });
    manager.setConnected(server._sessionA, true);

    await openForward(manager, server);
    t.mock.timers.tick(3_600_000);

    assert.equal(manager.getStatus().activeRequests, 1);
    assert.equal(closeFrameCount(server), 0);
  });

  it('exposes FORWARD_IDLE_TIMEOUT for tests', () => {
    assert.equal(TunnelManager._test.FORWARD_IDLE_TIMEOUT, 300 * 1000);
  });
});
