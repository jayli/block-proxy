const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const WakeBuffer = require('../wakeBuffer');

describe('WakeBuffer', () => {
  it('sends a wake signal and resolves when tunnel reconnects', async () => {
    const sent = [];
    const wakeBuffer = new WakeBuffer({
      wakeTimeout: 50,
      retryIntervalMs: 5,
      sseControlHandler: {
        sendWakeSignal: (token) => {
          sent.push(token);
          return true;
        },
      },
    });

    const promise = wakeBuffer.waitForTunnel('abc');
    assert.deepEqual(sent, ['abc']);

    wakeBuffer.onTunnelReconnected('abc');
    await promise;
  });

  it('does not send duplicate wake events for concurrent waits', async () => {
    const sent = [];
    const wakeBuffer = new WakeBuffer({
      wakeTimeout: 50,
      retryIntervalMs: 5,
      sseControlHandler: {
        sendWakeSignal: (token) => {
          sent.push(token);
          return true;
        },
      },
    });

    const promise1 = wakeBuffer.waitForTunnel('abc');
    const promise2 = wakeBuffer.waitForTunnel('abc');

    assert.equal(promise1, promise2);
    assert.deepEqual(sent, ['abc']);

    wakeBuffer.onTunnelReconnected('abc');
    await Promise.all([promise1, promise2]);
  });

  it('rejects client-offline without retrying when SSE is not active', async () => {
    let attempts = 0;
    const wakeBuffer = new WakeBuffer({
      wakeTimeout: 10,
      retryIntervalMs: 5,
      sseControlHandler: {
        sendWakeSignal: () => {
          attempts += 1;
          return false;
        },
      },
    });

    await assert.rejects(
      wakeBuffer.waitForTunnel('abc'),
      /client-offline/
    );
    assert.equal(attempts, 1);
  });

  it('retries wake three times before timing out', async () => {
    let attempts = 0;
    const wakeBuffer = new WakeBuffer({
      wakeTimeout: 10,
      retryIntervalMs: 5,
      sseControlHandler: {
        sendWakeSignal: () => {
          attempts += 1;
          return true;
        },
      },
    });

    await assert.rejects(
      wakeBuffer.waitForTunnel('abc'),
      /wake-timeout after 3 attempts/
    );
    assert.equal(attempts, 3);
  });
});
