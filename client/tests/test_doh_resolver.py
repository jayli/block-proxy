import asyncio
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from doh_resolver import DohResolver, NodeAddressResolver


def test_doh_query_ignores_invalid_ip_answers(monkeypatch):
    monkeypatch.setattr(
        "doh_resolver.DohResolver._request_json",
        lambda self, domain, record_type: {
            "Answer": [
                {"type": 1, "data": "not-an-ip"},
                {"type": 1, "data": "198.51.100.7"},
                {"type": 28, "data": "2001:db8::7"},
            ]
        },
    )

    resolver = DohResolver()

    assert asyncio.run(resolver.query("buffer.fun", "A")) == ["198.51.100.7"]


def test_doh_query_uses_bootstrap_ip_with_tls_hostname_and_host_header(monkeypatch):
    events = []

    class FakeSocket:
        def sendall(self, data):
            events.append(("send", data.decode("ascii")))

        def recv(self, size):
            if not hasattr(self, "_sent"):
                self._sent = True
                body = json.dumps({"Answer": [{"type": 1, "data": "198.51.100.9"}]})
                response = (
                    "HTTP/1.1 200 OK\r\n"
                    f"Content-Length: {len(body)}\r\n"
                    "\r\n"
                    f"{body}"
                )
                return response.encode("utf-8")
            return b""

        def close(self):
            events.append(("close", None))

    class FakeContext:
        def wrap_socket(self, sock, server_hostname):
            events.append(("sni", server_hostname))
            return sock

    def fake_create_connection(address, timeout):
        events.append(("connect", address, timeout))
        return FakeSocket()

    monkeypatch.setattr("doh_resolver.socket.create_connection", fake_create_connection)
    monkeypatch.setattr("doh_resolver.ssl.create_default_context", lambda: FakeContext())
    monkeypatch.setattr("doh_resolver.ssl._create_unverified_context", lambda: FakeContext())

    resolver = DohResolver(bootstrap_ips=["223.5.5.5"])

    assert asyncio.run(resolver.query("buffer.fun", "A")) == ["198.51.100.9"]
    assert ("connect", ("223.5.5.5", 443), 8) in events
    assert ("sni", "dns.alidns.com") in events
    sent = [event[1] for event in events if event[0] == "send"][0]
    assert "Host: dns.alidns.com\r\n" in sent
    assert "GET /resolve?name=buffer.fun&type=A HTTP/1.1\r\n" in sent


def test_doh_query_uses_unverified_tls_context_by_default(monkeypatch):
    calls = []

    class FakeSocket:
        def sendall(self, data):
            pass

        def recv(self, size):
            if not hasattr(self, "_sent"):
                self._sent = True
                return b'HTTP/1.1 200 OK\r\n\r\n{"Answer":[]}'
            return b""

        def close(self):
            pass

    class FakeContext:
        def wrap_socket(self, sock, server_hostname):
            return sock

    monkeypatch.setattr("doh_resolver.socket.create_connection", lambda *args, **kwargs: FakeSocket())
    monkeypatch.setattr("doh_resolver.ssl._create_unverified_context", lambda: calls.append("unverified") or FakeContext())
    monkeypatch.setattr("doh_resolver.ssl.create_default_context", lambda: calls.append("verified") or FakeContext())

    resolver = DohResolver(bootstrap_ips=["223.5.5.5"])
    asyncio.run(resolver.query("buffer.fun", "A"))

    assert calls == ["unverified"]


def test_node_resolver_returns_ip_without_doh_query():
    async def query(domain, record_type):
        raise AssertionError("IP addresses must not trigger DoH")

    resolver = NodeAddressResolver(DohResolver(query_func=query))

    result = asyncio.run(resolver.resolve("203.0.113.9"))

    assert result.connect_host == "203.0.113.9"
    assert result.server_hostname is None
    assert result.is_resolved is False


def test_node_resolver_resolves_domain_with_a_and_aaaa_records():
    calls = []

    async def query(domain, record_type):
        calls.append((domain, record_type))
        if record_type == "A":
            return ["198.51.100.7", "198.51.100.7"]
        if record_type == "AAAA":
            return ["2001:db8::7"]
        return []

    resolver = NodeAddressResolver(DohResolver(query_func=query))

    result = asyncio.run(resolver.resolve("buffer.fun"))

    assert calls == [("buffer.fun", "A"), ("buffer.fun", "AAAA")]
    assert result.connect_host == "198.51.100.7"
    assert result.server_hostname == "buffer.fun"
    assert result.all_hosts == ["198.51.100.7", "2001:db8::7"]
    assert result.is_resolved is True


def test_node_resolver_reuses_stale_result_when_doh_fails():
    attempts = 0

    async def query(domain, record_type):
        nonlocal attempts
        attempts += 1
        if attempts <= 2:
            return ["198.51.100.8"] if record_type == "A" else []
        raise RuntimeError("blocked")

    resolver = NodeAddressResolver(DohResolver(query_func=query))

    first = asyncio.run(resolver.resolve("buffer.fun"))
    resolver.clear_fresh_cache()
    second = asyncio.run(resolver.resolve("buffer.fun"))

    assert first.connect_host == "198.51.100.8"
    assert second.connect_host == "198.51.100.8"
    assert second.from_stale_cache is True


def test_node_resolver_raises_when_domain_has_no_records():
    async def query(domain, record_type):
        return []

    resolver = NodeAddressResolver(DohResolver(query_func=query))

    with pytest.raises(RuntimeError, match="No A/AAAA records"):
        asyncio.run(resolver.resolve("buffer.fun"))
