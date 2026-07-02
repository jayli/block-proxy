const FRAME_TYPES = {
  CONNECT:        0x01,
  DATA:           0x02,
  CLOSE:          0x03,
  CONNECT_OK:     0x04,
  PING:           0x10,
  PONG:           0x11,
  AUTH:           0x20,
  AUTH_OK:        0x21,
  AUTH_FAIL:      0x22,
  ERROR:          0x23,
  CONNECT_FAILED: 0x81,
};

const ATYP = {
  IPV4:   0x01,
  DOMAIN: 0x03,
  IPV6:   0x04,
};

const MAX_FRAME_PAYLOAD = 0xFFFF;
const DATA_HEADER_LEN = 3; // type(1) + reqid(2)
const MAX_DATA_CHUNK = MAX_FRAME_PAYLOAD - DATA_HEADER_LEN;

function encodeAddress(atyp, addr) {
  if (atyp === ATYP.IPV4) {
    const parts = addr.split('.').map(Number);
    return Buffer.from([atyp, ...parts]);
  }
  if (atyp === ATYP.DOMAIN) {
    const addrBuf = Buffer.from(addr, 'utf8');
    return Buffer.concat([Buffer.from([atyp, addrBuf.length]), addrBuf]);
  }
  if (atyp === ATYP.IPV6) {
    const addrBuf = Buffer.isBuffer(addr) ? addr : Buffer.from(addr.replace(/:/g, ''), 'hex');
    return Buffer.concat([Buffer.from([atyp]), addrBuf]);
  }
  throw new Error(`Unknown ATYP: 0x${atyp.toString(16)}`);
}

function decodeAddress(buffer, offset) {
  const atyp = buffer[offset++];
  if (atyp === ATYP.IPV4) {
    const addr = `${buffer[offset]}.${buffer[offset+1]}.${buffer[offset+2]}.${buffer[offset+3]}`;
    return { atyp, addr, bytesRead: 5 };
  }
  if (atyp === ATYP.DOMAIN) {
    const len = buffer[offset];
    const addr = buffer.slice(offset + 1, offset + 1 + len).toString('utf8');
    return { atyp, addr, bytesRead: 2 + len };
  }
  if (atyp === ATYP.IPV6) {
    const addr = buffer.slice(offset, offset + 16).toString('hex');
    return { atyp, addr, bytesRead: 17 };
  }
  throw new Error(`Unknown ATYP: 0x${atyp.toString(16)}`);
}

function encodeFrame(frame) {
  let payload;

  switch (frame.type) {
    case FRAME_TYPES.CONNECT: {
      const addrBuf = encodeAddress(frame.atyp, frame.addr);
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(frame.port, 0);
      payload = Buffer.concat([
        Buffer.from([frame.type, frame.reqid >> 8, frame.reqid & 0xFF]),
        addrBuf,
        portBuf
      ]);
      break;
    }

    case FRAME_TYPES.DATA: {
      payload = Buffer.concat([
        Buffer.from([frame.type, frame.reqid >> 8, frame.reqid & 0xFF]),
        frame.data
      ]);
      break;
    }

    case FRAME_TYPES.CLOSE:
    case FRAME_TYPES.CONNECT_OK:
    case FRAME_TYPES.CONNECT_FAILED: {
      payload = Buffer.from([
        frame.type, frame.reqid >> 8, frame.reqid & 0xFF
      ]);
      break;
    }

    case FRAME_TYPES.PING:
    case FRAME_TYPES.PONG:
    case FRAME_TYPES.AUTH_OK:
    case FRAME_TYPES.AUTH_FAIL: {
      payload = Buffer.from([frame.type]);
      break;
    }

    case FRAME_TYPES.AUTH: {
      const uBuf = Buffer.from(frame.username, 'utf8');
      const pBuf = Buffer.from(frame.password, 'utf8');
      payload = Buffer.concat([
        Buffer.from([frame.type, uBuf.length]),
        uBuf,
        Buffer.from([pBuf.length]),
        pBuf
      ]);
      break;
    }

    case FRAME_TYPES.ERROR: {
      const mBuf = Buffer.from(frame.message || '', 'utf8');
      payload = Buffer.concat([
        Buffer.from([frame.type, mBuf.length]),
        mBuf
      ]);
      break;
    }

    default:
      throw new Error(`Unknown frame type: 0x${frame.type.toString(16)}`);
  }

  if (payload.length > MAX_FRAME_PAYLOAD) {
    throw new Error(`Frame too large: ${payload.length} > ${MAX_FRAME_PAYLOAD}`);
  }

  const header = Buffer.alloc(2);
  header.writeUInt16BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2) throw new Error('Buffer too short');

  const length = buffer.readUInt16BE(0);
  if (buffer.length < 2 + length) throw new Error('Incomplete frame');

  const payload = buffer.slice(2, 2 + length);
  const type = payload[0];
  let offset = 1;

  switch (type) {
    case FRAME_TYPES.CONNECT: {
      const reqid = (payload[offset] << 8) | payload[offset + 1];
      offset += 2;
      const addrResult = decodeAddress(payload, offset);
      offset += addrResult.bytesRead;
      const port = payload.readUInt16BE(offset);
      return { type, reqid, atyp: addrResult.atyp, addr: addrResult.addr, port, bytesRead: 2 + length };
    }

    case FRAME_TYPES.DATA: {
      const reqid = (payload[offset] << 8) | payload[offset + 1];
      offset += 2;
      return { type, reqid, data: payload.slice(offset), bytesRead: 2 + length };
    }

    case FRAME_TYPES.CLOSE:
    case FRAME_TYPES.CONNECT_OK:
    case FRAME_TYPES.CONNECT_FAILED: {
      const reqid = (payload[offset] << 8) | payload[offset + 1];
      return { type, reqid, bytesRead: 2 + length };
    }

    case FRAME_TYPES.PING:
    case FRAME_TYPES.PONG:
    case FRAME_TYPES.AUTH_OK:
    case FRAME_TYPES.AUTH_FAIL: {
      return { type, bytesRead: 2 + length };
    }

    case FRAME_TYPES.AUTH: {
      const uLen = payload[offset++];
      const username = payload.slice(offset, offset + uLen).toString('utf8');
      offset += uLen;
      const pLen = payload[offset++];
      const password = payload.slice(offset, offset + pLen).toString('utf8');
      return { type, username, password, bytesRead: 2 + length };
    }

    case FRAME_TYPES.ERROR: {
      const mLen = payload[offset++];
      const message = payload.slice(offset, offset + mLen).toString('utf8');
      return { type, message, bytesRead: 2 + length };
    }

    default:
      throw new Error(`Unknown frame type: 0x${type.toString(16)}`);
  }
}

module.exports = {
  FRAME_TYPES,
  ATYP,
  MAX_FRAME_PAYLOAD,
  MAX_DATA_CHUNK,
  encodeFrame,
  decodeFrame,
  encodeAddress,
  decodeAddress
};
