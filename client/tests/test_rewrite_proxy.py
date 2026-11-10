"""重定向（透明反向代理）测试。

覆盖：目标地址解析、请求改写（Host / X-Forwarded-* / Connection）、
https 目标端到端转发（自签证书不校验）、http 目标、路径与查询串透传、
POST 请求体透传、目标不可达返回 502、生命周期（独立启停 / 端口被占）。
"""

import asyncio
import os
import socket
import ssl
import subprocess
import sys
import threading

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import rewrite_proxy
from config import (
    DEFAULT_CONFIG,
    parse_rewrite_target,
    validate_rewrite_target,
    probe_rewrite_listen_port,
    REWRITE_PORT_RESERVED_HINT,
    REWRITE_PORT_IN_USE_HINT,
)
from rewrite_proxy import RewriteProxy


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ---------------------------------------------------------------------------
# 目标地址解析
# ---------------------------------------------------------------------------


def test_parse_target_https_with_port():
    assert parse_rewrite_target("https://abc.com:996") == ("https", "abc.com", 996)


def test_parse_target_https_defaults_to_443():
    assert parse_rewrite_target("https://abc.com") == ("https", "abc.com", 443)


def test_parse_target_http_defaults_to_80():
    assert parse_rewrite_target("http://x.io:8080") == ("http", "x.io", 8080)


def test_parse_target_accepts_bare_host_as_https():
    assert parse_rewrite_target("abc.com:996") == ("https", "abc.com", 996)


def test_parse_target_ignores_path_and_query():
    """只取 scheme/host/port：转发时拼的是请求自己的 path。"""
    assert parse_rewrite_target("https://abc.com:996/api/v1?x=1") == (
        "https", "abc.com", 996
    )


def test_parse_target_accepts_ipv6_literal():
    assert parse_rewrite_target("https://[::1]:996") == ("https", "::1", 996)


def test_parse_target_allows_single_label_host():
    """目标常是本机/内网服务，必须允许 localhost 这类单标签主机名
    （与节点地址的「至少两段」校验不同）。"""
    assert parse_rewrite_target("https://localhost:8080") == (
        "https", "localhost", 8080
    )
    assert parse_rewrite_target("http://myhost:996") == ("http", "myhost", 996)


@pytest.mark.parametrize("bad", [
    "https://a..b:80", "https://-bad.com:80", "https://bad-.com:80",
    "https://sp ace.com:80",
])
def test_parse_target_rejects_malformed_host(bad):
    assert parse_rewrite_target(bad) is None


@pytest.mark.parametrize("bad", [
    "", "   ", "ftp://a.com", "https://", "https://a.com:99999",
    "https://a.com:0", "://x",
])
def test_parse_target_rejects_invalid(bad):
    assert parse_rewrite_target(bad) is None


def test_validate_target_messages():
    assert validate_rewrite_target("") == "目标地址不能为空"
    assert validate_rewrite_target("ftp://a.com") is not None
    assert validate_rewrite_target("https://abc.com:996") is None


def test_default_config_has_rewrite_block():
    assert DEFAULT_CONFIG["rewrite"] == {
        "enabled": False, "listen_port": 996, "target": "",
    }


# ---------------------------------------------------------------------------
# 本地监听端口可绑定性探测（面板打开开关时提前报错，不用等保存后翻日志）
# ---------------------------------------------------------------------------


def test_probe_reserved_port_reports_reserved_hint():
    """1024 以下是保留端口，非 root bind 必然被拒——探测要给出换端口的建议。"""
    assert probe_rewrite_listen_port(997) == REWRITE_PORT_RESERVED_HINT
    assert probe_rewrite_listen_port(80) == REWRITE_PORT_RESERVED_HINT


def test_probe_free_port_returns_none():
    assert probe_rewrite_listen_port(_free_port()) is None


def test_probe_occupied_port_reports_in_use():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen(1)
    port = s.getsockname()[1]
    try:
        assert probe_rewrite_listen_port(port) == REWRITE_PORT_IN_USE_HINT
    finally:
        s.close()


