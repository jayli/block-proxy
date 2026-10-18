"""HTTP/2 CONNECT 复用客户端（client/h2_upstream.py）。

用 Python 侧的假 h2 服务端做验证：CONNECT 校验 + echo + 连接计数，
不依赖真实 8002 服务端。
"""

import asyncio
import logging
import os
import ssl
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import h2.connection
import h2.config
import h2.events
import proxy_core
from h2_upstream import H2UpstreamPool

CERT = os.path.join(os.path.dirname(__file__), "..", "..", "cert", "socks5_tls.crt")
KEY = os.path.join(os.path.dirname(__file__), "..", "..", "cert", "socks5_tls.key")

_silent_logger = logging.getLogger("test.h2_upstream")
_silent_logger.addHandler(logging.NullHandler())
_silent_logger.propagate = False


def run(coro):
    return asyncio.run(coro)


def server_config(port):
    return {
        "protocol": "http",
        "address": "127.0.0.1",
        "port": port,
        "username": "user",
        "password": "pass",
        "tls": True,
        "allowInsecure": True,
    }


def client_ssl_ctx():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    ctx.set_alpn_protocols(["h2", "http/1.1"])
    return ctx


class FakeH2Server:
    """最小 h2 服务端：CONNECT → 200 → echo（可选：EOF 时回一段、200 后 RST、直接回错误码）。"""

    def __init__(self, alpn=("h2",), reply_on_end=None, reset_after_connect=False,
                 reject_status=None, reset_before_connect=False):
        self.alpn = list(alpn)
        self.reply_on_end = reply_on_end
        self.reset_after_connect = reset_after_connect
        self.reject_status = reject_status
        self.reset_before_connect = reset_before_connect
        self.tls_connections = 0
        self.requests = []
        self.received = []
        self.server = None
        self.port = None
        self._writers = set()

    async def start(self):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(CERT, KEY)
        ctx.set_alpn_protocols(self.alpn)
        self.server = await asyncio.start_server(self._accept, "127.0.0.1", 0, ssl=ctx)
        self.port = self.server.sockets[0].getsockname()[1]

    async def stop(self):
        for writer in list(self._writers):
            writer.close()
        self._writers.clear()
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()

    async def kill_connections(self):
        for writer in list(self._writers):
            writer.transport.abort()
        self._writers.clear()

    def _accept(self, reader, writer):
        # 同步计数：TLS 握手已完成，但 handler 任务可能还没被调度
        self.tls_connections += 1
        asyncio.ensure_future(self._handle(reader, writer))

    async def _handle(self, reader, writer):
        self._writers.add(writer)
        conn = h2.connection.H2Connection(config=h2.config.H2Configuration(
            client_side=False,
            header_encoding="utf-8",
            validate_outbound_headers=False,
            # CONNECT 按 RFC 不带 :scheme/:path，hyper-h2 的入站校验默认会拒
            validate_inbound_headers=False,
        ))
        conn.initiate_connection()
        writer.write(conn.data_to_send())
        await writer.drain()
        streams = {}
        try:
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                events = conn.receive_data(data)
                out = conn.data_to_send()
                if out:
                    writer.write(out)
                    await writer.drain()
                for event in events:
                    self._on_event(conn, writer, streams, event)
                out = conn.data_to_send()
                if out:
                    writer.write(out)
                    await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            self._writers.discard(writer)
            try:
                writer.close()
            except OSError:
                pass

    def _on_event(self, conn, writer, streams, event):
        if isinstance(event, h2.events.RequestReceived):
            sid = event.stream_id
            headers = dict(event.headers)
            streams[sid] = {"pending": bytearray(), "ended": False}
            self.requests.append(headers)
            if self.reset_before_connect:
                conn.reset_stream(sid, error_code=1)
                return
            if self.reject_status is not None:
                conn.send_headers(sid, [(":status", str(self.reject_status))], end_stream=True)
                return
            conn.send_headers(sid, [(":status", "200")])
            if self.reset_after_connect:
                conn.reset_stream(sid, error_code=1)
        elif isinstance(event, h2.events.DataReceived):
            sid = event.stream_id
            conn.acknowledge_received_data(event.flow_controlled_length, sid)
            self.received.append(bytes(event.data))
            state = streams.setdefault(sid, {"pending": bytearray(), "ended": False})
            state["pending"].extend(event.data)
            self._flush(conn, sid, state)
        elif isinstance(event, h2.events.WindowUpdated):
            if event.stream_id == 0:
                for sid, state in streams.items():
                    self._flush(conn, sid, state)
            else:
                state = streams.get(event.stream_id)
                if state is not None:
                    self._flush(conn, event.stream_id, state)
        elif isinstance(event, h2.events.StreamEnded):
            sid = event.stream_id
            state = streams.setdefault(sid, {"pending": bytearray(), "ended": False})
            if state["ended"]:
                return
            state["ended"] = True
            if self.reply_on_end:
                conn.send_data(sid, self.reply_on_end, end_stream=True)
            else:
                conn.end_stream(sid)

    @staticmethod
    def _flush(conn, sid, state):
        while state["pending"]:
            window = conn.local_flow_control_window(sid)
            size = min(window, conn.max_outbound_frame_size, len(state["pending"]))
            if size <= 0:
                return
            chunk = bytes(state["pending"][:size])
            del state["pending"][:size]
            conn.send_data(sid, chunk)


