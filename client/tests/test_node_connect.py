import asyncio
import types

import pytest

import node_connect
import proxy_core
from node_connect import (
    HOURLY_RECHECK_INTERVAL,
    can_suppress_sni,
    connect_with_sni_fallback,
    for_each_node_address,
    is_sni_suppressed,
)


def _ctx(check_hostname=False):
    return types.SimpleNamespace(check_hostname=check_hostname)


def _resolved(server_hostname="buffer.fun", all_hosts=("198.51.100.7",)):
    return types.SimpleNamespace(
        connect_host=all_hosts[0],
        server_hostname=server_hostname,
        all_hosts=list(all_hosts),
        is_resolved=server_hostname is not None,
    )


class Clock:
    """可控时钟，避免测试里真的等一小时。"""

    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr(node_connect.time, "monotonic", c)
    return c


@pytest.fixture
def resolver(monkeypatch):
    """记录 DoH 解析调用的假解析器。"""

    class Recording:
        def __init__(self):
            self.calls = []
            self.hosts = ["198.51.100.7"]

        async def __call__(self, host, force_refresh=False):
            self.calls.append((host, force_refresh))
            return _resolved(all_hosts=tuple(self.hosts))

    rec = Recording()
    monkeypatch.setattr(node_connect, "resolve_node_address", rec)
    return rec


# --- can_suppress_sni -------------------------------------------------------


def test_can_suppress_sni_only_without_hostname_check():
    assert can_suppress_sni(_ctx(check_hostname=False)) is True
    assert can_suppress_sni(_ctx(check_hostname=True)) is False
    assert can_suppress_sni(None) is False


# --- SNI 先试后降级 ----------------------------------------------------------


def test_sni_fallback_retries_without_sni_after_reset():
    seen = []

    async def make_connection(sni):
        seen.append(sni)
        if sni == "buffer.fun":
            raise ConnectionResetError(54, "Connection reset by peer")
        return "connected"

    result = asyncio.run(
        connect_with_sni_fallback(
            "buffer.fun", "198.51.100.7", make_connection, _ctx()
        )
    )

    assert result == "connected"
    assert seen == ["buffer.fun", "198.51.100.7"]
    assert is_sni_suppressed("buffer.fun") is True


def test_sni_fallback_is_remembered_for_later_connections():
    seen = []

    async def make_connection(sni):
        seen.append(sni)
        return "connected"

    node_connect.remember_sni_suppression("buffer.fun")

    asyncio.run(
        connect_with_sni_fallback(
            "buffer.fun", "198.51.100.7", make_connection, _ctx()
        )
    )

    assert seen == ["198.51.100.7"]


def test_sni_fallback_skipped_when_target_is_already_an_ip():
    seen = []

    async def make_connection(sni):
        seen.append(sni)
        return "connected"

    asyncio.run(
        connect_with_sni_fallback(
            "198.51.100.7", "198.51.100.7", make_connection, _ctx()
        )
    )

    assert seen == ["198.51.100.7"]
    assert is_sni_suppressed("198.51.100.7") is False


def test_reset_propagates_when_hostname_check_enabled():
    seen = []

    async def make_connection(sni):
        seen.append(sni)
        raise ConnectionResetError(54, "Connection reset by peer")

    with pytest.raises(ConnectionResetError):
        asyncio.run(
            connect_with_sni_fallback(
                "buffer.fun", "198.51.100.7", make_connection, _ctx(check_hostname=True)
            )
        )

    assert seen == ["buffer.fun"]
    assert is_sni_suppressed("buffer.fun") is False


def test_original_reset_is_reported_when_fallback_also_fails():
    async def make_connection(sni):
        if sni == "buffer.fun":
            raise ConnectionResetError(54, "Connection reset by peer")
        raise OSError("fallback failed")

    with pytest.raises(ConnectionResetError):
        asyncio.run(
            connect_with_sni_fallback(
                "buffer.fun", "198.51.100.7", make_connection, _ctx()
            )
        )


# --- 地址选择：连通就复用，失败才重解析 --------------------------------------


def test_successful_ip_is_reused_without_any_doh_query(monkeypatch, resolver, clock):
    attempts = []

    async def attempt(connect_host, server_hostname):
        attempts.append(connect_host)
        return "connected"

    for _ in range(50):
        asyncio.run(for_each_node_address("buffer.fun", attempt))

    # 首次解析一次，其后全部复用钉住的 IP
    assert len(resolver.calls) == 1
    assert attempts == ["198.51.100.7"] * 50


