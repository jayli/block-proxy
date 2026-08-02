"""relay 连接清理测试：对端不回 FIN 时 RST 强关，防止 fd/连接残留。

背景：DoH 探测连接（如 CONNECT 8.8.8.8:53）建立后立即断开且不回 FIN，
旧的 write_eof() 优雅关闭会让 transport 永远等待 wait_closed()，
导致 CLOSED fd 与 FIN_WAIT_2 堆积，最终在突发并发时触发网关 SYN
限流（表现为休眠唤醒后 30s 黑洞）。
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core


class EmptyReader:
    """立即返回 EOF 的 reader，模拟对端已经断开。"""

    def __init__(self):
        self.read_calls = 0

    async def read(self, n):
        self.read_calls += 1
        return b""


class FakeSock:
    def __init__(self):
        self.linger_set = None

    def setsockopt(self, level, optname, value):
        self.linger_set = (level, optname, value)


class FakeTransport:
    def __init__(self):
        self.sock = FakeSock()
        self.aborted = False

    def get_extra_info(self, name):
        if name == "socket":
            return self.sock
        return None

    def abort(self):
        self.aborted = True


class PeerNeverFinsWriter:
    """write_eof 已发出但对端永不回 FIN：wait_closed 永不完成。"""

    def __init__(self):
        self.transport = FakeTransport()
        self.eof_sent = False
        self.closed = False

    def can_write_eof(self):
        return True

    def write_eof(self):
        self.eof_sent = True

    async def wait_closed(self):
        await asyncio.sleep(3600)

    def close(self):
        self.closed = True

    def is_closing(self):
        return self.closed


def test_relay_rst_closes_when_peer_never_fins(monkeypatch):
    """对端不回 FIN → 限时等待超时 → RST 强关（transport.abort + SO_LINGER）。"""
    monkeypatch.setattr(proxy_core, "RELAY_EOF_WAIT_TIMEOUT", 0.2)

    reader = EmptyReader()
    writer = PeerNeverFinsWriter()

    asyncio.run(proxy_core.relay(reader, writer))

    assert writer.eof_sent  # 优雅关闭已尝试
    assert writer.transport.aborted  # 超时后 RST 强关
    assert writer.transport.sock.linger_set is not None  # SO_LINGER(1,0) 已设置


def test_relay_normal_eof_closes_cleanly(monkeypatch):
    """对端正常回 FIN（wait_closed 完成）→ 不触发 RST。"""

    class NormalWriter(PeerNeverFinsWriter):
        async def wait_closed(self):
            return  # 正常完成

    monkeypatch.setattr(proxy_core, "RELAY_EOF_WAIT_TIMEOUT", 1.0)

    reader = EmptyReader()
    writer = NormalWriter()

    asyncio.run(proxy_core.relay(reader, writer))

    assert writer.eof_sent
    assert not writer.transport.aborted  # 未超时，无 RST


def test_force_close_rst_uses_linger_and_abort():
    """_force_close_rst 设置 SO_LINGER(1,0) 并 abort。"""

    class W:
        def __init__(self):
            self.transport = FakeTransport()

    writer = W()
    proxy_core._force_close_rst(writer)

    assert writer.transport.aborted
    level, optname, value = writer.transport.sock.linger_set
    assert value == __import__("struct").pack("ii", 1, 0)


def test_force_close_rst_safe_on_closed_transport():
    """已关闭的 transport 上调用 _force_close_rst 不抛异常（幂等）。"""

    class DeadTransport:
        def get_extra_info(self, name):
            raise OSError("bad fd")

        def abort(self):
            raise OSError("already closed")

    class W:
        def __init__(self):
            self.transport = DeadTransport()

    proxy_core._force_close_rst(W())  # 不应抛异常


# ---------------------------------------------------------------------------
# connect_direct 多 IP 轮换：坏 IP 超时后尝试下一个，不挂死
# ---------------------------------------------------------------------------

class FakeLoop:
    """只提供 getaddrinfo 的假事件循环（connect_direct 通过 loop.getaddrinfo 解析）。"""

    def __init__(self, infos):
        self._infos = infos

    async def getaddrinfo(self, host, port, type=None):
        return self._infos


def _patch_connect_direct(monkeypatch, infos, open_behavior):
    """把 connect_direct 的解析与 open_connection 替换为可控的 fake。"""
    opened = []

    async def fake_getaddrinfo(host, port, type=None):
        return infos

    async def fake_open_connection(*addr, **kwargs):
        opened.append(addr)
        return await open_behavior(addr)

    monkeypatch.setattr(
        proxy_core.asyncio, "get_running_loop", lambda: FakeLoop(infos)
    )
    monkeypatch.setattr(proxy_core.asyncio, "open_connection", fake_open_connection)
    monkeypatch.setattr(proxy_core, "_set_nodelay", lambda w: None)
    return opened


async def _ok_behavior(addr):
    return (None, type("W", (), {})())


async def _stuck_behavior(addr):
    await asyncio.sleep(3600)


def test_connect_direct_first_ip_ok(monkeypatch):
    """第一个 IP 直接成功。"""
    opened = _patch_connect_direct(
        monkeypatch,
        [
            (2, 1, 6, "", ("1.2.3.4", 443)),
            (2, 1, 6, "", ("5.6.7.8", 443)),
        ],
        _ok_behavior,
    )

    asyncio.run(proxy_core.connect_direct("example.com", 443))

    assert opened == [("1.2.3.4", 443)]


def test_connect_direct_timeout_falls_back_to_next_ip(monkeypatch):
    """第一个 IP 超时（黑洞）→ 超时内放弃并尝试第二个。"""

    async def behavior(addr):
        if addr[0] == "1.2.3.4":
            await asyncio.sleep(3600)  # 黑洞：connect 永不完成
        return (None, type("W", (), {})())

    opened = _patch_connect_direct(
        monkeypatch,
        [
            (2, 1, 6, "", ("1.2.3.4", 443)),
            (2, 1, 6, "", ("5.6.7.8", 443)),
        ],
        behavior,
    )
    monkeypatch.setattr(proxy_core, "DIRECT_CONNECT_TIMEOUT", 0.1)

    asyncio.run(proxy_core.connect_direct("example.com", 443))

    assert opened == [("1.2.3.4", 443), ("5.6.7.8", 443)]


def test_connect_direct_all_fail_raises(monkeypatch):
    """全部 IP 失败 → 快速抛错（不再无限挂死 75s）。"""
    _patch_connect_direct(
        monkeypatch,
        [(2, 1, 6, "", ("1.2.3.4", 443))],
        _stuck_behavior,
    )
    monkeypatch.setattr(proxy_core, "DIRECT_CONNECT_TIMEOUT", 0.05)

    try:
        asyncio.run(proxy_core.connect_direct("example.com", 443))
        assert False, "should raise"
    except asyncio.TimeoutError:
        pass  # 黑洞 IP 在超时内失败即可（不挂死 75s）
    except OSError:
        pass


def test_connect_direct_handles_ipv6_four_tuple(monkeypatch):
    """getaddrinfo 返回 IPv6 4 元组 (host, port, flowinfo, scopeid) 时，
    open_connection 必须只取 (host, port)，否则 TypeError 导致全部连接失败。
    回归：www.baidu.com 等双栈域名在解析到 IPv6 地址时曾全部 CONNECT aborted。"""
    opened = []

    async def behavior(addr):
        opened.append(addr)
        return (None, type("W", (), {})())

    _patch_connect_direct(
        monkeypatch,
        [
            (10, 1, 6, "", ("240e:83:205:381:0:ff:b00f:96a2", 443, 0, 0)),
            (2, 1, 6, "", ("220.181.111.1", 443)),
        ],
        behavior,
    )

    asyncio.run(proxy_core.connect_direct("www.baidu.com", 443))

    # 第一个（IPv6）应成功，且传给 open_connection 的必须是 2 元组
    assert opened == [("240e:83:205:381:0:ff:b00f:96a2", 443)]


def test_connect_direct_propagates_cancellation(monkeypatch):
    """上层 stop/recycle 取消连接任务时，不应吞掉 CancelledError 继续尝试。"""
    _patch_connect_direct(
        monkeypatch,
        [(2, 1, 6, "", ("1.2.3.4", 443))],
        lambda addr: (_ for _ in ()).throw(asyncio.CancelledError()),
    )

    try:
        asyncio.run(proxy_core.connect_direct("example.com", 443))
        assert False, "should propagate cancellation"
    except asyncio.CancelledError:
        pass


def test_http_connect_normal_completion_does_not_force_rst(monkeypatch):
    """正常 relay 结束后不应再无条件 RST 上游连接。"""

    class Reader:
        def __init__(self, lines):
            self._lines = list(lines)

        async def readline(self):
            if self._lines:
                return self._lines.pop(0)
            return b""

    class Transport:
        def get_extra_info(self, name):
            return None

    class Writer:
        def __init__(self):
            self.transport = Transport()
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

    async def fake_connect_target(host, port, is_domain=None, route=None):
        return object(), Writer(), "proxy"

    async def fake_relay(reader, writer, route=None, direction=None, on_activity=None):
        return

    rst_calls = []
    monkeypatch.setattr(proxy_core, "relay", fake_relay)
    monkeypatch.setattr(proxy_core, "_force_close_rst", lambda writer: rst_calls.append(writer))

    pc = proxy_core.ProxyCore()
    pc._server_config = {"protocol": "socks5"}
    pc._proxy_private = False
    pc._routing = None
    pc._connect_target = fake_connect_target

    client_reader = Reader([
        b"CONNECT example.com:443 HTTP/1.1\r\n",
        b"\r\n",
    ])
    client_writer = Writer()

    asyncio.run(pc._do_handle_http(client_reader, client_writer))

    assert client_writer.writes == [b"HTTP/1.1 200 Connection Established\r\n\r\n"]
    assert rst_calls == []