async def read_n(reader, size):
    chunks = []
    total = 0
    while total < size:
        data = await asyncio.wait_for(reader.read(65536), 5)
        if not data:
            break
        chunks.append(data)
        total += len(data)
    return b"".join(chunks)


async def start_pool(server):
    pool = H2UpstreamPool(
        server_config(server.port), client_ssl_ctx(), logger=_silent_logger,
    )
    await pool.start()
    return pool


def test_two_tunnels_share_one_tls_connection():
    async def main():
        server = FakeH2Server()
        await server.start()
        pool = await start_pool(server)
        try:
            reader_a, writer_a = await pool.connect("example.com", 443)
            reader_b, writer_b = await pool.connect("example.org", 8443)
            writer_a.write(b"alpha")
            writer_b.write(b"beta")
            await writer_a.drain()
            await writer_b.drain()
            assert await read_n(reader_a, 5) == b"alpha"
            assert await read_n(reader_b, 4) == b"beta"
            assert server.tls_connections == 1
        finally:
            await pool.stop()
            await server.stop()

    run(main())


def test_connect_headers_omit_scheme_and_path():
    async def main():
        server = FakeH2Server()
        await server.start()
        pool = await start_pool(server)
        try:
            _reader, writer = await pool.connect("example.com", 443)
            assert server.requests, "服务端没有收到 HEADERS"
            headers = server.requests[0]
            assert headers[":method"] == "CONNECT"
            assert headers[":authority"] == "example.com:443"
            assert ":scheme" not in headers
            assert ":path" not in headers
            assert headers["proxy-authorization"].startswith("Basic ")
            writer.close()
        finally:
            await pool.stop()
            await server.stop()

    run(main())


def test_downgrade_when_alpn_is_http11():
    async def main():
        server = FakeH2Server(alpn=("http/1.1",))
        await server.start()
        pool = await start_pool(server)
        try:
            assert await pool.connect("example.com", 443) is None
            assert pool.disabled is True
            # 已降级：不再尝试新连接
            assert await pool.connect("example.com", 443) is None
            await asyncio.sleep(0.05)
            assert server.tls_connections == 1
        finally:
            await pool.stop()
            await server.stop()

    run(main())


def test_large_payload_flow_control():
    async def main():
        server = FakeH2Server()
        await server.start()
        pool = await start_pool(server)
        try:
            reader, writer = await pool.connect("example.com", 443)
            payload = bytes(range(256)) * 4096  # 1 MiB
            writer.write(payload)
            await writer.drain()
            echoed = await read_n(reader, len(payload))
            assert len(echoed) == len(payload)
            assert echoed == payload
        finally:
            await pool.stop()
            await server.stop()

    run(main())


def test_stream_reset_surfaces_eof():
    async def main():
        server = FakeH2Server(reset_after_connect=True)
        await server.start()
        pool = await start_pool(server)
        try:
            reader, writer = await pool.connect("example.com", 443)
            data = await asyncio.wait_for(reader.read(65536), 5)
            assert data == b""
            await asyncio.wait_for(writer.wait_closed(), 5)
        finally:
            await pool.stop()
            await server.stop()

    run(main())


def test_write_eof_sends_end_stream():
    async def main():
        server = FakeH2Server(reply_on_end=b"bye")
        await server.start()
        pool = await start_pool(server)
        try:
            reader, writer = await pool.connect("example.com", 443)
            assert writer.can_write_eof() is True
            writer.write_eof()
            assert await read_n(reader, 3) == b"bye"
            assert writer.is_closing() is True
            await asyncio.wait_for(writer.wait_closed(), 5)
        finally:
            await pool.stop()
            await server.stop()

    run(main())


def test_transport_abort_resets_only_stream():
    async def main():
        server = FakeH2Server()
        await server.start()
        pool = await start_pool(server)
        try:
            _reader, writer = await pool.connect("example.com", 443)
            writer.transport.abort()
            # 共享会话必须还活着：新流复用同一条 TLS 连接
            reader2, writer2 = await pool.connect("example.com", 443)
            writer2.write(b"ping")
            await writer2.drain()
            assert await read_n(reader2, 4) == b"ping"
            assert server.tls_connections == 1
        finally:
            await pool.stop()
            await server.stop()

    run(main())