def test_probe_occupied_port_ignored_when_listener_may_hold_it():
    """ignore_in_use=True：主进程 listener 正占着该端口是正常状态，不报错。"""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen(1)
    port = s.getsockname()[1]
    try:
        assert probe_rewrite_listen_port(port, ignore_in_use=True) is None
    finally:
        s.close()


def test_probe_releases_port_after_check():
    """探测完立即释放端口，否则主进程随后真 bind 会撞上自己的探测。"""
    port = _free_port()
    assert probe_rewrite_listen_port(port) is None
    # 再绑一次必须仍然成功
    s = socket.socket()
    s.bind(("127.0.0.1", port))
    s.close()


def test_probe_invalid_port_defers_to_validate_port():
    """非法值交给 validate_port 报错，探测不重复报。"""
    assert probe_rewrite_listen_port("abc") is None
    assert probe_rewrite_listen_port("") is None
    assert probe_rewrite_listen_port(None) is None
    assert probe_rewrite_listen_port(0) is None
    assert probe_rewrite_listen_port(70000) is None


def test_probe_accepts_port_as_string():
    """面板输入框给的是字符串。"""
    assert probe_rewrite_listen_port("997") == REWRITE_PORT_RESERVED_HINT
    assert probe_rewrite_listen_port(str(_free_port())) is None


# ---------------------------------------------------------------------------
# 请求改写（纯函数，不起服务）
# ---------------------------------------------------------------------------


def _headers(*lines):
    return [line.encode() + b"\r\n" for line in lines]


def test_forwarded_request_rewrites_host_and_adds_forwarded_headers():
    proxy = RewriteProxy()
    out = proxy._build_forwarded_request(
        "GET", "/path", "HTTP/1.1",
        _headers("User-Agent: curl/8", "Accept: */*"),
        "127.0.0.1",
        ("https", "abc.com", 996),
    ).decode()

    assert out.startswith("GET /path HTTP/1.1\r\n")
    assert "Host: abc.com:996\r\n" in out
    assert "X-Real-IP: 127.0.0.1\r\n" in out
    assert "X-Forwarded-For: 127.0.0.1\r\n" in out
    assert "X-Forwarded-Proto: http\r\n" in out
    assert "Connection: close\r\n" in out
    # 原始头保留
    assert "User-Agent: curl/8\r\n" in out
    assert out.endswith("\r\n\r\n")


def test_forwarded_request_drops_client_host_and_connection():
    """客户端的 Host / Connection / Proxy-Connection 必须由本模块接管。"""
    proxy = RewriteProxy()
    out = proxy._build_forwarded_request(
        "GET", "/", "HTTP/1.1",
        _headers(
            "Host: 127.0.0.1:996",
            "Connection: keep-alive",
            "Proxy-Connection: keep-alive",
        ),
        "10.0.0.5",
        ("https", "abc.com", 996),
    ).decode()

    assert out.count("Host:") == 1
    assert "Host: abc.com:996\r\n" in out
    assert "127.0.0.1:996" not in out
    assert "Proxy-Connection" not in out
    assert out.count("Connection:") == 1
    assert "Connection: close\r\n" in out


def test_forwarded_request_omits_default_port_in_host():
    proxy = RewriteProxy()
    out = proxy._build_forwarded_request(
        "GET", "/", "HTTP/1.1", [], "127.0.0.1", ("https", "abc.com", 443)
    ).decode()
    assert "Host: abc.com\r\n" in out

    out80 = proxy._build_forwarded_request(
        "GET", "/", "HTTP/1.1", [], "127.0.0.1", ("http", "abc.com", 80)
    ).decode()
    assert "Host: abc.com\r\n" in out80


def test_forwarded_request_brackets_ipv6_host():
    proxy = RewriteProxy()
    out = proxy._build_forwarded_request(
        "GET", "/", "HTTP/1.1", [], "127.0.0.1", ("https", "::1", 996)
    ).decode()
    assert "Host: [::1]:996\r\n" in out


