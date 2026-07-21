import asyncio
import ipaddress
import json
import os
import socket
import ssl
import time
import urllib.parse
from dataclasses import dataclass


DEFAULT_DOH_BASE = os.environ.get("BLOCK_PROXY_DOH_BASE", "https://dns.alidns.com/resolve")
DEFAULT_DOH_BOOTSTRAP_IPS = [
    ip.strip()
    for ip in os.environ.get("BLOCK_PROXY_DOH_BOOTSTRAP_IPS", "223.5.5.5,223.6.6.6").split(",")
    if ip.strip()
]
DEFAULT_VERIFY_TLS = os.environ.get("BLOCK_PROXY_DOH_VERIFY_TLS", "0") == "1"
DOH_TIMEOUT = 8
DEFAULT_CACHE_TTL = 300


@dataclass(frozen=True)
class ResolvedNodeAddress:
    connect_host: str
    server_hostname: str | None
    all_hosts: list[str]
    is_resolved: bool
    from_stale_cache: bool = False


def _is_ip_address(host):
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def _unique_ips(values):
    result = []
    seen = set()
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


class DohResolver:
    def __init__(
        self,
        doh_base=DEFAULT_DOH_BASE,
        timeout=DOH_TIMEOUT,
        query_func=None,
        bootstrap_ips=None,
        verify_tls=DEFAULT_VERIFY_TLS,
    ):
        self._doh_base = doh_base
        self._timeout = timeout
        self._query_func = query_func
        self._bootstrap_ips = list(bootstrap_ips if bootstrap_ips is not None else DEFAULT_DOH_BOOTSTRAP_IPS)
        self._verify_tls = verify_tls

    async def query(self, domain, record_type):
        if self._query_func:
            return await self._query_func(domain, record_type)
        return await asyncio.to_thread(self._query_sync, domain, record_type)

    def _query_sync(self, domain, record_type):
        record_types = {"A": (1, 4), "AAAA": (28, 6)}
        expected = record_types.get(record_type)
        if not expected:
            raise RuntimeError(f"Unsupported DoH record type: {record_type}")

        expected_type, expected_ip_version = expected
        data = self._request_json(domain, record_type)

        ips = []
        for answer in data.get("Answer", []):
            value = answer.get("data")
            if answer.get("type") != expected_type or not isinstance(value, str):
                continue
            try:
                parsed_ip = ipaddress.ip_address(value)
            except ValueError:
                continue
            if parsed_ip.version == expected_ip_version:
                ips.append(value)
        return _unique_ips(ips)

    def _request_json(self, domain, record_type):
        parsed = urllib.parse.urlparse(self._doh_base)
        if parsed.scheme != "https" or not parsed.hostname:
            raise RuntimeError(f"Unsupported DoH endpoint: {self._doh_base}")

        host = parsed.hostname
        port = parsed.port or 443
        path = parsed.path or "/resolve"
        query = urllib.parse.urlencode({"name": domain, "type": record_type})
        target = f"{path}?{query}"
        connect_hosts = self._bootstrap_ips or [host]
        last_error = None

        for connect_host in connect_hosts:
            try:
                body = self._https_get_json_body(connect_host, port, host, target)
                return json.loads(body)
            except Exception as exc:
                last_error = exc

        raise RuntimeError(f"DoH query failed: {last_error}")

    def _https_get_json_body(self, connect_host, port, host_header, target):
        raw_sock = socket.create_connection((connect_host, port), timeout=self._timeout)
        sock = None
        try:
            if self._verify_tls:
                context = ssl.create_default_context()
            else:
                context = ssl._create_unverified_context()
            sock = context.wrap_socket(raw_sock, server_hostname=host_header)
            request = (
                f"GET {target} HTTP/1.1\r\n"
                f"Host: {host_header}\r\n"
                "Accept: application/dns-json\r\n"
                "Connection: close\r\n"
                "\r\n"
            )
            sock.sendall(request.encode("ascii"))
            chunks = []
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
            response = b"".join(chunks)
        finally:
            try:
                (sock or raw_sock).close()
            except OSError:
                pass

        header, sep, body = response.partition(b"\r\n\r\n")
        if not sep:
            raise RuntimeError("DoH response missing headers")
        status_line = header.split(b"\r\n", 1)[0].decode("ascii", errors="replace")
        parts = status_line.split(" ", 2)
        if len(parts) < 2 or not parts[1].startswith("2"):
            raise RuntimeError(f"DoH HTTP error: {status_line}")
        return body.decode("utf-8")


class NodeAddressResolver:
    def __init__(self, doh_resolver=None, cache_ttl=DEFAULT_CACHE_TTL):
        self._doh = doh_resolver or DohResolver()
        self._cache_ttl = cache_ttl
        self._fresh_cache = {}
        self._stale_cache = {}

    def clear_fresh_cache(self):
        self._fresh_cache.clear()

    async def resolve(self, host):
        host = str(host).strip()
        if not host:
            raise RuntimeError("Node host is empty")
        if _is_ip_address(host):
            return ResolvedNodeAddress(
                connect_host=host,
                server_hostname=None,
                all_hosts=[host],
                is_resolved=False,
            )

        now = time.monotonic()
        cached = self._fresh_cache.get(host)
        if cached and cached[0] > now:
            return cached[1]

        try:
            ipv4, ipv6 = await asyncio.gather(
                self._doh.query(host, "A"),
                self._doh.query(host, "AAAA"),
            )
            ips = _unique_ips([*ipv4, *ipv6])
            if not ips:
                raise RuntimeError(f"No A/AAAA records for {host}")
            resolved = ResolvedNodeAddress(
                connect_host=ips[0],
                server_hostname=host,
                all_hosts=ips,
                is_resolved=True,
            )
            self._fresh_cache[host] = (now + self._cache_ttl, resolved)
            self._stale_cache[host] = resolved
            return resolved
        except Exception:
            stale = self._stale_cache.get(host)
            if stale:
                return ResolvedNodeAddress(
                    connect_host=stale.connect_host,
                    server_hostname=stale.server_hostname,
                    all_hosts=stale.all_hosts,
                    is_resolved=stale.is_resolved,
                    from_stale_cache=True,
                )
            raise


_default_resolver = NodeAddressResolver()


async def resolve_node_address(host):
    return await _default_resolver.resolve(host)
