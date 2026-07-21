import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core


class FakeReader:
    def __init__(self, chunks):
        self._chunks = list(chunks)

    async def readexactly(self, n):
        data = self._chunks.pop(0)
        assert len(data) == n
        return data

    async def readline(self):
        return self._chunks.pop(0)


class FakeWriter:
    def __init__(self):
        self.writes = []

    def write(self, data):
        self.writes.append(data)

    async def drain(self):
        pass

    def close(self):
        pass

    async def wait_closed(self):
        pass


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


def test_connect_upstream_http_uses_doh_ip_and_preserves_connect_target(monkeypatch):
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
    assert calls[0][1]["server_hostname"] == "buffer.fun"
    assert writer.writes[0].startswith(b"CONNECT target.example:443 HTTP/1.1\r\n")
