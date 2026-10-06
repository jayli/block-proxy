"""公网代理 HTTP over TLS：客户端 protocol=http 时也应走 TLS（8002 端口）。"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core
import node_connect


class FakeReader:
    def __init__(self, chunks, eof=False):
        self._chunks = list(chunks)
        self._eof = eof

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
        return self._eof


class FakeWriter:
    def __init__(self, ssl_object=None, closing=False):
        self.writes = []
        self.closed = False
        self.closing = closing
        self._ssl_object = ssl_object

    def write(self, data):
        self.writes.append(data)

    async def drain(self):
        pass

    def close(self):
        self.closed = True
        self.closing = True

    async def wait_closed(self):
        pass

    def is_closing(self):
        return self.closing

    def get_extra_info(self, name):
        assert name == "ssl_object"
        return self._ssl_object


def http_tls_config():
    return {
        "protocol": "http",
        "address": "node.example",
        "port": 8002,
        "username": "u",
        "password": "p",
        "tls": True,
        "allowInsecure": True,
    }


def test_connect_upstream_http_uses_tls_when_tls_enabled(monkeypatch):
    calls = []
    ssl_object = object()
    writer = FakeWriter(ssl_object=ssl_object)
    reader = FakeReader([b"HTTP/1.1 200 Connection Established\r\n", b"\r\n"])

    class FakeResolved:
        connect_host = "198.51.100.8"
        server_hostname = "node.example"
        all_hosts = ["198.51.100.8"]
        is_resolved = True

    async def fake_resolve(host, force_refresh=False):
        return FakeResolved()

    async def fake_open_connection(*args, **kwargs):
        calls.append((args, kwargs))
        return reader, writer

    monkeypatch.setattr(node_connect, "resolve_node_address", fake_resolve)
    monkeypatch.setattr(node_connect.asyncio, "open_connection", fake_open_connection)

    pinned = []
    asyncio.run(proxy_core.connect_upstream_http(
        http_tls_config(), "target.example", 443,
        ssl_ctx=object(), verify_cert_pin=pinned.append,
    ))

    assert calls[0][1].get("ssl") is not None, "protocol=http + tls 未走 TLS"
    assert calls[0][1].get("server_hostname") == "node.example"
    assert writer.writes[0].startswith(b"CONNECT target.example:443 HTTP/1.1\r\n")
    assert b"Proxy-Authorization: Basic" in writer.writes[0]
    assert pinned == [ssl_object], "http over TLS 未做证书 pin 校验"


def test_connect_upstream_http_stays_plain_tcp_when_tls_disabled(monkeypatch):
    calls = []
    writer = FakeWriter()
    reader = FakeReader([b"HTTP/1.1 200 Connection Established\r\n", b"\r\n"])

    class FakeResolved:
        connect_host = "198.51.100.8"
        server_hostname = "node.example"
        all_hosts = ["198.51.100.8"]
        is_resolved = True

    async def fake_resolve(host, force_refresh=False):
        return FakeResolved()

    async def fake_open_connection(*args, **kwargs):
        calls.append((args, kwargs))
        return reader, writer

    monkeypatch.setattr(node_connect, "resolve_node_address", fake_resolve)
    monkeypatch.setattr(node_connect.asyncio, "open_connection", fake_open_connection)

    config = http_tls_config()
    config["tls"] = False
    asyncio.run(proxy_core.connect_upstream_http(config, "target.example", 443, ssl_ctx=None))

    assert calls[0][1].get("ssl") is None


def test_upstream_pool_creates_tls_connection_for_http_protocol(monkeypatch):
    calls = []
    ssl_object = object()
    writer = FakeWriter(ssl_object=ssl_object)
    reader = FakeReader([])

    async def fake_open_node_connection(server_config, *, use_tls, ssl_ctx=None, timeout=None):
        calls.append({"use_tls": use_tls, "ssl_ctx": ssl_ctx})
        return reader, writer

    monkeypatch.setattr(proxy_core, "open_node_connection", fake_open_node_connection)

    pinned = []
    pool = proxy_core.UpstreamPool(http_tls_config(), object(), verify_cert_pin=pinned.append)
    asyncio.run(pool.create_connection())

    assert calls == [{"use_tls": True, "ssl_ctx": pool._ssl_ctx}]
    assert pinned == [ssl_object]


def test_tls_http_preconnects_are_marked_as_tombstones():
    async def scenario():
        pool = proxy_core.UpstreamPool(http_tls_config(), None)
        writer = FakeWriter(closing=True)
        await pool._pool.put((FakeReader([]), writer))

        await pool._mark_closed_preconnects()

        assert pool._pool.qsize() == 1
        assert pool._pool._queue[0] is proxy_core._POOL_ZOMBIE
        assert writer.closed is True

    asyncio.run(scenario())


def test_plain_http_preconnects_are_not_marked_as_tombstones():
    async def scenario():
        config = http_tls_config()
        config["tls"] = False
        pool = proxy_core.UpstreamPool(config, None)
        reader, writer = FakeReader([], eof=True), FakeWriter()
        await pool._pool.put((reader, writer))

        await pool._mark_closed_preconnects()

        assert pool._pool._queue[0] == (reader, writer)
        assert writer.closed is False

    asyncio.run(scenario())


def test_measure_latency_verifies_cert_pin_for_http_over_tls(monkeypatch):
    ssl_object = object()
    writer = FakeWriter(ssl_object=ssl_object)
    reader = FakeReader([b"HTTP/1.1 200 Connection Established\r\n", b"\r\n"])

    async def fake_open_node_connection(server_config, *, use_tls, ssl_ctx=None, timeout=None):
        assert use_tls is True
        return reader, writer

    monkeypatch.setattr(proxy_core, "open_node_connection", fake_open_node_connection)

    pc = proxy_core.ProxyCore()
    pc._server_config = http_tls_config()
    pc._ssl_ctx = object()
    pinned = []
    pc._verify_cert_pin = pinned.append

    latency, failure = asyncio.run(pc._measure_latency())

    assert failure is None, f"延迟探测失败: {failure}"
    assert latency is not None
    assert pinned == [ssl_object], "http over TLS 延迟探测未做证书 pin 校验"
