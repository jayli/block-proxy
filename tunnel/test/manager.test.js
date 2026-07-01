const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const TunnelManager = require('../manager');

function createMockServer() {
  const handlers = [];
  return {
    onFrame: (h) => handlers.push(h),
    sendFrame: () => {},
    _emit: (frame) => handlers.forEach(h => h(frame)),
    _handlers: handlers
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
    const manager = new TunnelManager(createMockServer(), { tunnel_domains: [] });
    manager.setConnected(true, '127.0.0.1:12345');
    assert.equal(manager.isAvailable(), true);
  });
});

describe('TunnelManager.forward', () => {
  it('should return error stream when busy (single concurrent)', async () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: ['a.com'] });
    manager.setConnected(true);

    const stream1 = manager.forward('a.com', 443, () => {});
    assert.ok(stream1, 'First forward should return stream');

    const stream2 = manager.forward('b.com', 443, () => {});
    assert.ok(stream2, 'Second forward should return error stream');
    const [busyErr] = await once(stream2, 'error');
    assert.equal(busyErr.message, 'tunnel-busy');

    stream1.destroy();
  });

  it('should return error stream when disconnected', async () => {
    const server = createMockServer();
    const manager = new TunnelManager(server, { tunnel_domains: ['a.com'] });

    const stream = manager.forward('a.com', 443, () => {});
    assert.ok(stream, 'Disconnected forward should return error stream');
    const [disconnectedErr] = await once(stream, 'error');
    assert.equal(disconnectedErr.message, 'tunnel-disconnected');
  });
});
