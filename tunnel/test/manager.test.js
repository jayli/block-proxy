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