def test_forwarded_request_appends_to_existing_x_forwarded_for():
    proxy = RewriteProxy()
    out = proxy._build_forwarded_request(
        "GET", "/", "HTTP/1.1",
        _headers("X-Forwarded-For: 1.2.3.4"),
        "10.0.0.9",
        ("https", "abc.com", 996),
    ).decode()
    assert "X-Forwarded-For: 1.2.3.4, 10.0.0.9\r\n" in out
    assert out.count("X-Forwarded-For:") == 1


@pytest.mark.parametrize("raw,expected", [
    ("/path?a=1", "/path?a=1"),
    ("http://127.0.0.1:996/path", "/path"),
    ("http://127.0.0.1:996", "/"),
    ("*", "*"),
    ("abc.com/x", None),
])
def test_origin_path_normalization(raw, expected):
    assert RewriteProxy._origin_path(raw) == expected


def test_sni_suppressed_for_ip_literal():
    assert rewrite_proxy._sni_for("abc.com") == "abc.com"
    assert rewrite_proxy._sni_for("127.0.0.1") is None
    assert rewrite_proxy._sni_for("::1") is None


def test_target_ssl_context_does_not_verify():
    ctx = rewrite_proxy._target_ssl_context()
    assert ctx.verify_mode == ssl.CERT_NONE
    assert ctx.check_hostname is False


# ---------------------------------------------------------------------------
# 端到端：真实 HTTPS 目标（自签证书）
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def tls_cert(tmp_path_factory):
    """用 openssl 生成一张自签证书（CN/SAN 都是 localhost）。"""
    d = tmp_path_factory.mktemp("rewrite-cert")
    cert = d / "cert.pem"
    key = d / "key.pem"
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048",
            "-keyout", str(key), "-out", str(cert),
            "-days", "1", "-nodes", "-subj", "/CN=localhost",
            "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ],
        check=True, capture_output=True,
    )
    return str(cert), str(key)


class _TargetServer:
    """最小目标服务器：记录收到的请求，回固定响应。

    tls=True 时用自签证书（客户端不校验，正好验证 CERT_NONE 语义）。
    """

    def __init__(self, tls=False, cert=None, key=None, body=b"TARGET-OK",
                 echo_body=False):
        self.tls = tls
        self.cert, self.key = cert, key
        self.body = body
        self.echo_body = echo_body
        self.requests = []
        self.port = _free_port()
        self._loop = None
        self._thread = None
        self._server = None
        self._ready = threading.Event()

    def _ctx(self):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(self.cert, self.key)
        return ctx

    async def _handler(self, reader, writer):
        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=5)
            if not request_line:
                return
            headers = []
            while True:
                line = await asyncio.wait_for(reader.readline(), timeout=5)
                if line in (b"\r\n", b"\n", b""):
                    break
                headers.append(line.decode("utf-8", "replace").rstrip("\r\n"))
            self.requests.append({
                "request_line": request_line.decode("utf-8", "replace").strip(),
                "headers": headers,
                "host": next(
                    (h.split(":", 1)[1].strip() for h in headers
                     if h.lower().startswith("host:")),
                    None,
                ),
                "body": b"",
            })
            content_length = 0
            for h in headers:
                if h.lower().startswith("content-length:"):
                    try:
                        content_length = int(h.split(":", 1)[1].strip())
                    except ValueError:
                        content_length = 0
            if content_length:
                body = await asyncio.wait_for(
                    reader.readexactly(content_length), timeout=5
                )
                self.requests[-1]["body"] = body
            else:
                body = b""

            payload = body if self.echo_body else self.body
            writer.write(
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Type: text/plain\r\n"
                b"Content-Length: " + str(len(payload)).encode() + b"\r\n"
                b"Connection: close\r\n\r\n" + payload
            )
            await writer.drain()
        except (asyncio.TimeoutError, asyncio.IncompleteReadError,
                ConnectionResetError, OSError):
            pass
        finally:
            try:
                writer.close()
            except Exception:
                pass

    def start(self):
        async def _serve():
            kw = {}
            if self.tls:
                kw["ssl"] = self._ctx()
            self._server = await asyncio.start_server(
                self._handler, "127.0.0.1", self.port, **kw
            )
            self._ready.set()
            await self._server.wait_closed()

        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._loop.run_until_complete, args=(_serve(),), daemon=True
        )
        self._thread.start()
        assert self._ready.wait(timeout=5), "目标服务器未能启动"
        return self

    def stop(self):
        if self._server is not None:
            self._loop.call_soon_threadsafe(self._server.close)
        if self._thread is not None:
            self._thread.join(timeout=5)
        if self._loop is not None and not self._loop.is_closed():
            self._loop.close()


