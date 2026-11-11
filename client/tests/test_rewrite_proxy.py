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


def _send_request(sock, port, path, method="GET", body=None, extra_headers=()):
    req = f"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
    for h in extra_headers:
        req += h + "\r\n"
    if body is not None:
        req += f"Content-Length: {len(body)}\r\n"
    req += "\r\n"
    sock.sendall(req.encode() + (body or b""))


def _http_get(port, path="/path", method="GET", body=None, extra_headers=(),
              timeout=10):
    """用裸 socket 发一个 HTTP 请求，返回 (status_line, headers, body)。

    按响应自身的 framing（chunked / Content-Length）读到边界即停：服务端
    现在是真 keep-alive，不再靠关连接表示结束。
    """
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as s:
        _send_request(s, port, path, method=method, body=body,
                      extra_headers=extra_headers)
        return _read_one_response(s, timeout=timeout)


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


# ---------------------------------------------------------------------------
# keep-alive 与 HTTP framing
#
# 背景：adapter（996）在 SSE 响应里硬编码 `connection: keep-alive`，即使请求
# 带了 `Connection: close` 也不真关连接，却把该连接标记为待关闭；Node 在它上面
# 收到第二个请求就回 `HTTP/1.1 400 Bad Request`（空 body，HPE_CLOSED_CONNECTION）。
# 旧实现把上游响应的 keep-alive 原样透传给客户端、又把后续客户端字节无条件灌进
# 同一个上游 socket，于是 Claude Code 复用连接时必踩这个 400。
#
# 修法：客户端侧真 keep-alive，每个请求新建一条上游连接、读完响应主动关闭。
# ---------------------------------------------------------------------------


