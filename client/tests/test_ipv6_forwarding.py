"""IPv6 目标经代理转发的兼容性（8001/8002 路径）。

覆盖三件事：
1. 上游握手把 IPv6 字面量编码成协议要求的形式（SOCKS5 ATYP=0x04、
   HTTP CONNECT / h2 :authority 带方括号）；
2. 本地入口解析 IPv6 形式的请求行（CONNECT 与明文 HTTP 的 absolute-form）；
3. 隧道路由遇到 IPv6 目标干净失败，而不是发出损坏的帧。
"""

import asyncio
import os
import struct
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core
import tunnel_client


class FakeReader:
    """字节流式假 reader：readexactly 从缓冲取 n 字节，readline 取到行尾。"""

    def __init__(self, chunks):
        self._buf = bytearray(b"".join(chunks))

    async def readexactly(self, n):
        if len(self._buf) < n:
            data = bytes(self._buf)
            self._buf.clear()
            raise asyncio.IncompleteReadError(data, n)
        data = bytes(self._buf[:n])
        del self._buf[:n]
        return data

    async def readline(self):
        idx = self._buf.find(b"\n")
        if idx == -1:
            data = bytes(self._buf)
            self._buf.clear()
            return data
        data = bytes(self._buf[:idx + 1])
        del self._buf[:idx + 1]
        return data

    async def read(self, n=-1):
        if n < 0:
            data = bytes(self._buf)
            self._buf.clear()
            return data
        data = bytes(self._buf[:n])
        del self._buf[:n]
        return data

    def at_eof(self):
        return not self._buf


class FakeWriter:
    def __init__(self):
        self.writes = []
        self.closed = False

    def write(self, data):
        self.writes.append(data)

    async def drain(self):
        pass

    def close(self):
        self.closed = True

    async def wait_closed(self):
        pass

    def is_closing(self):
        return self.closed

    def get_extra_info(self, name):
        return None


def server_config(protocol="http"):
    return {
        "protocol": protocol,
        "address": "node.example",
        "port": 8002,
        "username": "u",
        "password": "p",
        "tls": False,
        "allowInsecure": True,
    }


# ── 上游握手：IPv6 目标编码 ──────────────────────────────────


def test_format_connect_target_brackets_ipv6_only():
    assert proxy_core.format_connect_target("2001:db8::1", 443) == "[2001:db8::1]:443"
    assert proxy_core.format_connect_target("::1", 8443) == "[::1]:8443"
    # IPv4 与域名保持原样
    assert proxy_core.format_connect_target("1.2.3.4", 443) == "1.2.3.4:443"
    assert proxy_core.format_connect_target("example.com", 443) == "example.com:443"


def test_http_connect_handshake_brackets_ipv6_target():
    writer = FakeWriter()
    reader = FakeReader([b"HTTP/1.1 200 Connection Established\r\n", b"\r\n"])

    asyncio.run(proxy_core._http_connect_handshake(
        reader, writer, server_config(), "2001:db8::1", 443
    ))

    head = writer.writes[0].decode()
    assert head.startswith("CONNECT [2001:db8::1]:443 HTTP/1.1\r\n")
    assert "Host: [2001:db8::1]:443\r\n" in head


def test_http_connect_handshake_keeps_ipv4_and_domain_targets():
    for target in ("1.2.3.4", "example.com"):
        writer = FakeWriter()
        reader = FakeReader([b"HTTP/1.1 200 Connection Established\r\n", b"\r\n"])
        asyncio.run(proxy_core._http_connect_handshake(
            reader, writer, server_config(), target, 443
        ))
        assert writer.writes[0].decode().startswith(f"CONNECT {target}:443 HTTP/1.1\r\n")


def test_socks5_handshake_uses_atyp_ipv6_for_ipv6_target():
    writer = FakeWriter()
    reader = FakeReader([
        b"\x05\x00",                                    # 免认证
        b"\x05\x00\x00\x04" + b"\x00" * 16 + b"\x01\xbb",  # 成功 + IPv6 回显
    ])

    asyncio.run(proxy_core._socks5_handshake(
        reader, writer, server_config("socks5"), "2001:db8::1", 443
    ))

    request = writer.writes[-1]
    assert request[:4] == b"\x05\x01\x00\x04", "IPv6 目标必须用 ATYP=0x04"
    assert request[4:20] == bytes.fromhex("20010db8000000000000000000000001")
    assert struct.unpack("!H", request[20:22])[0] == 443