def _http_get(port, path="/path", method="GET", body=None, extra_headers=(),
              timeout=10):
    """用裸 socket 发一个 HTTP 请求，返回 (status_line, headers, body)。"""
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
        req = f"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
        for h in extra_headers:
            req += h + "\r\n"
        if body is not None:
            req += f"Content-Length: {len(body)}\r\n"
        req += "\r\n"
        s.sendall(req.encode())
        if body is not None:
            s.sendall(body)
        chunks = []
        while True:
            data = s.recv(65536)
            if not data:
                break
            chunks.append(data)
    raw = b"".join(chunks)
    head, _, payload = raw.partition(b"\r\n\r\n")
    lines = head.decode("utf-8", "replace").split("\r\n")
    return lines[0], lines[1:], payload


def _start_rewrite(target_url, listen_port=None):
    proxy = RewriteProxy()
    listen_port = listen_port or _free_port()
    ok, message = proxy.start({
        "enabled": True,
        "listen_port": listen_port,
        "target": target_url,
    })
    assert ok, message
    return proxy, listen_port


def test_https_target_end_to_end(tls_cert):
    """本地明文 HTTP → https 目标：Host 改写、路径透传、响应回传。"""
    cert, key = tls_cert
    target = _TargetServer(tls=True, cert=cert, key=key).start()
    proxy, listen_port = _start_rewrite(f"https://localhost:{target.port}")
    try:
        status, headers, payload = _http_get(listen_port, "/v1/messages")
        assert status.startswith("HTTP/1.1 200"), status
        assert payload == b"TARGET-OK"

        assert len(target.requests) == 1
        req = target.requests[0]
        assert req["request_line"] == "GET /v1/messages HTTP/1.1"
        assert req["host"] == f"localhost:{target.port}"
        joined = "\r\n".join(req["headers"]).lower()
        assert "x-real-ip: 127.0.0.1" in joined
        assert "x-forwarded-for: 127.0.0.1" in joined
        assert "x-forwarded-proto: http" in joined
        assert "connection: close" in joined
    finally:
        proxy.stop()
        target.stop()


def test_query_string_is_preserved(tls_cert):
    cert, key = tls_cert
    target = _TargetServer(tls=True, cert=cert, key=key).start()
    proxy, listen_port = _start_rewrite(f"https://localhost:{target.port}")
    try:
        status, _headers, _payload = _http_get(listen_port, "/p?a=1&b=2")
        assert status.startswith("HTTP/1.1 200")
        assert target.requests[0]["request_line"] == "GET /p?a=1&b=2 HTTP/1.1"
    finally:
        proxy.stop()
        target.stop()


def test_post_body_is_forwarded(tls_cert):
    cert, key = tls_cert
    target = _TargetServer(
        tls=True, cert=cert, key=key, echo_body=True
    ).start()
    proxy, listen_port = _start_rewrite(f"https://localhost:{target.port}")
    try:
        body = b'{"model":"claude","messages":[]}'
        status, _headers, payload = _http_get(
            listen_port, "/v1/messages", method="POST", body=body,
            extra_headers=["Content-Type: application/json"],
        )
        assert status.startswith("HTTP/1.1 200")
        assert payload == body
        assert target.requests[0]["body"] == body
        assert target.requests[0]["request_line"] == "POST /v1/messages HTTP/1.1"
    finally:
        proxy.stop()
        target.stop()