def test_session_death_reconnects():
    async def main():
        server = FakeH2Server()
        await server.start()
        pool = await start_pool(server)
        try:
            _reader, writer = await pool.connect("example.com", 443)
            writer.write(b"ping")
            await writer.drain()
            await server.kill_connections()
            # 会话已死：下一次 connect() 必须重连
            for _ in range(20):
                reader2, writer2 = await pool.connect("example.com", 443)
                writer2.write(b"ping")
                await writer2.drain()
                if await read_n(reader2, 4) == b"ping":
                    break
                await asyncio.sleep(0.1)
            else:
                pytest.fail("会话断开后未能重新建立 h2 连接")
            assert server.tls_connections >= 2
        finally:
            await pool.stop()
            await server.stop()

    run(main())


def test_relay_between_h2_stream_and_local_socket():
    async def main():
        server = FakeH2Server()
        await server.start()
        pool = await start_pool(server)
        results = {}

        async def local_peer(reader, writer):
            # 发 "ping" 给 h2 流，等 echo 回显走回来
            writer.write(b"ping")
            await writer.drain()
            try:
                results["echo"] = await asyncio.wait_for(reader.readexactly(4), 5)
            except (asyncio.IncompleteReadError, asyncio.TimeoutError):
                results["echo"] = None
            writer.close()

        peer_server = await asyncio.start_server(local_peer, "127.0.0.1", 0)
        peer_port = peer_server.sockets[0].getsockname()[1]
        try:
            app_reader, app_writer = await asyncio.open_connection("127.0.0.1", peer_port)
            target_reader, target_writer = await pool.connect("example.com", 443)
            relays = asyncio.gather(
                proxy_core.relay(app_reader, target_writer),
                proxy_core.relay(target_reader, app_writer),
            )
            await asyncio.wait_for(relays, 15)
            assert results.get("echo") == b"ping"
            assert b"".join(server.received) == b"ping"
        finally:
            peer_server.close()
            await peer_server.wait_closed()
            await pool.stop()
            await server.stop()

    run(main())


def test_connection_window_is_raised_above_default():
    async def main():
        server = FakeH2Server()
        await server.start()
        pool = await start_pool(server)
        try:
            await pool.connect("example.com", 443)
            session = pool._sessions[0]
            # 仅提高 SETTINGS 的流窗口不够：连接级窗口默认 65535，不抬高的话
            # 所有流共享 64KB/RTT，比 HTTP/1.1 还慢
            assert session.conn.inbound_flow_control_window > 65535
        finally:
            await pool.stop()
            await server.stop()

    run(main())


def test_stream_reset_before_response_fails_fast():
    async def main():
        server = FakeH2Server(reset_before_connect=True)
        await server.start()
        pool = await start_pool(server)
        try:
            started = asyncio.get_event_loop().time()
            with pytest.raises(Exception):
                await asyncio.wait_for(pool.connect("example.com", 443), 3)
            assert asyncio.get_event_loop().time() - started < 3
        finally:
            await pool.stop()
            await server.stop()

    run(main())


def test_idle_session_close_does_not_churn_reconnects():
    async def main():
        server = FakeH2Server()
        await server.start()
        pool = H2UpstreamPool(
            server_config(server.port), client_ssl_ctx(), logger=_silent_logger,
            ping_interval=0.1, idle_close=0.3,
        )
        await pool.start()
        try:
            await asyncio.sleep(0.4)
            baseline = server.tls_connections
            assert baseline == 1, f"预连接次数异常: {baseline}"
            # 空闲关闭后不该自动重连（否则每 10 分钟无谓重建一次 TLS）
            await asyncio.sleep(2.0)
            assert server.tls_connections == baseline, "空闲关闭后又自动重连了"
            # 用时再建
            reader, writer = await pool.connect("example.com", 443)
            writer.write(b"ping")
            await writer.drain()
            assert await read_n(reader, 4) == b"ping"
            assert server.tls_connections == baseline + 1
        finally:
            await pool.stop()
            await server.stop()

    run(main())


def test_connect_rejects_non_200_with_error():
    async def main():
        server = FakeH2Server(reject_status=407)
        await server.start()
        pool = await start_pool(server)
        try:
            with pytest.raises(Exception) as excinfo:
                await pool.connect("example.com", 443)
            assert "407" in str(excinfo.value)
            # 失败流不能污染会话：下一次请求仍能拿到明确错误（而不是挂死）
            with pytest.raises(Exception):
                await asyncio.wait_for(pool.connect("example.com", 443), 5)
        finally:
            await pool.stop()
            await server.stop()

    run(main())
