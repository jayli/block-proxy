import struct
import asyncio
import pytest
from tunnel_client import (
    FRAME_CONNECT, FRAME_DATA, FRAME_CLOSE, FRAME_CONNECT_OK,
    FRAME_CONNECT_FAILED, FRAME_AUTH, FRAME_AUTH_OK, FRAME_ERROR,
    FRAME_PING, FRAME_PONG,
    ATYP_DOMAIN, ATYP_IPV4,
    TunnelAuthFailedError, TunnelClient,
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

    def test_ping_with_payload_roundtrip(self):
        buf = encode_frame(FRAME_PING, payload=b'abc')
        frame = decode_frame_from_buffer(buf)
        assert frame['type'] == FRAME_PING
        assert frame['payload'] == b'abc'

    def test_pong_without_payload_roundtrip(self):
        buf = encode_frame(FRAME_PONG)
        frame = decode_frame_from_buffer(buf)
        assert frame['type'] == FRAME_PONG
        assert frame['payload'] == b''


class TestTunnelClientLifecycle:
    def test_stop_schedules_active_ws_close(self):
        cfg = {
            'server': {
                'address': '127.0.0.1',
                'port': 8002,
                'username': 'u',
                'password': 'p',
                'tls': False,
                'allowInsecure': True,
            },
            'tunnel': {
                'enabled': True,
                'server_address': '127.0.0.1',
                'server_port': 8003,
            },
        }

        class FakeLoop:
            def is_running(self):
                return True

            def call_soon_threadsafe(self, callback, *args):
                callback(*args)

            def create_task(self, coro):
                coro.close()
                return None

            def stop(self):
                pass

        class FakeTask:
            def __init__(self):
                self.cancelled = False

            def cancel(self):
                self.cancelled = True

        tc = TunnelClient(cfg, lambda status, detail='': None)
        tc._running = True
        tc._loop = FakeLoop()
        tc._read_task = FakeTask()
        tc._heartbeat_task = FakeTask()

        tc.stop()

        assert tc._read_task.cancelled is True
        assert tc._heartbeat_task.cancelled is True

    def test_non_retryable_status_is_preserved_after_loop_exits(self):
        statuses = []
        cfg = {
            'server': {
                'address': '127.0.0.1',
                'port': 8002,
                'username': 'u',
                'password': 'p',
                'tls': False,
                'allowInsecure': True,
            },
            'tunnel': {
                'enabled': True,
                'server_address': '127.0.0.1',
                'server_port': 8003,
            },
        }
        tc = TunnelClient(cfg, lambda status, detail='': statuses.append(status))

        async def fail_auth():
            raise TunnelAuthFailedError('bad credentials')

        tc._connect_and_serve = fail_auth
        tc._running = True

        asyncio.run(tc._run_loop())

        assert statuses[-1] == 'auth_failed'
        assert tc.get_status() == 'auth_failed'

    def test_establish_connection_sends_auth_after_ws_connect(self, monkeypatch):
        sent = []

        class FakeWs:
            async def send(self, data):
                sent.append(data)

            async def recv(self):
                return encode_frame(FRAME_AUTH_OK)

        async def fake_connect(*args, **kwargs):
            assert args[0] == 'wss://127.0.0.1:8003/websocket'
            assert kwargs['ping_interval'] is None
            assert kwargs['ping_timeout'] is None
            return FakeWs()

        monkeypatch.setattr('tunnel_client.websockets.connect', fake_connect)

        cfg = {
            'server': {'address': '127.0.0.1', 'username': 'u', 'password': 'p', 'allowInsecure': True},
            'tunnel': {'server_address': '127.0.0.1', 'server_port': 8003},
        }
        tc = TunnelClient(cfg, lambda status, detail='': None)

        ws = asyncio.run(tc._establish_connection('127.0.0.1', 8003, {'username': 'u', 'password': 'p'}))

        assert ws is not None
        frame = decode_frame_from_buffer(sent[0])
        assert frame['type'] == FRAME_AUTH
        assert frame['username'] == 'u'
        assert frame['password'] == 'p'

    def test_http_disguise_fetches_root_and_favicon_before_ws(self, monkeypatch):
        events = []

        class FakeResponse:
            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

        class FakeSession:
            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            def get(self, url):
                events.append(url)
                return FakeResponse()

        class FakeWs:
            async def send(self, data):
                events.append('auth')

            async def recv(self):
                return encode_frame(FRAME_AUTH_OK)

        async def fake_connect(url, **kwargs):
            events.append(url)
            return FakeWs()

        async def fake_sleep(delay):
            events.append('sleep')

        monkeypatch.setattr('tunnel_client.aiohttp.ClientSession', lambda *args, **kwargs: FakeSession())
        monkeypatch.setattr('tunnel_client.websockets.connect', fake_connect)
        monkeypatch.setattr('tunnel_client.asyncio.sleep', fake_sleep)

        cfg = {
            'server': {'address': '127.0.0.1', 'username': 'u', 'password': 'p', 'allowInsecure': True},
            'tunnel': {
                'server_address': '127.0.0.1',
                'server_port': 8003,
                'http_disguise': True,
            },
        }
        tc = TunnelClient(cfg, lambda status, detail='': None)

        asyncio.run(tc._establish_connection('127.0.0.1', 8003, {'username': 'u', 'password': 'p'}))

        assert events[:5] == [
            'https://127.0.0.1:8003/',
            'sleep',
            'https://127.0.0.1:8003/favicon.ico',
            'sleep',
            'wss://127.0.0.1:8003/websocket',
        ]

    def test_handle_requests_echoes_ping_payload(self):
        sent = []

        class FakeWs:
            def __init__(self):
                self.closed = False
                self.messages = [encode_frame(FRAME_PING, payload=b'abc')]

            async def recv(self):
                if self.messages:
                    return self.messages.pop(0)
                raise asyncio.CancelledError()

            async def send(self, data):
                sent.append(data)

            async def close(self):
                self.closed = True

        cfg = {
            'server': {'address': '127.0.0.1', 'username': 'u', 'password': 'p', 'allowInsecure': True},
            'tunnel': {'server_address': '127.0.0.1', 'server_port': 8003},
        }
        tc = TunnelClient(cfg, lambda status, detail='': None)
        tc._running = True

        with pytest.raises(asyncio.CancelledError):
            asyncio.run(tc._handle_requests(FakeWs()))

        frame = decode_frame_from_buffer(sent[0])
        assert frame['type'] == FRAME_PONG
        assert frame['payload'] == b'abc'

    def test_rotation_enabled_by_default(self):
        cfg = {
            'server': {'address': '127.0.0.1', 'username': 'u', 'password': 'p', 'allowInsecure': True},
            'tunnel': {'server_address': '127.0.0.1', 'server_port': 8003},
        }
        tc = TunnelClient(cfg, lambda status, detail='': None)

        assert tc._tunnel_cfg.get('rotation_enabled', True) is True
        assert tc._rotation_task is None

    def test_rotation_failure_keeps_old_active_ws(self):
        class FakeWs:
            async def close(self):
                pass

        cfg = {
            'server': {'address': '127.0.0.1', 'username': 'u', 'password': 'p', 'allowInsecure': True},
            'tunnel': {'server_address': '127.0.0.1', 'server_port': 8003},
        }
        tc = TunnelClient(cfg, lambda status, detail='': None)
        old_ws = FakeWs()
        tc._active_ws = old_ws
        tc._ws = old_ws

        async def fail_establish(addr, port, credentials):
            raise OSError('candidate failed')

        tc._establish_connection = fail_establish

        asyncio.run(tc._rotation_cycle())

        assert tc._active_ws is old_ws
        assert tc._ws is old_ws
        assert tc._candidate_ws is None

    def test_rotation_success_switches_new_requests_to_new_active_ws(self):
        class FakeWs:
            def __init__(self):
                self.closed = False

            async def close(self):
                self.closed = True

            async def recv(self):
                raise asyncio.CancelledError()

        cfg = {
            'server': {'address': '127.0.0.1', 'username': 'u', 'password': 'p', 'allowInsecure': True},
            'tunnel': {
                'server_address': '127.0.0.1',
                'server_port': 8003,
                'rotation_drain_timeout': 0,
            },
        }
        tc = TunnelClient(cfg, lambda status, detail='': None)
        old_ws = FakeWs()
        new_ws = FakeWs()
        tc._active_ws = old_ws
        tc._ws = old_ws
        tc._running = True

        async def establish(addr, port, credentials):
            return new_ws

        async def fake_handle_requests(ws):
            return None

        tc._establish_connection = establish
        tc._handle_requests = fake_handle_requests

        asyncio.run(tc._rotation_cycle())

        assert tc._active_ws is new_ws
        assert tc._ws is new_ws
        assert tc._draining_ws is None
        assert old_ws.closed is True

    def test_rotation_preserves_pending_forward_request_binding(self):
        class FakeWs:
            def __init__(self):
                self.closed = False

            async def close(self):
                self.closed = True

        cfg = {
            'server': {'address': '127.0.0.1', 'username': 'u', 'password': 'p', 'allowInsecure': True},
            'tunnel': {
                'server_address': '127.0.0.1',
                'server_port': 8003,
                'rotation_drain_timeout': 0,
            },
        }
        tc = TunnelClient(cfg, lambda status, detail='': None)
        old_ws = FakeWs()
        new_ws = FakeWs()
        tc._active_ws = old_ws
        tc._ws = old_ws
        tc._forward_requests[1] = {'connected': asyncio.Event(), 'connect_error': None, 'ws': old_ws}

        async def establish(addr, port, credentials):
            return new_ws

        async def fake_handle_requests(ws):
            return None

        tc._establish_connection = establish
        tc._handle_requests = fake_handle_requests

        async def run_rotation_with_pending_request():
            task = asyncio.create_task(tc._rotation_cycle())
            await asyncio.sleep(0.05)

            assert task.done() is False
            assert tc._active_ws is new_ws
            assert tc._ws is new_ws
            assert tc._forward_requests[1]['ws'] is old_ws
            assert old_ws.closed is False

            tc._forward_requests.pop(1)
            await asyncio.wait_for(task, timeout=2)

        asyncio.run(run_rotation_with_pending_request())

        assert old_ws.closed is True

    def test_rotation_new_forward_requests_use_new_ws_while_old_ws_drains(self):
        class FakeWs:
            def __init__(self):
                self.closed = False
                self.sent = []

            async def close(self):
                self.closed = True

            async def send(self, data):
                self.sent.append(data)

        cfg = {
            'server': {'address': '127.0.0.1', 'username': 'u', 'password': 'p', 'allowInsecure': True},
            'tunnel': {
                'server_address': '127.0.0.1',
                'server_port': 8003,
                'rotation_drain_timeout': 0,
            },
        }
        tc = TunnelClient(cfg, lambda status, detail='': None)
        old_ws = FakeWs()
        new_ws = FakeWs()
        tc._active_ws = old_ws
        tc._ws = old_ws
        tc._forward_requests[1] = {'connected': asyncio.Event(), 'connect_error': None, 'ws': old_ws}

        async def establish(addr, port, credentials):
            return new_ws

        async def fake_handle_requests(ws):
            return None

        tc._establish_connection = establish
        tc._handle_requests = fake_handle_requests

        async def run_rotation_and_forward():
            task = asyncio.create_task(tc._rotation_cycle())
            await asyncio.sleep(0.05)

            assert task.done() is False
            assert tc._active_ws is new_ws

            class FakeSock:
                def close(self):
                    pass

            forward_task = asyncio.create_task(tc._forward_connect_async('example.com', 443, FakeSock()))
            await asyncio.sleep(0.05)

            assert tc._forward_requests[0x8000]['ws'] is new_ws

            forward_task.cancel()
            try:
                await forward_task
            except asyncio.CancelledError:
                pass
            tc._forward_requests.pop(1)
            await asyncio.wait_for(task, timeout=2)

        asyncio.run(run_rotation_and_forward())

    def test_rotation_closes_idle_old_ws_after_drain_idle_timeout(self):
        class FakeWs:
            def __init__(self):
                self.closed = False

            async def close(self):
                self.closed = True

        cfg = {
            'server': {'address': '127.0.0.1', 'username': 'u', 'password': 'p', 'allowInsecure': True},
            'tunnel': {
                'server_address': '127.0.0.1',
                'server_port': 8003,
                'rotation_drain_timeout': 0,
                'rotation_drain_idle_timeout': 0.05,
            },
        }
        tc = TunnelClient(cfg, lambda status, detail='': None)
        old_ws = FakeWs()
        new_ws = FakeWs()
        tc._active_ws = old_ws
        tc._ws = old_ws
        tc._forward_requests[1] = {
            'connected': asyncio.Event(),
            'connect_error': None,
            'ws': old_ws,
            'last_activity': 0,
        }

        async def establish(addr, port, credentials):
            return new_ws

        async def fake_handle_requests(ws):
            return None

        tc._establish_connection = establish
        tc._handle_requests = fake_handle_requests

        async def run_rotation_until_idle_timeout():
            await asyncio.wait_for(tc._rotation_cycle(), timeout=0.5)

        asyncio.run(run_rotation_until_idle_timeout())

        assert old_ws.closed is True