def test_http_target_end_to_end():
    """http:// 目标不升级 TLS，同样透传。"""
    target = _TargetServer(tls=False).start()
    proxy, listen_port = _start_rewrite(f"http://127.0.0.1:{target.port}")
    try:
        status, _headers, payload = _http_get(listen_port, "/plain")
        assert status.startswith("HTTP/1.1 200")
        assert payload == b"TARGET-OK"
        assert target.requests[0]["request_line"] == "GET /plain HTTP/1.1"
        assert target.requests[0]["host"] == f"127.0.0.1:{target.port}"
    finally:
        proxy.stop()
        target.stop()


def test_absolute_form_request_target_is_normalized(tls_cert):
    """代理风格客户端会发 absolute-form（http://127.0.0.1:996/path）。"""
    cert, key = tls_cert
    target = _TargetServer(tls=True, cert=cert, key=key).start()
    proxy, listen_port = _start_rewrite(f"https://localhost:{target.port}")
    try:
        status, _headers, _payload = _http_get(
            listen_port, f"http://127.0.0.1:{listen_port}/abs"
        )
        assert status.startswith("HTTP/1.1 200")
        assert target.requests[0]["request_line"] == "GET /abs HTTP/1.1"
    finally:
        proxy.stop()
        target.stop()


def test_unreachable_target_returns_502():
    """目标端口没人听：回 502，不挂死、不抛异常。"""
    dead_port = _free_port()
    proxy, listen_port = _start_rewrite(f"https://127.0.0.1:{dead_port}")
    try:
        status, headers, payload = _http_get(listen_port, "/x", timeout=20)
        assert status.startswith("HTTP/1.1 502"), status
        assert any(h.lower().startswith("content-length:") for h in headers)
        assert b"rewrite:" in payload
    finally:
        proxy.stop()


def test_connect_method_is_rejected():
    """透明反代不承接隧道式 CONNECT。"""
    target = _TargetServer(tls=False).start()
    proxy, listen_port = _start_rewrite(f"http://127.0.0.1:{target.port}")
    try:
        with socket.create_connection(("127.0.0.1", listen_port), timeout=10) as s:
            s.sendall(
                f"CONNECT abc.com:443 HTTP/1.1\r\nHost: abc.com\r\n\r\n".encode()
            )
            raw = s.recv(4096)
        assert raw.startswith(b"HTTP/1.1 502"), raw
        assert target.requests == [], "CONNECT 不应转发到目标"
    finally:
        proxy.stop()
        target.stop()


def test_malformed_request_line_is_dropped():
    target = _TargetServer(tls=False).start()
    proxy, listen_port = _start_rewrite(f"http://127.0.0.1:{target.port}")
    try:
        with socket.create_connection(("127.0.0.1", listen_port), timeout=10) as s:
            s.sendall(b"GARBAGE\r\n\r\n")
            assert s.recv(4096) == b""
        assert target.requests == []
        # 服务仍在正常工作
        status, _h, _p = _http_get(listen_port, "/ok")
        assert status.startswith("HTTP/1.1 200")
    finally:
        proxy.stop()
        target.stop()


# ---------------------------------------------------------------------------
# 生命周期：与主代理完全解耦
# ---------------------------------------------------------------------------


def test_disabled_config_does_not_start():
    proxy = RewriteProxy()
    ok, message = proxy.start({"enabled": False, "listen_port": 996,
                               "target": "https://abc.com:996"})
    assert ok is False
    assert proxy.is_running() is False
    assert "未启用" in message


def test_invalid_target_does_not_start():
    proxy = RewriteProxy()
    ok, message = proxy.start({"enabled": True, "listen_port": 996,
                               "target": "ftp://abc.com"})
    assert ok is False
    assert proxy.is_running() is False
    assert "目标地址无效" in message


def test_invalid_listen_port_does_not_start():
    proxy = RewriteProxy()
    for bad in [0, 70000, "abc", None]:
        ok, _message = proxy.start({"enabled": True, "listen_port": bad,
                                    "target": "https://abc.com:996"})
        assert ok is False
        assert proxy.is_running() is False