def test_socks5_handshake_keeps_atyp_ipv4_and_domain():
    cases = [
        ("1.2.3.4", b"\x01", b"\x01\x02\x03\x04"),
        ("example.com", b"\x03", b"\x0bexample.com"),
    ]
    for dest, expected_atyp, expected_addr in cases:
        writer = FakeWriter()
        reader = FakeReader([
            b"\x05\x00",
            b"\x05\x00\x00\x01" + b"\x00" * 4 + b"\x01\xbb",
        ])
        asyncio.run(proxy_core._socks5_handshake(
            reader, writer, server_config("socks5"), dest, 443
        ))
        request = writer.writes[-1]
        assert request[3:4] == expected_atyp
        assert request[4:4 + len(expected_addr)] == expected_addr


# ── 本地入口：IPv6 形式的请求行解析 ──────────────────────────


def test_parse_http_authority_handles_ipv6_forms():
    assert proxy_core.parse_http_authority("[2001:db8::1]:443", 443) == ("2001:db8::1", 443)
    assert proxy_core.parse_http_authority("[::1]:8080", 443) == ("::1", 8080)
    # 无端口时用默认值
    assert proxy_core.parse_http_authority("[::1]", 443) == ("::1", 443)
    assert proxy_core.parse_http_authority("[2001:db8::1]", 80) == ("2001:db8::1", 80)


def test_parse_http_authority_keeps_ipv4_and_domain():
    assert proxy_core.parse_http_authority("example.com:443", 443) == ("example.com", 443)
    assert proxy_core.parse_http_authority("1.2.3.4:8080", 80) == ("1.2.3.4", 8080)
    assert proxy_core.parse_http_authority("example.com", 443) == ("example.com", 443)


def test_parse_http_authority_rejects_malformed():
    assert proxy_core.parse_http_authority("[::1", 443) == (None, None)
    assert proxy_core.parse_http_authority("[::1]x", 443) == (None, None)
    assert proxy_core.parse_http_authority("example.com:notaport", 443) == (None, None)
    assert proxy_core.parse_http_authority("example.com:99999", 443) == (None, None)


def test_local_connect_entry_accepts_ipv6_target(monkeypatch):
    """本地 SOCKS5 入口收到 ATYP=0x04 时，目标应是裸 IPv6 且路由判定不崩。"""
    connected = []

    async def fake_connect_target(dest_addr, dest_port, is_domain=None, route=None):
        connected.append((dest_addr, dest_port, is_domain))
        raise ConnectionRefusedError("stop after routing")

    proxy = proxy_core.ProxyCore()
    proxy._connect_target = fake_connect_target
    proxy._target_admission = proxy_core.TargetAdmission()
    proxy._semaphore = asyncio.Semaphore(4)
    proxy._server_config = server_config()
    proxy._routing = None
    proxy._proxy_private = False
    proxy._edr_detector = None
    proxy._metrics = proxy_core.RuntimeMetrics()
    proxy._mark_proxy_activity = lambda: None

    ipv6_packed = bytes.fromhex("20010db8000000000000000000000001")
    request = (
        b"\x05\x01\x00"          # VER, CONNECT, RSV
        + b"\x04" + ipv6_packed  # ATYP=IPv6
        + struct.pack("!H", 443)
    )

    reader = FakeReader([
        b"\x05\x01",   # VER + NMETHODS
        b"\x00",       # 免认证
        request[:4],
        request[4:20],
        request[20:22],
    ])
    writer = FakeWriter()

    asyncio.run(proxy._do_handle_socks(reader, writer))

    assert connected == [("2001:db8::1", 443, False)]


def test_local_http_connect_entry_accepts_ipv6_target(monkeypatch):
    """本地 HTTP 代理入口收到 CONNECT [v6]:port 时应剥掉方括号。"""
    connected = []

    async def fake_connect_target(dest_addr, dest_port, is_domain=None, route=None):
        connected.append((dest_addr, dest_port, is_domain))
        raise ConnectionRefusedError("stop after routing")

    proxy = proxy_core.ProxyCore()
    proxy._connect_target = fake_connect_target
    proxy._target_admission = proxy_core.TargetAdmission()
    proxy._semaphore = asyncio.Semaphore(4)
    proxy._server_config = server_config()
    proxy._routing = None
    proxy._proxy_private = False
    proxy._edr_detector = None
    proxy._metrics = proxy_core.RuntimeMetrics()
    proxy._mark_proxy_activity = lambda: None

    reader = FakeReader([
        b"CONNECT [2001:db8::1]:443 HTTP/1.1\r\n",
        b"Host: [2001:db8::1]:443\r\n",
        b"\r\n",
    ])
    writer = FakeWriter()

    asyncio.run(proxy._do_handle_http(reader, writer))

    assert connected == [("2001:db8::1", 443, False)]