class _KeepAliveTarget:
    """模仿 996：响应带 `connection: keep-alive`，故意**不**理会请求里的
    `Connection: close`（不关连接），可以多个请求共用一条连接。

    mode="chunked"     → Transfer-Encoding: chunked
    mode="length"      → Content-Length
    mode="close"       → 无 framing 头，靠关连接表示结束
    """

    def __init__(self, mode="chunked", body=b"TARGET-OK", always_keep_alive=True):
        self.mode = mode
        self.body = body
        self.always_keep_alive = always_keep_alive
        self.port = _free_port()
        self.requests = []          # 每条记录含 conn_id
        self.conn_open_count = 0
        self.conn_closed_count = 0
        self._conn_seq = 0
        self._loop = None
        self._thread = None
        self._server = None
        self._ready = threading.Event()

    async def _handler(self, reader, writer):
        self._conn_seq += 1
        conn_id = self._conn_seq
        self.conn_open_count += 1
        try:
            while True:
                try:
                    request_line = await asyncio.wait_for(reader.readline(), timeout=5)
                except asyncio.TimeoutError:
                    return
                if not request_line:
                    return
                headers = []
                while True:
                    line = await asyncio.wait_for(reader.readline(), timeout=5)
                    if line in (b"\r\n", b"\n", b""):
                        break
                    headers.append(line.decode("utf-8", "replace").rstrip("\r\n"))
                lowered = [h.lower() for h in headers]
                content_length = 0
                for h in lowered:
                    if h.startswith("content-length:"):
                        try:
                            content_length = int(h.split(":", 1)[1].strip())
                        except ValueError:
                            content_length = 0
                body = b""
                if content_length:
                    body = await asyncio.wait_for(
                        reader.readexactly(content_length), timeout=5
                    )
                elif "transfer-encoding: chunked" in lowered:
                    # 解析 chunked 请求体（rewrite 会原样转发 chunk 帧）
                    while True:
                        size_line = await asyncio.wait_for(
                            reader.readline(), timeout=5
                        )
                        size = int(size_line.split(b";")[0].strip(), 16)
                        if size == 0:
                            await asyncio.wait_for(reader.readline(), timeout=5)
                            break
                        body += await asyncio.wait_for(
                            reader.readexactly(size), timeout=5
                        )
                        await asyncio.wait_for(reader.readline(), timeout=5)
                self.requests.append({
                    "conn_id": conn_id,
                    "request_line": request_line.decode("utf-8", "replace").strip(),
                    "headers": headers,
                    "body": body,
                })
                await self._respond(writer)
                await writer.drain()
                # 真 996 的行为：无视 Connection: close，连接继续可用
                if not self.always_keep_alive:
                    return
        except (asyncio.TimeoutError, asyncio.IncompleteReadError,
                ConnectionResetError, OSError):
            pass
        finally:
            self.conn_closed_count += 1
            try:
                writer.close()
            except Exception:
                pass

    async def _respond(self, writer):
        if self.mode == "chunked":
            writer.write(
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Type: text/plain\r\n"
                b"connection: keep-alive\r\n"
                b"Transfer-Encoding: chunked\r\n\r\n"
            )
            writer.write(b"%x\r\n" % len(self.body) + self.body + b"\r\n")
            writer.write(b"0\r\n\r\n")
        elif self.mode == "length":
            writer.write(
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Type: text/plain\r\n"
                b"connection: keep-alive\r\n"
                b"Content-Length: " + str(len(self.body)).encode() + b"\r\n\r\n"
                + self.body
            )
        else:  # close-delimited
            writer.write(
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Type: text/plain\r\n"
                b"connection: keep-alive\r\n\r\n" + self.body
            )

    def start(self):
        async def _serve():
            self._server = await asyncio.start_server(
                self._handler, "127.0.0.1", self.port
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


def _read_one_response(sock, timeout=15):
    sock.settimeout(timeout)
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(65536)
        if not chunk:
            raise AssertionError(f"连接在响应头前关闭: {buf!r}")
        buf += chunk
    head, rest = buf.split(b"\r\n\r\n", 1)
    lines = head.decode("utf-8", "replace").split("\r\n")
    status, headers, body = lines[0], lines[1:], rest
    lowered = "\r\n".join(headers).lower()

    if "transfer-encoding: chunked" in lowered:
        data = body
        decoded = b""
        while True:
            while b"\r\n" not in data:
                chunk = sock.recv(65536)
                if not chunk:
                    raise AssertionError("chunked 响应中途断开")
                data += chunk
            size_line, data = data.split(b"\r\n", 1)
            size = int(size_line.split(b";")[0].strip() or b"0", 16)
            if size == 0:
                # 吃掉可选的 trailer 直到空行
                while not data.startswith(b"\r\n"):
                    if b"\r\n" in data:
                        data = data.split(b"\r\n", 1)[1]
                    else:
                        more = sock.recv(65536)
                        if not more:
                            break
                        data += more
                break
            while len(data) < size + 2:
                chunk = sock.recv(65536)
                if not chunk:
                    raise AssertionError("chunked 响应中途断开")
                data += chunk
            decoded += data[:size]
            data = data[size + 2:]
        return status, headers, decoded

    for h in headers:
        if h.lower().startswith("content-length:"):
            length = int(h.split(":", 1)[1].strip())
            while len(body) < length:
                chunk = sock.recv(65536)
                if not chunk:
                    raise AssertionError("Content-Length 响应中途断开")
                body += chunk
            return status, headers, body[:length]

    # close-delimited
    while True:
        chunk = sock.recv(65536)
        if not chunk:
            break
        body += chunk
    return status, headers, body


def _send_request(sock, port, path, method="GET", body=None, extra_headers=()):
    req = f"{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n"
    for h in extra_headers:
        req += h + "\r\n"
    if body is not None:
        req += f"Content-Length: {len(body)}\r\n"
    req += "\r\n"
    sock.sendall(req.encode() + (body or b""))


def test_second_request_on_reused_client_connection_succeeds():
    """本 bug 的回归用例：同一条客户端连接上连发两个请求，都必须 200。

    旧实现在这里必挂：第 2 个请求被原样灌进已被上游标记关闭的连接，
    996 会回 `400 Bad Request` 空 body（正是 Claude Code 报的那个错）。
    """
    target = _KeepAliveTarget(mode="chunked").start()
    proxy, listen_port = _start_rewrite(f"http://127.0.0.1:{target.port}")
    try:
        with socket.create_connection(("127.0.0.1", listen_port), timeout=10) as s:
            _send_request(s, listen_port, "/v1/messages", method="POST",
                          body=b'{"n":1}',
                          extra_headers=["Content-Type: application/json"])
            status1, _h1, body1 = _read_one_response(s)
            assert status1.startswith("HTTP/1.1 200"), status1
            assert body1 == b"TARGET-OK"

            _send_request(s, listen_port, "/v1/messages", method="POST",
                          body=b'{"n":2}',
                          extra_headers=["Content-Type: application/json"])
            status2, _h2, body2 = _read_one_response(s)
            assert status2.startswith("HTTP/1.1 200"), (
                f"第二个请求失败：{status2} —— 这正是 Claude Code 看到的 400"
            )
            assert body2 == b"TARGET-OK"

        assert len(target.requests) == 2
        # 每个请求必须用独立的上游连接，且 Host 都要被改写
        assert len({r["conn_id"] for r in target.requests}) == 2, (
            "每个请求都应新建上游连接，不能复用已被标记关闭的那条"
        )
        for r in target.requests:
            host = next(h for h in r["headers"] if h.lower().startswith("host:"))
            assert host.strip().lower() == f"host: 127.0.0.1:{target.port}"
        assert [r["body"] for r in target.requests] == [b'{"n":1}', b'{"n":2}']
    finally:
        proxy.stop()
        target.stop()


def test_many_requests_do_not_leak_upstream_connections():
    """连发 N 个请求：上游连接数 == N，且每个用完即关（旧实现会挂到 300s）。"""
    target = _KeepAliveTarget(mode="chunked").start()
    proxy, listen_port = _start_rewrite(f"http://127.0.0.1:{target.port}")
    try:
        n = 5
        with socket.create_connection(("127.0.0.1", listen_port), timeout=10) as s:
            for i in range(n):
                _send_request(s, listen_port, f"/r{i}")
                status, _h, body = _read_one_response(s)
                assert status.startswith("HTTP/1.1 200"), f"第 {i} 个请求: {status}"
                assert body == b"TARGET-OK"
        # 上游应看到 n 条连接，且都被主动关闭
        import time
        deadline = time.monotonic() + 3
        while (target.conn_closed_count < n and time.monotonic() < deadline):
            time.sleep(0.02)
        assert target.conn_open_count == n, (
            f"每个请求应独立建连，实际开了 {target.conn_open_count} 条"
        )
        assert target.conn_closed_count >= n, (
            f"上游连接没被及时关闭（{target.conn_closed_count}/{n}），会泄漏 fd"
        )
    finally:
        proxy.stop()
        target.stop()


def test_chunked_response_framing_is_preserved():
    target = _KeepAliveTarget(mode="chunked", body=b"chunky").start()
    proxy, listen_port = _start_rewrite(f"http://127.0.0.1:{target.port}")
    try:
        with socket.create_connection(("127.0.0.1", listen_port), timeout=10) as s:
            _send_request(s, listen_port, "/chunk")
            status, headers, body = _read_one_response(s)
        assert status.startswith("HTTP/1.1 200")
        assert body == b"chunky"
        joined = "\r\n".join(headers).lower()
        assert "transfer-encoding: chunked" in joined
        assert "content-length" not in joined
    finally:
        proxy.stop()
        target.stop()


def test_content_length_response_framing_is_preserved():
    target = _KeepAliveTarget(mode="length", body=b"measured").start()
    proxy, listen_port = _start_rewrite(f"http://127.0.0.1:{target.port}")
    try:
        with socket.create_connection(("127.0.0.1", listen_port), timeout=10) as s:
            _send_request(s, listen_port, "/len")
            status, headers, body = _read_one_response(s)
        assert status.startswith("HTTP/1.1 200")
        assert body == b"measured"
        joined = "\r\n".join(headers).lower()
        assert "content-length: 8" in joined
    finally:
        proxy.stop()
        target.stop()


def test_close_delimited_response_is_reframed_as_chunked():
    """上游没有 chunked/Content-Length 时靠关连接表示结束。

    必须给客户端重构成 chunked，否则客户端读不到结尾、连接也没法复用。
    """
    target = _KeepAliveTarget(mode="close", body=b"no-framing").start()
    proxy, listen_port = _start_rewrite(f"http://127.0.0.1:{target.port}")
    try:
        with socket.create_connection(("127.0.0.1", listen_port), timeout=10) as s:
            _send_request(s, listen_port, "/close")
            status, headers, body = _read_one_response(s)
            assert status.startswith("HTTP/1.1 200")
            assert body == b"no-framing"
            joined = "\r\n".join(headers).lower()
            assert "transfer-encoding: chunked" in joined, (
                "close-delimited 响应必须重构成 chunked，客户端才有明确的结束"
            )
            # 连接应仍可复用
            _send_request(s, listen_port, "/close2")
            status2, _h2, body2 = _read_one_response(s)
            assert status2.startswith("HTTP/1.1 200"), status2
            assert body2 == b"no-framing"
    finally:
        proxy.stop()
        target.stop()


def test_client_connection_close_is_honored():
    """客户端显式 Connection: close → 本响应发完就关，不擅自保活。"""
    target = _KeepAliveTarget(mode="chunked").start()
    proxy, listen_port = _start_rewrite(f"http://127.0.0.1:{target.port}")
    try:
        with socket.create_connection(("127.0.0.1", listen_port), timeout=10) as s:
            _send_request(s, listen_port, "/once",
                          extra_headers=["Connection: close"])
            status, headers, body = _read_one_response(s)
            assert status.startswith("HTTP/1.1 200")
            assert body == b"TARGET-OK"
            assert "connection: close" in "\r\n".join(headers).lower()
            # 之后连接应被服务端关闭
            s.settimeout(5)
            assert s.recv(4096) == b"", "客户端要求 close 后服务端必须关闭连接"
    finally:
        proxy.stop()
        target.stop()


def test_post_body_forwarded_exactly_once():
    """请求体精确转发一次：不重复、不错位（旧实现靠 relay 读，边界不清）。"""
    target = _KeepAliveTarget(mode="length").start()
    proxy, listen_port = _start_rewrite(f"http://127.0.0.1:{target.port}")
    try:
        body = b'{"model":"claude","messages":[{"role":"user","content":"hi"}]}'
        with socket.create_connection(("127.0.0.1", listen_port), timeout=10) as s:
            _send_request(s, listen_port, "/v1/messages", method="POST", body=body,
                          extra_headers=["Content-Type: application/json"])
            status, _h, _p = _read_one_response(s)
            assert status.startswith("HTTP/1.1 200")
            # 同一连接上紧跟第二个请求，验证第一个请求体没有越界吃掉第二个请求
            _send_request(s, listen_port, "/v1/messages", method="POST",
                          body=b'{"second":true}',
                          extra_headers=["Content-Type: application/json"])
            status2, _h2, _p2 = _read_one_response(s)
            assert status2.startswith("HTTP/1.1 200"), status2

        assert [r["body"] for r in target.requests] == [
            body, b'{"second":true}',
        ]
        assert [r["request_line"] for r in target.requests] == [
            "POST /v1/messages HTTP/1.1", "POST /v1/messages HTTP/1.1",
        ]
    finally:
        proxy.stop()
        target.stop()


def test_chunked_request_body_is_forwarded():
    """客户端用 chunked 发请求体也要能精确转发（读完停在下一个请求边界）。"""
    target = _KeepAliveTarget(mode="length").start()
    proxy, listen_port = _start_rewrite(f"http://127.0.0.1:{target.port}")
    try:
        with socket.create_connection(("127.0.0.1", listen_port), timeout=10) as s:
            s.sendall(
                f"POST /chunked HTTP/1.1\r\nHost: 127.0.0.1:{listen_port}\r\n"
                f"Content-Type: application/json\r\n"
                f"Transfer-Encoding: chunked\r\n\r\n".encode()
                + b"6\r\nabcdef\r\n5\r\nghijk\r\n0\r\n\r\n"
            )
            status, _h, _p = _read_one_response(s)
            assert status.startswith("HTTP/1.1 200"), status
        # 上游收到的请求体是完整的（无论原样转发还是解 chunk 后重编码）
        assert b"abcdefghijk" in target.requests[0]["body"] or \
            target.requests[0]["body"] == b"abcdefghijk"
    finally:
        proxy.stop()
        target.stop()


def test_upgrade_request_is_rejected():
    """透明反代不承接协议升级（WebSocket 等），必须明确回 502 而不是挂住。"""
    target = _KeepAliveTarget(mode="chunked").start()
    proxy, listen_port = _start_rewrite(f"http://127.0.0.1:{target.port}")
    try:
        with socket.create_connection(("127.0.0.1", listen_port), timeout=10) as s:
            s.sendall(
                f"GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{listen_port}\r\n"
                f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                f"Sec-WebSocket-Version: 13\r\n\r\n".encode()
            )
            raw = s.recv(4096)
        assert raw.startswith(b"HTTP/1.1 502"), raw
        assert target.requests == [], "Upgrade 请求不应被转发到目标"
    finally:
        proxy.stop()
        target.stop()


def test_response_hop_by_hop_headers_are_stripped():
    """上游的逐跳头（Keep-Alive 等）不能透传给客户端。"""
    target = _KeepAliveTarget(mode="chunked").start()
    proxy, listen_port = _start_rewrite(f"http://127.0.0.1:{target.port}")
    try:
        with socket.create_connection(("127.0.0.1", listen_port), timeout=10) as s:
            _send_request(s, listen_port, "/hdr")
            status, headers, _body = _read_one_response(s)
        assert status.startswith("HTTP/1.1 200")
        joined = "\r\n".join(headers).lower()
        assert "keep-alive: timeout" not in joined
    finally:
        proxy.stop()
        target.stop()


def test_request_is_logged_to_access_log():
    """每请求一条 access 日志：出问题时不用再靠人工复现。"""
    import logging

    records = []

    class _Collect(logging.Handler):
        def emit(self, record):
            records.append(record.getMessage())

    handler = _Collect()
    target_logger = rewrite_proxy.access_logger
    old_level = target_logger.level
    target_logger.addHandler(handler)
    target_logger.setLevel(logging.INFO)
    target = _KeepAliveTarget(mode="chunked").start()
    proxy, listen_port = _start_rewrite(f"http://127.0.0.1:{target.port}")
    try:
        with socket.create_connection(("127.0.0.1", listen_port),
                                      timeout=10) as s:
            _send_request(s, listen_port, "/logged", method="POST", body=b"{}")
            status, _h, _b = _read_one_response(s)
        assert status.startswith("HTTP/1.1 200")
        # access 日志在服务端 finally 里写，与客户端读到响应的时机有微小竞态
        import time
        deadline = time.monotonic() + 3
        while not any("REWRITE" in m for m in records) \
                and time.monotonic() < deadline:
            time.sleep(0.02)
        assert any("REWRITE" in m and "/logged" in m for m in records), records
        assert any("200" in m for m in records), records
    finally:
        target_logger.removeHandler(handler)
        target_logger.setLevel(old_level)
        proxy.stop()
        target.stop()