def test_doh_is_queried_once_per_hour_when_ip_stays_healthy(monkeypatch, resolver, clock):
    async def attempt(connect_host, server_hostname):
        return "connected"

    for _ in range(3):
        for _ in range(10):
            asyncio.run(for_each_node_address("buffer.fun", attempt))
        clock.advance(HOURLY_RECHECK_INTERVAL)

    # 首次 + 每小时复查 = 3 次解析（每次解析 = A + AAAA 两个请求）
    assert len(resolver.calls) == 3
    assert [forced for _, forced in resolver.calls] == [False, True, True]


def test_failure_triggers_one_forced_reparse_then_reuses_new_ip(monkeypatch, resolver, clock):
    resolver.hosts = ["198.51.100.7"]
    attempts = []

    async def attempt(connect_host, server_hostname):
        attempts.append(connect_host)
        if connect_host == "198.51.100.7":
            raise OSError("unreachable")
        return "connected"

    # 首次解析给 .7（失败），失败后强制重解析给 .9（成功）
    async def fake_resolve(host, force_refresh=False):
        resolver.calls.append((host, force_refresh))
        hosts = ["198.51.100.7"] if not force_refresh else ["198.51.100.9"]
        return _resolved(all_hosts=tuple(hosts))

    monkeypatch.setattr(node_connect, "resolve_node_address", fake_resolve)

    result = asyncio.run(for_each_node_address("buffer.fun", attempt))

    assert result == "connected"
    assert attempts == ["198.51.100.7", "198.51.100.9"]
    assert [forced for _, forced in resolver.calls] == [False, True]


def test_repeated_failures_do_not_reparse_every_retry(monkeypatch, resolver, clock):
    """连接池每秒重试时，不能每次都发起 DoH。"""
    attempts = []

    async def attempt(connect_host, server_hostname):
        attempts.append(connect_host)
        raise OSError("node down")

    for _ in range(100):
        with pytest.raises(OSError):
            asyncio.run(for_each_node_address("buffer.fun", attempt))
        clock.advance(1)

    # 首轮解析 + 失败重解析 = 2 次；其后到点前不再查询
    assert [forced for _, forced in resolver.calls] == [False, True]
    # 100 次重试各尝试一次；此前已尝试 1 次，总计 101
    assert attempts == ["198.51.100.7"] * 101


def test_all_ips_are_tried_before_failing(monkeypatch, resolver, clock):
    class FakeResolved:
        connect_host = "198.51.100.7"
        server_hostname = "buffer.fun"
        all_hosts = ["198.51.100.7", "198.51.100.8"]

    async def fake_resolve(host, force_refresh=False):
        resolver.calls.append((host, force_refresh))
        return FakeResolved()

    attempts = []

    async def attempt(connect_host, server_hostname):
        attempts.append(connect_host)
        if connect_host == "198.51.100.7":
            raise OSError("unreachable")
        return "connected"

    monkeypatch.setattr(node_connect, "resolve_node_address", fake_resolve)

    # 首个 IP 失败后立刻看到同一轮的第二个 IP（不额外触发重解析）
    result = asyncio.run(for_each_node_address("buffer.fun", attempt))
    assert result == "connected"
    assert attempts[:2] == ["198.51.100.7", "198.51.100.8"]


def test_hourly_recheck_keeps_using_old_ip_when_doh_fails(monkeypatch, clock):
    calls = []

    async def fake_resolve(host, force_refresh=False):
        calls.append(force_refresh)
        if force_refresh:
            raise RuntimeError("DoH down")
        return _resolved(all_hosts=("198.51.100.7",))

    monkeypatch.setattr(node_connect, "resolve_node_address", fake_resolve)

    attempts = []

    async def attempt(connect_host, server_hostname):
        attempts.append(connect_host)
        return "connected"

    asyncio.run(for_each_node_address("buffer.fun", attempt))
    clock.advance(HOURLY_RECHECK_INTERVAL)
    result = asyncio.run(for_each_node_address("buffer.fun", attempt))

    # 复查失败不报错，继续用原 IP
    assert result == "connected"
    assert attempts == ["198.51.100.7", "198.51.100.7"]


