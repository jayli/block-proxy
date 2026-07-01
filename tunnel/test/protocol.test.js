const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { FRAME_TYPES, ATYP, encodeFrame, decodeFrame } = require('../protocol');

describe('Protocol encodeFrame/decodeFrame', () => {
  it('should roundtrip CONNECT frame with domain address', () => {
    const frame = {
      type: FRAME_TYPES.CONNECT,
      reqid: 1,
      atyp: ATYP.DOMAIN,
      addr: 'example.com',
      port: 443
    };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    assert.equal(decoded.type, FRAME_TYPES.CONNECT);
    assert.equal(decoded.reqid, 1);
    assert.equal(decoded.atyp, ATYP.DOMAIN);
    assert.equal(decoded.addr, 'example.com');
    assert.equal(decoded.port, 443);
  });

  it('should roundtrip CONNECT frame with IPv4 address', () => {
    const frame = {
      type: FRAME_TYPES.CONNECT,
      reqid: 2,
      atyp: ATYP.IPV4,
      addr: '10.0.1.100',
      port: 80
    };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    assert.equal(decoded.type, FRAME_TYPES.CONNECT);
    assert.equal(decoded.atyp, ATYP.IPV4);
    assert.equal(decoded.addr, '10.0.1.100');
    assert.equal(decoded.port, 80);
  });

  it('should roundtrip DATA frame', () => {
    const frame = {
      type: FRAME_TYPES.DATA,
      reqid: 1,
      data: Buffer.from('hello world')
    };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    assert.equal(decoded.type, FRAME_TYPES.DATA);
    assert.equal(decoded.reqid, 1);
    assert.deepEqual(decoded.data, Buffer.from('hello world'));
  });

  it('should roundtrip DATA frame with empty data', () => {
    const frame = { type: FRAME_TYPES.DATA, reqid: 5, data: Buffer.alloc(0) };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    assert.equal(decoded.data.length, 0);
  });

  it('should roundtrip CLOSE frame', () => {
    const frame = { type: FRAME_TYPES.CLOSE, reqid: 42 };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    assert.equal(decoded.type, FRAME_TYPES.CLOSE);
    assert.equal(decoded.reqid, 42);
  });

  it('should roundtrip CONNECT_OK frame', () => {
    const frame = { type: FRAME_TYPES.CONNECT_OK, reqid: 7 };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    assert.equal(decoded.type, FRAME_TYPES.CONNECT_OK);
    assert.equal(decoded.reqid, 7);
  });

  it('should roundtrip CONNECT_FAILED frame', () => {
    const frame = { type: FRAME_TYPES.CONNECT_FAILED, reqid: 3 };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    assert.equal(decoded.type, FRAME_TYPES.CONNECT_FAILED);
    assert.equal(decoded.reqid, 3);
  });

  it('should roundtrip AUTH frame', () => {
    const frame = { type: FRAME_TYPES.AUTH, username: 'admin', password: 's3cret' };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    assert.equal(decoded.type, FRAME_TYPES.AUTH);
    assert.equal(decoded.username, 'admin');
    assert.equal(decoded.password, 's3cret');
  });

  it('should roundtrip simple frames (PING, PONG, AUTH_OK, AUTH_FAIL)', () => {
    for (const type of [FRAME_TYPES.PING, FRAME_TYPES.PONG, FRAME_TYPES.AUTH_OK, FRAME_TYPES.AUTH_FAIL]) {
      const buf = encodeFrame({ type });
      const decoded = decodeFrame(buf);
      assert.equal(decoded.type, type);
    }
  });

  it('should roundtrip ERROR frame with message', () => {
    const frame = { type: FRAME_TYPES.ERROR, message: 'Tunnel port occupied' };
    const buf = encodeFrame(frame);
    const decoded = decodeFrame(buf);
    assert.equal(decoded.type, FRAME_TYPES.ERROR);
    assert.equal(decoded.message, 'Tunnel port occupied');
  });

  it('should throw on unknown frame type', () => {
    assert.throws(() => encodeFrame({ type: 0xFF }), /Unknown frame type/);
  });
});
