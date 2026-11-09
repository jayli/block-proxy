"""重定向（透明反向代理）：本地明文 HTTP 端口 → 外部目标地址。

类似 nginx 的 proxy_pass：客户端请求 http://127.0.0.1:<listen_port>/path，
本模块暗中转发到配置的目标（如 https://abc.com:996/path），改写 Host、
补 X-Real-IP / X-Forwarded-For / X-Forwarded-Proto，https 目标带 SNI 握
TLS 但不校验证书。调用方只看到本地端口的明文 HTTP，察觉不到目标存在。

与 ProxyCore 完全解耦：有自己的线程与事件循环，由 app 层按
config["rewrite"] 独立启停——主代理没有连接时也能单独生效。
目标连接一律直连（不经过代理节点）。

每条连接只服务一个请求：转发时强制 Connection: close，relay 结束后
关闭客户端连接。客户端（浏览器 / curl / Claude Code 等）会把这当作
服务端关闭 keep-alive，下个请求自动重连，行为兼容。
"""

import asyncio
import ipaddress
import logging
import socket
import ssl
import threading

logger = logging.getLogger("rewrite_proxy")

from logger import crash_logger
from proxy_core import (
    relay,
    connect_direct,
    IdleDeadline,
    RELAY_IDLE_TIMEOUT,
    _set_nodelay,
    _close_writer,
)
from traffic_stats import add_bytes

# 请求行 / 头部的读取超时
REQUEST_READ_TIMEOUT = 30
# 目标建连（含 TLS 握手）超时
TARGET_CONNECT_TIMEOUT = 15
# 单条连接允许的最大头部总量（防恶意/异常客户端灌内存）
MAX_HEADER_BYTES = 64 * 1024


def _target_ssl_context():
    """https 目标的 TLS 上下文：只加密、不校验证书（用户已确认该语义，
    与节点 allowInsecure 一致）。"""
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _sni_for(host):
    """域名目标发 SNI；IP 字面量不发（传 None，ssl 层会抑制 SNI）。"""
    try:
        ipaddress.ip_address(host)
        return None
    except ValueError:
        return host


async def _pump_request_body(reader, writer, idle):
    """把客户端剩余字节（请求体）透传给目标，直到 EOF；**不关闭 writer**。

    这里不能直接用 proxy_core.relay：它的 finally 会关掉 writer，而 TLS
    transport 的 can_write_eof() 为 False，走的是 writer.close() 全关。
    客户端发完请求就半关（SHUT_WR）时，那会把还在回响应的目标连接一并
    掉，响应被截断。目标侧的关闭统一由 _handle 的 finally 负责。
    """
    try:
        while True:
            try:
                data = await asyncio.wait_for(
                    reader.read(65536), timeout=idle.remaining()
                )
            except asyncio.TimeoutError:
                # 到期瞬间对向可能刚续过命；共享 deadline 下由对向主导存活
                if idle.remaining() > 0:
                    continue
                return
            if not data:
                return
            idle.touch()
            writer.write(data)
            add_bytes(len(data), "direct", "outbound")
            if writer.transport.get_write_buffer_size() > 65536:
                await writer.drain()
    except (ConnectionResetError, BrokenPipeError, OSError):
        return