def test_hourly_recheck_failure_is_not_retried_until_next_hour(monkeypatch, clock):
    calls = []

    async def fake_resolve(host, force_refresh=False):
        calls.append((host, force_refresh))
        if force_refresh:
            raise RuntimeError("DoH down")
        return _resolved(all_hosts=("198.51.100.7",))

    monkeypatch.setattr(node_connect, "resolve_node_address", fake_resolve)

    async def attempt(connect_host, server_hostname):
        return "connected"

    asyncio.run(for_each_node_address("buffer.fun", attempt))
    clock.advance(HOURLY_RECHECK_INTERVAL)
    for _ in range(20):
        asyncio.run(for_each_node_address("buffer.fun", attempt))

    # 首次 + 一次失败的复查，之后到下一个小时前不再查询
    assert calls == [("buffer.fun", False), ("buffer.fun", True)]


def test_ip_target_without_doh(monkeypatch):
    calls = []

    async def fake_resolve(host, force_refresh=False):
        calls.append(host)
        return types.SimpleNamespace(
            connect_host="198.51.100.7",
            server_hostname=None,
            all_hosts=["198.51.100.7"],
            is_resolved=False,
        )

    monkeypatch.setattr(node_connect, "resolve_node_address", fake_resolve)

    async def attempt(connect_host, server_hostname):
        return (connect_host, server_hostname)

    result = asyncio.run(for_each_node_address("198.51.100.7", attempt))

    assert result == ("198.51.100.7", None)


# --- 端到端：降级后仍校验证书 pin -------------------------------------------


class FakeReader:
    def __init__(self):
        self._chunks = [b"\x05\x00", b"\x05\x00\x00\x01", b"\x00\x00\x00\x00\x00\x00"]

    async def readexactly(self, n):
        return self._chunks.pop(0)

    async def readline(self):
        return b""


class FakeWriter:
    def __init__(self, ssl_object):
        self._ssl_object = ssl_object
        self.closed = False

    def write(self, data):
        pass

    async def drain(self):
        pass

    def get_extra_info(self, name):
        return self._ssl_object if name == "ssl_object" else None

    def close(self):
        self.closed = True

    async def wait_closed(self):
        pass

    def is_closing(self):
        return self.closed


def test_cert_pin_verified_on_sni_suppressed_connection(monkeypatch):
    calls = []
    pin_objects = []
    ssl_object = object()

    async def fake_resolve(host, force_refresh=False):
        return _resolved(all_hosts=("198.51.100.7",))

    async def fake_open_connection(host, port, ssl=None, server_hostname=None):
        calls.append(server_hostname)
        if server_hostname == "buffer.fun":
            raise ConnectionResetError(54, "Connection reset by peer")
        return FakeReader(), FakeWriter(ssl_object)

    monkeypatch.setattr(node_connect, "resolve_node_address", fake_resolve)
    monkeypatch.setattr(node_connect.asyncio, "open_connection", fake_open_connection)

    config = {
        "address": "buffer.fun",
        "port": 8002,
        "username": "",
        "password": "",
        "tls": True,
    }

    asyncio.run(
        proxy_core.connect_upstream_socks5(
            config,
            "example.com",
            443,
            ssl_ctx=_ctx(),
            verify_cert_pin=pin_objects.append,
        )
    )

    # 先带 SNI 被 RST，再用 IP（不发 SNI）成功，pin 用的正是降级后那条连接
    assert calls == ["buffer.fun", "198.51.100.7"]
    assert pin_objects == [ssl_object]


def test_plain_tcp_node_connection_never_sends_sni(monkeypatch):
    calls = []

    async def fake_resolve(host, force_refresh=False):
        return _resolved(all_hosts=("198.51.100.8",))

    async def fake_open_connection(host, port, ssl=None, server_hostname=None):
        calls.append((host, port, ssl, server_hostname))
        return FakeReader(), FakeWriter(None)

    monkeypatch.setattr(node_connect, "resolve_node_address", fake_resolve)
    monkeypatch.setattr(node_connect.asyncio, "open_connection", fake_open_connection)

    asyncio.run(
        node_connect.open_node_connection(
            {"address": "buffer.fun", "port": 8080}, use_tls=False, timeout=5
        )
    )

    assert calls == [("198.51.100.8", 8080, None, None)]
