"""延迟探测要报告节点连接的地址族，状态栏才能标出 (ipv6)。

判定依据是本次探测真实用到的那条连接的对端地址（peername），不是配置里
的 ipv6Only 开关：开关只代表「只想用 IPv6」，实际连上的可能仍是 IPv4。
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core
import tunnel_client


IPV4_PEER = ("203.0.113.7", 8002)
IPV6_PEER = ("2001:db8::7", 8002, 0, 0)


class FakeReader:
    def __init__(self, chunks):
        self._chunks = list(chunks)

    async def readexactly(self, n):
        if not self._chunks:
            raise asyncio.IncompleteReadError(b"", n)
        data = self._chunks.pop(0)
        assert len(data) == n
        return data

    async def readline(self):
        if not self._chunks:
            return b""
        return self._chunks.pop(0)

    def at_eof(self):
        return False


class FakeWriter:
    def __init__(self, peername):
        self.writes = []
        self.closed = False
        self._peername = peername

    def write(self, data):
        self.writes.append(data)

    async def drain(self):
        pass

    def close(self):
        self.closed = True

    def is_closing(self):
        return self.closed

    async def wait_closed(self):
        pass

    def get_extra_info(self, name, default=None):
        if name == "peername":
            return self._peername
        return default


def socks5_config():
    return {
        "protocol": "socks5",
        "address": "node.example",
        "port": 8002,
        "username": "",
        "password": "",
        "tls": False,
        "allowInsecure": True,
    }


def _probe(monkeypatch, peername):
    """把节点连接换成假的，返回一个只等 SOCKS5 握手的 ProxyCore。"""
    reader = FakeReader([b"\x05\x00"])
    writer = FakeWriter(peername)

    async def fake_open_node_connection(server_config, **kwargs):
        return reader, writer

    monkeypatch.setattr(
        proxy_core, "open_node_connection", fake_open_node_connection
    )
    pc = proxy_core.ProxyCore()
    pc._server_config = socks5_config()
    return pc


def test_measure_latency_flags_ipv6_peer(monkeypatch):
    pc = _probe(monkeypatch, IPV6_PEER)

    latency, failure, is_ipv6 = asyncio.run(pc._measure_latency())

    assert failure is None, f"延迟探测失败: {failure}"
    assert latency is not None
    assert is_ipv6 is True


def test_measure_latency_does_not_flag_ipv4_peer(monkeypatch):
    pc = _probe(monkeypatch, IPV4_PEER)

    latency, failure, is_ipv6 = asyncio.run(pc._measure_latency())

    assert failure is None, f"延迟探测失败: {failure}"
    assert latency is not None
    assert is_ipv6 is False


def test_measure_latency_without_peername_is_not_ipv6(monkeypatch):
    """拿不到对端地址时按 IPv4 处理：宁可少标，不能谎报 ipv6。"""
    pc = _probe(monkeypatch, None)

    latency, failure, is_ipv6 = asyncio.run(pc._measure_latency())

    assert failure is None, f"延迟探测失败: {failure}"
    assert is_ipv6 is False


def test_measure_latency_failure_reports_not_ipv6(monkeypatch):
    """失败路径也要凑齐三元组，否则调用方解包会炸。"""

    async def fake_open_node_connection(server_config, **kwargs):
        raise ConnectionRefusedError("no route")

    monkeypatch.setattr(
        proxy_core, "open_node_connection", fake_open_node_connection
    )
    pc = proxy_core.ProxyCore()
    pc._server_config = socks5_config()

    latency, failure, is_ipv6 = asyncio.run(pc._measure_latency())

    assert latency is None
    assert failure == "unreachable"
    assert is_ipv6 is False


def test_measure_latency_result_carries_ipv6(monkeypatch):
    """对外的 measure_latency() 也要带上地址族，app 层才有东西可显示。"""
    pc = _probe(monkeypatch, IPV6_PEER)
    pc._running = True

    loop = asyncio.new_event_loop()
    pc._loop = loop

    import threading

    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    try:
        result = pc.measure_latency()
    finally:
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=5)
        loop.close()

    assert result is not None
    protocol_name, latency, failure_reason, is_ipv6 = result
    assert protocol_name == "socks5"
    assert failure_reason is None, f"延迟探测失败: {failure_reason}"
    assert is_ipv6 is True


# ── 隧道：地址族来自当前活跃的 WebSocket ──────────────────────


class FakeWs:
    def __init__(self, remote_address):
        self._remote_address = remote_address

    @property
    def remote_address(self):
        return self._remote_address


def _tunnel_client(active_ws):
    cfg = {
        "server": {
            "address": "127.0.0.1",
            "username": "u",
            "password": "p",
            "allowInsecure": True,
        },
        "tunnel": {"server_address": "127.0.0.1", "server_port": 8003},
    }
    tc = tunnel_client.TunnelClient(cfg, lambda status, detail="": None)
    tc._active_ws = active_ws
    return tc


def test_tunnel_reports_ipv6_active_connection():
    tc = _tunnel_client(FakeWs(IPV6_PEER))
    assert tc.is_active_ipv6() is True


def test_tunnel_reports_ipv4_active_connection():
    tc = _tunnel_client(FakeWs(IPV4_PEER))
    assert tc.is_active_ipv6() is False


def test_tunnel_without_active_connection_is_not_ipv6():
    tc = _tunnel_client(None)
    assert tc.is_active_ipv6() is False


def test_tunnel_address_family_survives_broken_transport():
    """remote_address 抛异常时退化成 False，不能让状态栏刷新崩掉。"""

    class BrokenWs:
        @property
        def remote_address(self):
            raise RuntimeError("transport gone")

    tc = _tunnel_client(BrokenWs())
    assert tc.is_active_ipv6() is False


def test_proxy_core_tunnel_latency_uses_tunnel_address_family(monkeypatch):
    """隧道模式的延迟探测走隧道自己的连接，地址族也得从那里取。"""

    class FakeTunnel:
        def __init__(self):
            self._ipv6 = True

        def get_status(self):
            return "connected"

        def is_connected(self):
            return True

        def is_active_ipv6(self):
            return self._ipv6

        def measure_latency(self, timeout=5):
            return 42

    pc = proxy_core.ProxyCore()
    pc._server_config = dict(socks5_config(), protocol="tunnel")
    pc._tunnel_client = FakeTunnel()

    latency, failure, is_ipv6 = asyncio.run(pc._measure_latency())

    assert latency == 42
    assert failure is None
    assert is_ipv6 is True
