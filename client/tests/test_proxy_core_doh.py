import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core


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


def test_connect_upstream_socks5_uses_doh_ip_for_node_connection_but_keeps_sni(monkeypatch):
    calls = []
    writer = FakeWriter()
    reader = FakeReader([
        b"\x05\x00",
        b"\x05\x00\x00\x01",
        b"\x00\x00\x00\x00\x00\x00",
    ])

    class FakeResolved:
        connect_host = "198.51.100.7"
        server_hostname = "buffer.fun"
        is_resolved = True

    async def fake_resolve(host):
        assert host == "buffer.fun"
        return FakeResolved()

    async def fake_open_connection(*args, **kwargs):
        calls.append((args, kwargs))
        return reader, writer

    monkeypatch.setattr(proxy_core, "resolve_node_address", fake_resolve)
    monkeypatch.setattr(proxy_core.asyncio, "open_connection", fake_open_connection)

    config = {
        "address": "buffer.fun",
        "port": 8002,
        "username": "",
        "password": "",
        "tls": True,
    }

    asyncio.run(proxy_core.connect_upstream_socks5(config, "example.com", 443, ssl_ctx=object()))

    assert calls[0][0][:2] == ("198.51.100.7", 8002)
    assert calls[0][1]["server_hostname"] == "buffer.fun"


def test_connect_upstream_http_uses_doh_ip_and_plain_tcp(monkeypatch):
    calls = []
    writer = FakeWriter()
    reader = FakeReader([
        b"HTTP/1.1 200 OK\r\n",
        b"\r\n",
    ])

    class FakeResolved:
        connect_host = "198.51.100.8"
        server_hostname = "buffer.fun"
        is_resolved = True

    async def fake_resolve(host):
        return FakeResolved()

    async def fake_open_connection(*args, **kwargs):
        calls.append((args, kwargs))
        return reader, writer

    monkeypatch.setattr(proxy_core, "resolve_node_address", fake_resolve)
    monkeypatch.setattr(proxy_core.asyncio, "open_connection", fake_open_connection)

    config = {
        "address": "buffer.fun",
        "port": 8002,
        "username": "",
        "password": "",
        "tls": True,
    }

    asyncio.run(proxy_core.connect_upstream_http(config, "target.example", 443, ssl_ctx=object()))

    assert calls[0][0][:2] == ("198.51.100.8", 8002)
    assert calls[0][1]["ssl"] is None
    assert calls[0][1]["server_hostname"] is None
    assert writer.writes[0].startswith(b"CONNECT target.example:443 HTTP/1.1\r\n")


def test_connect_upstream_retries_fresh_connection_after_stale_pool_entry(monkeypatch):
    stale_writer = FakeWriter()
    fresh_writer = FakeWriter()
    stale_reader = FakeReader([])
    fresh_reader = FakeReader([
        b"\x05\x00",
        b"\x05\x00\x00\x01",
        b"\x00\x00\x00\x00\x00\x00",
    ])

    class FakePool:
        def __init__(self):
            self.created = 0

        async def acquire(self):
            return stale_reader, stale_writer

        async def create_connection(self):
            self.created += 1
            return fresh_reader, fresh_writer

    pc = proxy_core.ProxyCore()
    pc._server_config = {
        "protocol": "socks5",
        "address": "buffer.fun",
        "port": 8002,
        "username": "",
        "password": "",
        "tls": False,
    }
    pc._ssl_ctx = None
    pc._upstream_pool = FakePool()

    reader, writer = asyncio.run(pc._connect_upstream("example.com", 443))

    assert (reader, writer) == (fresh_reader, fresh_writer)
    assert stale_writer.closed is True
    assert pc._upstream_pool.created == 1


def test_http_upstream_can_use_plain_tcp_pool_when_tls_flag_is_dirty(monkeypatch):
    writer = FakeWriter()
    reader = FakeReader([
        b"HTTP/1.1 200 OK\r\n",
        b"\r\n",
    ])

    class FakePool:
        async def acquire(self):
            return reader, writer

    pc = proxy_core.ProxyCore()
    pc._server_config = {
        "protocol": "http",
        "address": "buffer.fun",
        "port": 8002,
        "username": "",
        "password": "",
        "tls": True,
    }
    pc._ssl_ctx = object()
    pc._upstream_pool = FakePool()

    result_reader, result_writer = asyncio.run(pc._connect_upstream("target.example", 443))

    assert (result_reader, result_writer) == (reader, writer)
    assert writer.writes[0].startswith(b"CONNECT target.example:443 HTTP/1.1\r\n")


def test_local_proxy_recycle_waits_for_twenty_seconds_without_activity():
    pc = proxy_core.ProxyCore()
    pc._active_connections = 0
    pc._last_proxy_activity = 100.0

    assert pc._can_recycle_local_proxy(119.9) is False
    assert pc._can_recycle_local_proxy(120.0) is True


def test_local_proxy_recycle_does_not_run_with_active_connections():
    pc = proxy_core.ProxyCore()
    pc._active_connections = 1
    pc._last_proxy_activity = 100.0

    assert pc._can_recycle_local_proxy(200.0) is False


def test_local_proxy_recycle_only_restarts_local_servers(monkeypatch):
    pc = proxy_core.ProxyCore()
    calls = []

    async def fake_stop_local_proxy():
        calls.append("stop_local_proxy")

    async def fake_start_local_proxy(allow_port_retry):
        assert allow_port_retry is False
        calls.append("start_local_proxy")

    monkeypatch.setattr(pc, "_stop_local_proxy", fake_stop_local_proxy)
    monkeypatch.setattr(pc, "_start_local_proxy", fake_start_local_proxy)

    asyncio.run(pc._recycle_local_proxy_once())

    assert calls == ["stop_local_proxy", "start_local_proxy"]


def test_forced_local_proxy_recycle_is_serialized(monkeypatch):
    pc = proxy_core.ProxyCore()
    calls = []

    async def fake_stop_local_proxy():
        calls.append("stop")
        await asyncio.sleep(0)

    async def fake_start_local_proxy(allow_port_retry):
        assert allow_port_retry is False
        calls.append("start")
        await asyncio.sleep(0)

    monkeypatch.setattr(pc, "_stop_local_proxy", fake_stop_local_proxy)
    monkeypatch.setattr(pc, "_start_local_proxy", fake_start_local_proxy)

    async def run_two_recycles():
        await asyncio.gather(
            pc._recycle_local_proxy_forced_once(),
            pc._recycle_local_proxy_forced_once(),
        )

    asyncio.run(run_two_recycles())

    assert calls == ["stop", "start", "stop", "start"]
