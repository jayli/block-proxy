const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const TunnelManager = require('../manager');

function createMockServer() {
  const handlers = [];
  const sentFrames = [];
  const socketA = { name: 'active-a' };
  const socketB = { name: 'active-b' };
  const sockets = new Set([socketA]);
  let activeSocket = socketA;
  let wakeCount = 0;

  return {
    credentials: { username: 'admin', password: 'secret' },
    onFrame: (h) => handlers.push(h),
    sendFrame: (frame, socket) => {
      sentFrames.push({ frame, socket });
      return Promise.resolve(true);
    },
    getSseControlHandler: () => ({
      sendWakeSignal: () => {
        wakeCount += 1;
        return true;
      },
    }),
    getActiveSocket: () => activeSocket,
    getConnectionCounts: () => ({
      active: activeSocket ? 1 : 0,
      candidate: 0,
      draining: Math.max(0, sockets.size - (activeSocket ? 1 : 0)),
      total: sockets.size,
    }),
    _setActiveSocket: (socket) => {
      activeSocket = socket;
      if (socket) sockets.add(socket);
    },
    _emit: (frame, socket = socketA) => handlers.forEach(h => h(frame, socket)),
    _handlers: handlers,
    _sentFrames: sentFrames,
    _wakeCount: () => wakeCount,
    _clientSockets: sockets,
    _socketA: socketA,
    _socketB: socketB,
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
    manager.setConnected(server._socketA, true, '127.0.0.1:12345');
    assert.equal(manager.isAvailable(), true);
  });
});

describe('TunnelManager.forward', () => {
  it('should support multiple concurrent reverse connections', async () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: ['a.com'] });
    manager.setConnected(server._socketA, true);

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
    }, server._socketA);

    assert.deepEqual(server._sentFrames, [
      { frame: { type: 0x81, reqid: 0x8001 }, socket: server._socketA }
    ]);
    assert.equal(manager.getStatus().activeRequests, 0);
  });

  it('selects the current active socket for new reverse forwards', () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: [] });
    manager.setConnected(server._socketA, true);

    const stream1 = manager.forward('first.test', 443, () => {});
    server._setActiveSocket(server._socketB);
    const stream2 = manager.forward('second.test', 443, () => {});

    assert.equal(server._sentFrames[0].socket, server._socketA);
    assert.equal(server._sentFrames[1].socket, server._socketB);
    stream1.destroy();
    stream2.destroy();
  });

  it('stores selected socket and sends existing DATA/CLOSE to the bound socket', async () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: [] });
    manager.setConnected(server._socketA, true);

    const stream = manager.forward('bound.test', 443, () => {});
    const reqid = server._sentFrames[0].frame.reqid;

    server._setActiveSocket(server._socketB);
    await manager._sendData(reqid, Buffer.from('hello'));
    manager._sendClose(reqid);

    assert.equal(server._sentFrames[1].socket, server._socketA);
    assert.equal(server._sentFrames[1].frame.type, 0x02);
    assert.equal(server._sentFrames[2].socket, server._socketA);
    assert.equal(server._sentFrames[2].frame.type, 0x03);
    stream.destroy();
  });

  it('disconnect of one socket clears only entries bound to that socket', () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: [] });
    manager.setConnected(server._socketA, true);

    const streamA = manager.forward('a.test', 443, () => {});
    server._setActiveSocket(server._socketB);
    const streamB = manager.forward('b.test', 443, () => {});

    manager.setConnected(server._socketA, false);

    assert.equal(manager.getStatus().activeRequests, 1);
    const [entry] = manager._activeRequests.values();
    assert.equal(entry.socket, server._socketB);
    streamA.destroy();
    streamB.destroy();
  });

  it('is unavailable when no active socket exists even if a draining socket remains', () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: [] });
    manager.setConnected(server._socketA, true);
    server._setActiveSocket(null);

    manager.setConnected(server._socketA, false);

    assert.equal(manager.isAvailable(), false);
  });

  it('reports active and draining connection counts from the server', () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: [] });
    manager.setConnected(server._socketA, true, 'client');
    server._setActiveSocket(server._socketB);

    const status = manager.getStatus();

    assert.equal(status.connections, 2);
    assert.equal(status.activeConnections, 1);
    assert.equal(status.drainingConnections, 1);
  });

  it('wakes a sleeping client when disconnected instead of returning tunnel-disconnected', async () => {
    const server = createMockServer();
    server._setActiveSocket(null);
    const manager = new TunnelManager(server, { tunnel_domains: [] });
    const token = manager._computeToken();
    manager.markClientSleeping(token);

    const stream = manager.forward('sleep.test', 443, () => {});

    assert.ok(stream.isPendingWakeStream);
    assert.equal(server._wakeCount(), 1);
    stream.destroy();
  });

  it('reuses the in-flight wake promise for concurrent sleeping forwards', async () => {
    const server = createMockServer();
    server._setActiveSocket(null);
    const manager = new TunnelManager(server, { tunnel_domains: [] });
    const token = manager._computeToken();
    manager.markClientSleeping(token);

    const stream1 = manager.forward('one.test', 443, () => {});
    const stream2 = manager.forward('two.test', 443, () => {});

    assert.equal(server._wakeCount(), 1);
    stream1.destroy();
    stream2.destroy();
  });

  it('counts active requests only for the selected socket', () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: [] });
    manager.setConnected(server._socketA, true);

    const streamA = manager.forward('a.test', 443, () => {});
    server._setActiveSocket(server._socketB);
    const streamB = manager.forward('b.test', 443, () => {});

    assert.equal(manager.getSocketActiveRequestCount(server._socketA), 1);
    assert.equal(manager.getSocketActiveRequestCount(server._socketB), 1);
    assert.equal(manager.getSocketActiveRequestCount({ name: 'other' }), 0);
    assert.equal(manager.getSocketDrainState(server._socketA).activeCount, 1);
    assert.ok(manager.getSocketDrainState(server._socketA).lastActivityAt > 0);

    streamA.destroy();
    streamB.destroy();
  });
});
