import struct
import pytest
from tunnel_client import (
    FRAME_CONNECT, FRAME_DATA, FRAME_CLOSE, FRAME_CONNECT_OK,
    FRAME_CONNECT_FAILED, FRAME_AUTH, FRAME_AUTH_OK, FRAME_ERROR,
    ATYP_DOMAIN, ATYP_IPV4,
    encode_frame, decode_frame_from_buffer
)


class TestEncodeFrame:
    def test_auth_frame(self):
        buf = encode_frame(FRAME_AUTH, username='admin', password='secret')
        length = struct.unpack('!H', buf[:2])[0]
        assert buf[2] == FRAME_AUTH

    def test_connect_ok_frame(self):
        buf = encode_frame(FRAME_CONNECT_OK, reqid=7)
        length = struct.unpack('!H', buf[:2])[0]
        assert length == 3  # type(1) + reqid(2)
        assert buf[2] == FRAME_CONNECT_OK
        reqid = struct.unpack('!H', buf[3:5])[0]
        assert reqid == 7

    def test_connect_failed_frame(self):
        buf = encode_frame(FRAME_CONNECT_FAILED, reqid=3)
        assert buf[2] == FRAME_CONNECT_FAILED

    def test_connect_frame_with_domain(self):
        buf = encode_frame(FRAME_CONNECT, reqid=1, atyp=ATYP_DOMAIN,
                          addr='example.com', port=443)
        assert buf[2] == FRAME_CONNECT


class TestDecodeFrame:
    def test_decode_connect_ok(self):
        buf = encode_frame(FRAME_CONNECT_OK, reqid=42)
        frame = decode_frame_from_buffer(buf)
        assert frame['type'] == FRAME_CONNECT_OK
        assert frame['reqid'] == 42

    def test_decode_connect(self):
        buf = encode_frame(FRAME_CONNECT, reqid=1, atyp=ATYP_DOMAIN,
                          addr='internal.corp.net', port=443)
        frame = decode_frame_from_buffer(buf)
        assert frame['type'] == FRAME_CONNECT
        assert frame['reqid'] == 1
        assert frame['addr'] == 'internal.corp.net'
        assert frame['port'] == 443

    def test_decode_data(self):
        data = b'hello world'
        buf = encode_frame(FRAME_DATA, reqid=5, data=data)
        frame = decode_frame_from_buffer(buf)
        assert frame['type'] == FRAME_DATA
        assert frame['reqid'] == 5
        assert frame['data'] == data

    def test_decode_error(self):
        buf = encode_frame(FRAME_ERROR, message='Port occupied')
        frame = decode_frame_from_buffer(buf)
        assert frame['type'] == FRAME_ERROR
        assert frame['message'] == 'Port occupied'