def test_port_in_use_reports_error_without_raising():
    """端口被占：返回失败而不是抛异常（不能拖垮 app 层）。"""
    blocker = socket.socket()
    blocker.bind(("127.0.0.1", 0))
    blocker.listen(1)
    busy_port = blocker.getsockname()[1]
    try:
        proxy = RewriteProxy()
        ok, message = proxy.start({
            "enabled": True, "listen_port": busy_port,
            "target": "https://abc.com:996",
        })
        assert ok is False
        assert proxy.is_running() is False
        assert "失败" in message
        # 事件循环不能泄漏
        assert proxy._loop is None and proxy._thread is None
    finally:
        blocker.close()


def test_listener_binds_loopback_only():
    """只绑 127.0.0.1：本机以外访问不到。"""
    proxy, listen_port = _start_rewrite("http://127.0.0.1:1")
    try:
        lan_ip = _primary_lan_ip()
        if lan_ip is None:
            pytest.skip("没有可用的局域网地址")
        with pytest.raises(OSError):
            socket.create_connection((lan_ip, listen_port), timeout=2)
    finally:
        proxy.stop()


def _primary_lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 53))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def test_stop_is_idempotent_and_releases_port():
    proxy, listen_port = _start_rewrite("http://127.0.0.1:1")
    proxy.stop()
    proxy.stop()
    assert proxy.is_running() is False
    # 端口已释放：可以立刻重新绑上
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", listen_port))
    finally:
        s.close()


def test_restart_with_new_config_replaces_listener():
    """改配置后重启：旧端口释放、新端口生效。"""
    first_port = _free_port()
    second_port = _free_port()
    target = _TargetServer(tls=False).start()
    proxy = RewriteProxy()
    try:
        ok, _msg = proxy.start({
            "enabled": True, "listen_port": first_port,
            "target": f"http://127.0.0.1:{target.port}",
        })
        assert ok
        status, _h, _p = _http_get(first_port, "/one")
        assert status.startswith("HTTP/1.1 200")

        ok, _msg = proxy.start({
            "enabled": True, "listen_port": second_port,
            "target": f"http://127.0.0.1:{target.port}",
        })
        assert ok
        assert proxy.listen_port == second_port

        status, _h, _p = _http_get(second_port, "/two")
        assert status.startswith("HTTP/1.1 200")
        with pytest.raises(OSError):
            socket.create_connection(("127.0.0.1", first_port), timeout=2)
        assert [r["request_line"] for r in target.requests] == [
            "GET /one HTTP/1.1", "GET /two HTTP/1.1",
        ]
    finally:
        proxy.stop()
        target.stop()


def test_rewrite_works_without_proxy_core_running():
    """解耦验证：不启动 ProxyCore，rewrite 也能独立服务。

    这是本功能的核心约束——主代理没连接时开关照样生效。
    """
    import proxy_core

    core = proxy_core.ProxyCore()
    assert core.is_running() is False

    target = _TargetServer(tls=False).start()
    proxy, listen_port = _start_rewrite(f"http://127.0.0.1:{target.port}")
    try:
        assert core.is_running() is False, "ProxyCore 不应被牵连启动"
        status, _h, payload = _http_get(listen_port, "/decoupled")
        assert status.startswith("HTTP/1.1 200")
        assert payload == b"TARGET-OK"
    finally:
        proxy.stop()
        target.stop()
    assert core.is_running() is False


def test_stop_with_inflight_connection_does_not_hang():
    """有连接在飞行中时 stop() 必须快速返回（不留僵尸线程）。"""
    target = _TargetServer(tls=False).start()
    proxy, listen_port = _start_rewrite(f"http://127.0.0.1:{target.port}")
    client = socket.create_connection(("127.0.0.1", listen_port), timeout=5)
    client.sendall(b"GET /slow HTTP/1.1\r\nHost: x\r\n")
    try:
        proxy.stop()
        assert proxy.is_running() is False
    finally:
        client.close()
        target.stop()


def test_module_logger_is_registered_for_crash_log():
    """rewrite_proxy 用普通模块 logger，必须登记进 logger.MODULE_LOGGERS，
    否则启动失败等关键告警一条都不落盘。"""
    import logger as logger_module

    assert "rewrite_proxy" in logger_module.MODULE_LOGGERS