def test_local_http_plain_request_parses_ipv6_absolute_form(monkeypatch):
    """明文 HTTP 的 absolute-form（http://[::1]:8080/path）要解析出裸 host。"""
    connected = []

    async def fake_connect_target(dest_addr, dest_port, is_domain=None, route=None):
        connected.append((dest_addr, dest_port, is_domain))
        raise ConnectionRefusedError("stop after routing")

    proxy = proxy_core.ProxyCore()
    proxy._connect_target = fake_connect_target
    proxy._target_admission = proxy_core.TargetAdmission()
    proxy._semaphore = asyncio.Semaphore(4)
    proxy._server_config = server_config()
    proxy._routing = None
    proxy._proxy_private = False
    proxy._edr_detector = None
    proxy._metrics = proxy_core.RuntimeMetrics()
    proxy._mark_proxy_activity = lambda: None

    reader = FakeReader([
        b"GET http://[2001:db8::1]:8080/path HTTP/1.1\r\n",
        b"Host: [2001:db8::1]:8080\r\n",
        b"\r\n",
    ])
    writer = FakeWriter()

    asyncio.run(proxy._do_handle_http(reader, writer))

    assert connected == [("2001:db8::1", 8080, False)]


# ── h2 上游：:authority 带方括号 ─────────────────────────────


def test_h2_open_tunnel_brackets_ipv6_authority():
    """真实 h2 会话：服务端收到的 :authority 必须带方括号。"""
    from tests.test_h2_upstream import FakeH2Server, start_pool

    async def main():
        server = FakeH2Server()
        await server.start()
        pool = await start_pool(server)
        try:
            _reader, writer = await pool.connect("2001:db8::1", 443)
            assert server.requests, "服务端没有收到 HEADERS"
            assert server.requests[0][":authority"] == "[2001:db8::1]:443"
            writer.close()
        finally:
            await pool.stop()
            await server.stop()

    asyncio.run(main())


def test_h2_open_tunnel_keeps_domain_authority():
    """回归：域名目标的 :authority 不变。"""
    from tests.test_h2_upstream import FakeH2Server, start_pool

    async def main():
        server = FakeH2Server()
        await server.start()
        pool = await start_pool(server)
        try:
            _reader, writer = await pool.connect("example.com", 443)
            assert server.requests[0][":authority"] == "example.com:443"
            writer.close()
        finally:
            await pool.stop()
            await server.stop()

    asyncio.run(main())


# ── 隧道路由：IPv6 目标干净失败 ──────────────────────────────


def test_tunnel_forward_connect_rejects_ipv6_target():
    class FakeWs:
        def __init__(self):
            self.closed = False
            self.sent = []

        async def send(self, data):
            self.sent.append(data)

    class FakeSock:
        def __init__(self):
            self.closed = False

        def close(self):
            self.closed = True

    cfg = {
        "server": {"address": "127.0.0.1", "username": "u", "password": "p",
                   "allowInsecure": True},
        "tunnel": {"server_address": "127.0.0.1", "server_port": 8003},
    }
    tc = tunnel_client.TunnelClient(cfg, lambda status, detail="": None)
    ws = FakeWs()
    tc._active_ws = ws
    sock = FakeSock()

    with pytest.raises(Exception) as excinfo:
        asyncio.run(tc._forward_connect_async("2001:db8::1", 443, sock))

    assert "IPv6" in str(excinfo.value)
    assert ws.sent == [], "IPv6 目标不该发出任何帧"
    assert sock.closed is True, "失败路径必须关掉本地 socket"
    assert tc._forward_requests == {}, "失败路径必须清掉 reqid 登记"


def test_tunnel_forward_connect_still_encodes_ipv4_and_domain():
    """回归：IPv4/域名目标的帧编码不受 IPv6 守卫影响。"""
    class FakeWs:
        def __init__(self):
            self.closed = False
            self.sent = []

        async def send(self, data):
            self.sent.append(data)

    class FakeSock:
        def close(self):
            pass

    cfg = {
        "server": {"address": "127.0.0.1", "username": "u", "password": "p",
                   "allowInsecure": True},
        "tunnel": {"server_address": "127.0.0.1", "server_port": 8003},
    }

    for host, expected_atyp in (("1.2.3.4", tunnel_client.ATYP_IPV4),
                                ("example.com", tunnel_client.ATYP_DOMAIN)):
        tc = tunnel_client.TunnelClient(cfg, lambda status, detail="": None)
        ws = FakeWs()
        tc._active_ws = ws

        async def main():
            task = asyncio.ensure_future(
                tc._forward_connect_async(host, 443, FakeSock())
            )
            for _ in range(50):
                if ws.sent:
                    break
                await asyncio.sleep(0.01)
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

        asyncio.run(main())

        assert ws.sent, f"{host} 没有发出 CONNECT 帧"
        frame = tunnel_client.decode_frame_from_buffer(ws.sent[0])
        assert frame["type"] == tunnel_client.FRAME_CONNECT
        assert frame["atyp"] == expected_atyp
        assert frame["addr"] == host
        assert frame["port"] == 443