class RewriteProxy:
    """独立线程 + 事件循环的透明反向代理。

    生命周期与 ProxyCore 同构但极简：start() 起线程跑事件循环，
    stop() 关 listener、取消遗留协程、停循环、join 线程。
    """

    def __init__(self):
        self._lock = threading.RLock()
        self._loop = None
        self._thread = None
        self._server = None
        self._running = False
        self._target = None  # (scheme, host, port)
        self._listen_port = None
        self._start_error = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def start(self, rewrite_config):
        """按 config["rewrite"] 启动。返回 (ok, message)。

        enabled=False 或配置不完整时返回 (False, 原因) 且不启动；
        端口被占用等启动失败同样只报错，不抛异常（不能拖垮 app 层）。
        """
        with self._lock:
            if self._running:
                self._stop_locked()

            rewrite_config = rewrite_config or {}
            if not rewrite_config.get("enabled"):
                return False, "未启用"
            target_text = str(rewrite_config.get("target") or "").strip()
            from config import parse_rewrite_target
            target = parse_rewrite_target(target_text)
            if target is None:
                return False, f"目标地址无效：{target_text or '（空）'}"
            try:
                listen_port = int(rewrite_config.get("listen_port"))
            except (TypeError, ValueError):
                return False, "本地监听端口无效"
            if not 1 <= listen_port <= 65535:
                return False, "本地监听端口必须在 1-65535 之间"

            self._target = target
            self._listen_port = listen_port
            self._start_error = None

            loop = asyncio.new_event_loop()
            self._loop = loop
            started = threading.Event()
            self._thread = threading.Thread(
                target=self._run_loop, args=(loop, started),
                name="rewrite-proxy", daemon=True,
            )
            self._thread.start()
            started.wait(timeout=5)
            thread = self._thread
            if self._start_error is not None or not started.is_set() \
                    or not thread.is_alive():
                # 启动失败（端口被占 / 线程异常退出）：关掉事件循环，
                # 不留半启动状态
                err = self._start_error or "监听线程未能启动"
                self._discard_loop(loop, thread)
                return False, f"监听 127.0.0.1:{listen_port} 失败：{err}"
            self._running = True
            scheme, host, port = target
            logger.info(
                "rewrite started: 127.0.0.1:%d -> %s://%s:%d",
                listen_port, scheme, host, port,
            )
            return True, f"127.0.0.1:{listen_port} -> {scheme}://{host}:{port}"

    def _discard_loop(self, loop, thread):
        """启动失败后回收事件循环与线程（不报错，只尽力清理）。"""
        self._thread = None
        self._loop = None
        self._target = None
        if thread is not None:
            try:
                if loop.is_running():
                    loop.call_soon_threadsafe(loop.stop)
                thread.join(timeout=3)
            except Exception:
                pass
        try:
            if not loop.is_running():
                loop.close()
        except Exception:
            pass

    def stop(self):
        with self._lock:
            self._stop_locked()

    def _stop_locked(self):
        self._running = False
        loop = self._loop
        thread = self._thread
        if loop is not None and loop.is_running():
            async def _shutdown():
                await self._stop_server()

            try:
                asyncio.run_coroutine_threadsafe(_shutdown(), loop).result(timeout=5)
            except Exception:
                crash_logger.warning("rewrite shutdown timed out", exc_info=True)
            finally:
                if loop.is_running():
                    loop.call_soon_threadsafe(loop.stop)
        if thread is not None:
            thread.join(timeout=3)
            if not thread.is_alive() and loop is not None:
                try:
                    loop.close()
                except Exception:
                    pass
        self._server = None
        self._loop = None
        self._thread = None
        self._target = None

    def is_running(self):
        return self._running

    @property
    def listen_port(self):
        return self._listen_port

    def _run_loop(self, loop, started_event):
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._start_server())
        except OSError as e:
            self._start_error = e
            started_event.set()
            return
        except Exception as e:
            self._start_error = e
            started_event.set()
            return
        started_event.set()
        loop.run_forever()

    async def _start_server(self):
        # 只绑 127.0.0.1：本机以外的流量到不了这个 listener
        self._server = await asyncio.start_server(
            self._handle, "127.0.0.1", self._listen_port
        )

    async def _stop_server(self):
        server = self._server
        self._server = None
        if server is not None:
            server.close()
        # 取消遗留的连接协程（与 ProxyCore._drain_pending_tasks 同理：
        # 不清掉它们，loop.close() 后 GC 收尾会抛 "Event loop is closed"）
        current = asyncio.current_task()
        pending = [t for t in asyncio.all_tasks() if t is not current]
        for task in pending:
            task.cancel()
        if pending:
            try:
                await asyncio.wait_for(
                    asyncio.gather(*pending, return_exceptions=True), timeout=2
                )
            except asyncio.TimeoutError:
                pass
        if server is not None:
            try:
                await asyncio.wait_for(server.wait_closed(), timeout=2)
            except asyncio.TimeoutError:
                pass

    # ------------------------------------------------------------------
    # Request handling
    # ------------------------------------------------------------------

    async def _handle(self, client_reader, client_writer):
        _set_nodelay(client_writer)
        # 快照目标：stop() 会把 self._target 置 None，而本协程可能还在飞行中
        target = self._target
        if target is None:
            await _close_writer(client_writer)
            return
        target_writer = None
        try:
            request_line = await asyncio.wait_for(
                client_reader.readline(), timeout=REQUEST_READ_TIMEOUT
            )
            if not request_line:
                return
            line = request_line.decode("utf-8", errors="replace").strip()
            parts = line.split()
            if len(parts) < 3:
                return
            method, request_target = parts[0].upper(), parts[1]
            if method == "CONNECT":
                # 透明反代只处理明文 HTTP 请求，不承接隧道式 CONNECT
                await self._write_502(client_writer, "CONNECT not supported")
                return

            headers = []
            total = 0
            while True:
                header_line = await asyncio.wait_for(
                    client_reader.readline(), timeout=REQUEST_READ_TIMEOUT
                )
                if header_line in (b"\r\n", b"\n", b""):
                    break
                total += len(header_line)
                if total > MAX_HEADER_BYTES:
                    return
                headers.append(header_line)

            path = self._origin_path(request_target)
            if path is None:
                await self._write_502(client_writer, "bad request target")
                return

            try:
                target_reader, target_writer = await asyncio.wait_for(
                    self._connect_target(target), timeout=TARGET_CONNECT_TIMEOUT
                )
            except Exception as e:
                scheme, host, port = target
                crash_logger.warning(
                    "rewrite connect %s://%s:%d failed: %s",
                    scheme, host, port, e,
                )
                await self._write_502(client_writer, "upstream unreachable")
                return

            peer = client_writer.get_extra_info("peername") or ("127.0.0.1", 0)
            client_ip = peer[0] if peer else "127.0.0.1"
            out = self._build_forwarded_request(
                method, path, parts[2], headers, client_ip, target
            )
            target_writer.write(out)
            await target_writer.drain()

            # 双向透传：请求体（client→target）与响应（target→client）。
            # 转发头部里已强制 Connection: close，目标回完响应即关闭，
            # relay 随之收尾并关掉客户端连接；客户端随之关闭自己那端，
            # pump 读到 EOF 退出。
            idle = IdleDeadline(RELAY_IDLE_TIMEOUT)
            await asyncio.gather(
                _pump_request_body(client_reader, target_writer, idle),
                relay(target_reader, client_writer, "direct", "inbound", idle=idle),
            )
        except (asyncio.TimeoutError, ConnectionResetError, BrokenPipeError, OSError):
            pass
        except Exception:
            crash_logger.warning("rewrite handler error", exc_info=True)
        finally:
            if target_writer is not None:
                await _close_writer(target_writer)
            await _close_writer(client_writer)

    async def _connect_target(self, target):
        """直连目标（不经代理节点）；https 目标随后升级 TLS（不校验证书）。"""
        scheme, host, port = target
        reader, writer = await connect_direct(host, port)
        if scheme == "https":
            try:
                await writer.start_tls(
                    _target_ssl_context(), server_hostname=_sni_for(host)
                )
            except Exception:
                await _close_writer(writer)
                raise
        return reader, writer

    @staticmethod
    def _origin_path(request_target):
        """把请求目标归一成 origin-form 路径（含查询串）。

        支持 absolute-form（http://127.0.0.1:996/path，代理客户端风格）
        与 origin-form（/path）。authority-form 仅 CONNECT 使用，已在
        上面拦掉；星号形式（OPTIONS *）原样保留。
        """
        if request_target.startswith("/"):
            return request_target
        if request_target == "*":
            return "*"
        if request_target.startswith("http://"):
            body = request_target[7:]
            slash = body.find("/")
            return body[slash:] if slash != -1 else "/"
        return None

    @staticmethod
    def _build_forwarded_request(
        method, path, version, raw_headers, client_ip, target
    ):
        """拼出转发给目标的请求：改写 Host、强制 Connection: close、
        补 X-Real-IP / X-Forwarded-For / X-Forwarded-Proto。"""
        scheme, host, port = target
        default_port = 443 if scheme == "https" else 80
        host_value = host if port == default_port else f"{host}:{port}"
        # IPv6 字面量放进 Host 头要带方括号
        try:
            if ipaddress.ip_address(host).version == 6:
                host_value = f"[{host}]" if port == default_port else f"[{host}]:{port}"
        except ValueError:
            pass

        out = [f"{method} {path} {version}\r\n".encode()]
        out.append(f"Host: {host_value}\r\n".encode())
        forwarded_for = None
        for header_line in raw_headers:
            try:
                name = header_line.split(b":", 1)[0].strip().lower()
            except Exception:
                continue
            # Host / Connection 由本模块接管；代理专用头不透传
            if name in (b"host", b"connection", b"proxy-connection"):
                continue
            if name == b"x-forwarded-for":
                # 已有则在其后追加客户端地址
                try:
                    value = header_line.split(b":", 1)[1].strip().decode(
                        "utf-8", errors="replace"
                    )
                except Exception:
                    value = ""
                forwarded_for = f"{value}, {client_ip}" if value else client_ip
                continue
            out.append(header_line)
        out.append(b"Connection: close\r\n")
        out.append(f"X-Real-IP: {client_ip}\r\n".encode())
        out.append(
            f"X-Forwarded-For: {forwarded_for or client_ip}\r\n".encode()
        )
        out.append(b"X-Forwarded-Proto: http\r\n")
        out.append(b"\r\n")
        return b"".join(out)

    @staticmethod
    async def _write_502(client_writer, reason):
        body = f"rewrite: {reason}\r\n".encode()
        try:
            client_writer.write(
                b"HTTP/1.1 502 Bad Gateway\r\n"
                b"Content-Type: text/plain; charset=utf-8\r\n"
                b"Content-Length: " + str(len(body)).encode() + b"\r\n"
                b"Connection: close\r\n\r\n" + body
            )
            await client_writer.drain()
        except OSError:
            pass
