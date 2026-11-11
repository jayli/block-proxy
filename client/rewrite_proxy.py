"""重定向（透明反向代理）：本地明文 HTTP 端口 → 外部目标地址。

类似 nginx 的 proxy_pass：客户端请求 http://127.0.0.1:<listen_port>/path，
本模块暗中转发到配置的目标（如 https://abc.com:996/path），改写 Host、
补 X-Real-IP / X-Forwarded-For / X-Forwarded-Proto，https 目标带 SNI 握
TLS 但不校验证书。调用方只看到本地端口的明文 HTTP，察觉不到目标存在。

与 ProxyCore 完全解耦：有自己的线程与事件循环，由 app 层按
config["rewrite"] 独立启停——主代理没有连接时也能单独生效。
目标连接一律直连（不经过代理节点）。

连接模型
--------
客户端侧是真正的 HTTP/1.1 keep-alive：一条连接上顺序处理多个请求。
上游侧**每个请求新建一条连接**并带 `Connection: close`，读完响应后主动
关闭它，绝不复用。

这么设计是因为常见目标（如 litellm adapter）会在 SSE 响应里硬编码
`connection: keep-alive`，收到 `Connection: close` 也不真关连接，却把该
连接标记为待关闭；客户端要是复用那条连接发第二个请求，Node 会回
`400 Bad Request` 空 body（HPE_CLOSED_CONNECTION）。每请求新建上游连接
让这个状态机问题从结构上不可能出现，代价只是一次握手（内网实测
16~21ms，而一次流式响应按秒计）。

响应 framing
------------
按 RFC 9112 的三种方式收尾，读完立刻停在响应边界上：

- `Transfer-Encoding: chunked` —— 原样转发 chunk 帧，读到 0 块（含可选
  trailer）为止；
- `Content-Length: N` —— 原样转发，读满 N 字节为止；
- 两者都无（close-delimited）—— 给客户端**重构成 chunked**，靠上游 EOF
  判定结束。不重构的话客户端等不到明确的结尾，连接也无从复用。

逐跳头（`Connection` 及其点名的 token、`Keep-Alive`、`TE`、`Trailer`、
`Upgrade`、`Proxy-Connection`）一律剥掉，framing 与 `Connection` 由本模块
自己决定。
"""

import asyncio
import ipaddress
import logging
import ssl
import threading
import time

logger = logging.getLogger("rewrite_proxy")

from logger import access_logger, crash_logger
from proxy_core import (
    connect_direct,
    IdleDeadline,
    RELAY_IDLE_TIMEOUT,
    _set_nodelay,
    _close_writer,
)
from traffic_stats import add_bytes

# 请求行 / 头部的读取超时
REQUEST_READ_TIMEOUT = 30
# keep-alive 连接「等下一个请求头」的空闲上限。只管这一段：关闭空闲
# keep-alive 连接是这个协议的常规行为（Node 默认 5s），客户端在还没收到
# 任何响应字节时遇到复用 socket 报错会自动重试。单请求在飞行中的空闲由
# IdleDeadline（RELAY_IDLE_TIMEOUT）负责，LLM 长静默不受影响。
KEEPALIVE_IDLE_TIMEOUT = 120
# 目标建连（含 TLS 握手）超时
TARGET_CONNECT_TIMEOUT = 15
# 单条连接允许的最大头部总量（防恶意/异常客户端灌内存）
MAX_HEADER_BYTES = 64 * 1024
# 逐跳头：只在单条连接内有效，不允许透传
HOP_BY_HOP_HEADERS = frozenset({
    b"connection",
    b"keep-alive",
    b"te",
    b"trailer",
    b"upgrade",
    b"proxy-connection",
})
# 这些状态码按 RFC 9110 一律没有响应体（即使带了 Content-Length 也不能读）
_BODILESS_STATUS = frozenset({204, 304})
# 写缓冲超过这个大小才 drain，避免小帧频繁 await
_DRAIN_THRESHOLD = 65536


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


class _HeadTooLarge(Exception):
    """头部超过 MAX_HEADER_BYTES。"""


class _BadFraming(Exception):
    """HTTP framing 无法解析（非法 chunk 长度、长度对不上等）。"""


async def _read_head(reader, timeout, first_line=None):
    """读一段 header，返回 (start_line, [header_line])。

    start_line 是请求行或状态行；header 行保留原始字节（含结尾 CRLF）。
    first_line 供 keep-alive 分支复用已读到的那行，避免丢字节。
    """
    if first_line is None:
        first_line = await asyncio.wait_for(reader.readline(), timeout=timeout)
    if not first_line:
        return b"", []
    if not first_line.endswith(b"\n"):
        raise _HeadTooLarge("start line without terminator")
    total = len(first_line)
    headers = []
    while True:
        line = await asyncio.wait_for(reader.readline(), timeout=timeout)
        if line in (b"\r\n", b"\n", b""):
            break
        total += len(line)
        if total > MAX_HEADER_BYTES:
            raise _HeadTooLarge(f"head exceeds {MAX_HEADER_BYTES} bytes")
        headers.append(line)
    return first_line, headers


def _header_value(headers, name):
    """取某个头的值（不区分大小写，取第一个）。name 为 bytes 小写。"""
    for line in headers:
        try:
            key, value = line.split(b":", 1)
        except ValueError:
            continue
        if key.strip().lower() == name:
            return value.strip()
    return None


def _has_token(headers, name, token):
    """某头是否包含指定 token（`Connection: keep-alive, Upgrade` 这类）。"""
    value = _header_value(headers, name)
    if not value:
        return False
    wanted = token.lower()
    return any(
        part.strip().lower() == wanted for part in value.split(b",")
    )


def _parse_content_length(headers):
    """返回 Content-Length（int）或 None；非法值抛 _BadFraming。"""
    value = _header_value(headers, b"content-length")
    if value is None:
        return None
    try:
        length = int(value.strip())
    except ValueError:
        raise _BadFraming(f"invalid Content-Length: {value!r}")
    if length < 0:
        raise _BadFraming(f"negative Content-Length: {value!r}")
    return length


def _is_chunked(headers):
    value = _header_value(headers, b"transfer-encoding")
    if not value:
        return False
    try:
        return value.split(b",")[-1].strip().lower() == b"chunked"
    except (AttributeError, IndexError):  # pragma: no cover - 防御
        return False


async def _maybe_drain(writer):
    """写缓冲超过阈值才 drain，避免小帧频繁 await。"""
    if writer is not None and \
            writer.transport.get_write_buffer_size() > _DRAIN_THRESHOLD:
        await writer.drain()


async def _relay_chunked(reader, writer, idle, direction="outbound", sink=False):
    """转发 chunked body，读到 0 块（含可选 trailer）为止，原样透传。

    sink=True 时只消费不写入（客户端请求体已无处可去，但仍必须读干净，
    否则残留字节会被当成下一个请求）。
    """
    while True:
        size_line = await asyncio.wait_for(
            reader.readline(), timeout=idle.remaining()
        )
        if not size_line:
            raise _BadFraming("chunked stream ended before terminal chunk")
        idle.touch()
        size_text = size_line.split(b";")[0].strip()
        try:
            size = int(size_text, 16)
        except ValueError:
            raise _BadFraming(f"invalid chunk size: {size_line!r}")
        if not sink:
            writer.write(size_line)
            add_bytes(len(size_line), "direct", direction)
        if size == 0:
            # 末尾块：可选 trailer 行，直到空行为止
            while True:
                trailer = await asyncio.wait_for(
                    reader.readline(), timeout=idle.remaining()
                )
                if not trailer:
                    raise _BadFraming("chunked stream ended inside trailer")
                idle.touch()
                if not sink:
                    writer.write(trailer)
                    add_bytes(len(trailer), "direct", direction)
                if trailer in (b"\r\n", b"\n"):
                    break
            if not sink:
                await _maybe_drain(writer)
            return
        remaining = size
        while remaining > 0:
            chunk = await asyncio.wait_for(
                reader.read(min(remaining, _DRAIN_THRESHOLD)),
                timeout=idle.remaining(),
            )
            if not chunk:
                raise _BadFraming("chunked stream ended mid-chunk")
            idle.touch()
            remaining -= len(chunk)
            if not sink:
                writer.write(chunk)
                add_bytes(len(chunk), "direct", direction)
                await _maybe_drain(writer)
        crlf = await asyncio.wait_for(
            reader.readline(), timeout=idle.remaining()
        )
        if not crlf:
            raise _BadFraming("chunked stream ended before chunk CRLF")
        idle.touch()
        if not sink:
            writer.write(crlf)
            add_bytes(len(crlf), "direct", direction)


async def _relay_sized(reader, writer, length, idle, direction="outbound",
                       sink=False):
    """转发固定长度 body，读满 length 字节为止。"""
    remaining = length
    while remaining > 0:
        chunk = await asyncio.wait_for(
            reader.read(min(remaining, _DRAIN_THRESHOLD)),
            timeout=idle.remaining(),
        )
        if not chunk:
            raise _BadFraming(
                f"body ended {remaining} bytes before Content-Length"
            )
        idle.touch()
        remaining -= len(chunk)
        if not sink:
            writer.write(chunk)
            add_bytes(len(chunk), "direct", direction)
            await _maybe_drain(writer)


async def _relay_until_eof_as_chunked(reader, writer, idle):
    """close-delimited 上游 → 重构成 chunked 发给客户端。

    上游没有 framing 头时唯一的结束信号就是 EOF；直接裸转发客户端会等不到
    结尾，连接也无法复用。这里自己编 chunk 帧，最后补终止块。
    """
    while True:
        try:
            chunk = await asyncio.wait_for(
                reader.read(_DRAIN_THRESHOLD), timeout=idle.remaining()
            )
        except asyncio.IncompleteReadError as e:  # pragma: no cover - 防御
            chunk = e.partial
        if not chunk:
            break
        idle.touch()
        writer.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
        add_bytes(len(chunk), "direct", "inbound")
        await _maybe_drain(writer)
    writer.write(b"0\r\n\r\n")
    add_bytes(5, "direct", "inbound")


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
        """一条客户端连接上顺序处理请求（keep-alive）。"""
        _set_nodelay(client_writer)
        # 快照目标：stop() 会把 self._target 置 None，而本协程可能还在飞行中
        target = self._target
        if target is None:
            await _close_writer(client_writer)
            return
        try:
            while True:
                first = await self._read_first_line(client_reader)
                if first is None:
                    return
                if not await self._serve_one(
                    client_reader, client_writer, first, target
                ):
                    return
        except (asyncio.TimeoutError, ConnectionResetError, BrokenPipeError, OSError):
            pass
        except Exception:
            crash_logger.warning("rewrite handler error", exc_info=True)
        finally:
            await _close_writer(client_writer)

    async def _read_first_line(self, client_reader):
        """等下一个请求行；超时 / EOF / 空闲上限都返回 None。"""
        try:
            return await asyncio.wait_for(
                client_reader.readline(), timeout=KEEPALIVE_IDLE_TIMEOUT
            )
        except asyncio.TimeoutError:
            return None

    async def _serve_one(self, client_reader, client_writer, request_line, target):
        """处理一个请求，返回是否继续在同一条客户端连接上处理下一个。"""
        started_at = time.monotonic()
        method = "-"
        path = "-"
        status_text = "-"
        outcome = "ok"
        client_wants_close = False
        target_writer = None
        body_task = None
        idle = None
        request_framing = ("none", None)
        try:
            line = request_line.decode("utf-8", errors="replace").strip()
            parts = line.split()
            if len(parts) < 3:
                outcome = "bad-request-line"
                return False
            method, request_target = parts[0].upper(), parts[1]
            version = parts[2] or "HTTP/1.1"
            path = request_target
            if method == "CONNECT":
                status_text = "502"
                outcome = "connect-not-supported"
                await self._write_502(client_writer, "CONNECT not supported")
                return False

            try:
                _start, headers = await _read_head(
                    client_reader, REQUEST_READ_TIMEOUT, first_line=request_line
                )
            except _HeadTooLarge as e:
                crash_logger.warning("rewrite request head too large: %s", e)
                outcome = "headers-too-large"
                return False

            # 协议升级（WebSocket 等）不在透明反代的语义里：明确拒绝，
            # 而不是把连接挂在那里
            if _header_value(headers, b"upgrade") is not None:
                status_text = "502"
                outcome = "upgrade-not-supported"
                await self._write_502(
                    client_writer, "protocol upgrade not supported"
                )
                return False
            path = self._origin_path(request_target)
            if path is None:
                status_text = "502"
                outcome = "bad-request-target"
                await self._write_502(client_writer, "bad request target")
                return False

            client_wants_close = (
                _has_token(headers, b"connection", b"close")
                or (version.upper() == "HTTP/1.0"
                    and not _has_token(headers, b"connection", b"keep-alive"))
            )

            try:
                request_framing = self._request_body_framing(headers)
            except _BadFraming as e:
                status_text = "502"
                outcome = "bad-request-framing"
                crash_logger.warning("rewrite bad request framing: %s", e)
                await self._write_502(client_writer, "bad request framing")
                return False

            try:
                target_reader, target_writer = await asyncio.wait_for(
                    self._connect_target(target), timeout=TARGET_CONNECT_TIMEOUT
                )
            except Exception as e:
                scheme, host, port = target
                status_text = "502"
                outcome = "upstream-unreachable"
                crash_logger.warning(
                    "rewrite connect %s://%s:%d failed: %s",
                    scheme, host, port, e,
                )
                await self._write_502(client_writer, "upstream unreachable")
                # 502 已经声明 Connection: close，就真的关掉
                return False

            peer = client_writer.get_extra_info("peername") or ("127.0.0.1", 0)
            client_ip = peer[0] if peer else "127.0.0.1"
            out = self._build_forwarded_request(
                method, path, version, headers, client_ip, target
            )
            idle = IdleDeadline(RELAY_IDLE_TIMEOUT)
            target_writer.write(out)
            add_bytes(len(out), "direct", "outbound")
            await target_writer.drain()

            # 请求体边读边推给上游（不 task：上游可能已回响应并关了写端，
            # 此时写会失败而客户端仍在发体——必须把客户端字节读干净，否则
            # 残留字节会被	当成下一个请求）。
            if request_framing[0] != "none":
                await self._forward_request_body(
                    client_reader, target_writer, request_framing, idle
                )

            status, resp_headers, resp_framing = await self._read_response_head(
                target_reader, idle
            )
            status_code = self._status_code(status)
            if method == "HEAD" or status_code in _BODILESS_STATUS:
                resp_framing = ("none", None)
            status_text = self._status_text(status)

            connection_value = b"close" if client_wants_close else b"keep-alive"
            head = self._build_client_response_head(
                status, resp_headers, resp_framing, connection_value
            )
            client_writer.write(head)
            add_bytes(len(head), "direct", "inbound")
            await self._relay_response_body(
                target_reader, client_writer, resp_framing, idle
            )
            await client_writer.drain()
            return not client_wants_close
        except _BadFraming as e:
            outcome = "bad-framing"
            crash_logger.warning("rewrite framing error: %s", e)
            if not client_writer.transport.is_closing() and status_text == "-":
                status_text = "502"
                await self._write_502(client_writer, "bad framing")
            return False
        except (asyncio.TimeoutError, ConnectionResetError, BrokenPipeError, OSError):
            outcome = "io-error"
            return False
        finally:
            if target_writer is not None:
                await _close_writer(target_writer)
            elapsed_ms = int((time.monotonic() - started_at) * 1000)
            access_logger.info(
                self._access_line(
                    method, path, status_text, target, elapsed_ms,
                    outcome if outcome != "ok"
                    else ("close" if client_wants_close else "keepalive"),
                )
            )

    async def _forward_request_body(self, client_reader, target_writer,
                                    framing, idle):
        """把客户端请求体推给上游，并保证客户端侧被读干净。

        上游可能已提前回应并关掉写端（如 401），此时写会失败；无论写成功
        与否都必须把客户端请求体读完整，否则这些字节会被当成下一个请求
        的开头，导致请求错位。
        """
        kind, value = framing
        try:
            if kind == "chunked":
                await _relay_chunked(client_reader, target_writer, idle)
            else:
                await _relay_sized(
                    client_reader, target_writer, value, idle
                )
        except (ConnectionResetError, BrokenPipeError, OSError):
            # 上游写端没了：改为只消费不发，保证客户端连接同步
            if kind == "chunked":
                await _relay_chunked(client_reader, None, idle, sink=True)
            else:
                await _relay_sized(
                    client_reader, None, value, idle, sink=True
                )

    @staticmethod
    def _request_body_framing(headers):
        """请求体描述：(kind, value)，kind 为 "none" / "length" / "chunked"。"""
        if _is_chunked(headers):
            return ("chunked", None)
        length = _parse_content_length(headers)
        if length:
            return ("length", length)
        return ("none", None)

    async def _read_response_head(self, target_reader, idle):
        """读上游响应头，返回 (status_line, headers, framing)。

        1xx 中间响应（100 Continue 等）直接丢弃后继续等最终响应：客户端
        的请求体已经发完了，再补发一个 100 只有害无益。
        """
        while True:
            status, headers = await _read_head(
                target_reader, timeout=idle.remaining()
            )
            if not status:
                raise _BadFraming("upstream closed before response")
            idle.touch()
            code = self._status_code(status)
            if code is not None and 100 <= code < 200:
                continue
            break
        if _is_chunked(headers):
            return status, headers, ("chunked", None)
        length = _parse_content_length(headers)
        if length is not None:
            return status, headers, ("length", length)
        return status, headers, ("close", None)

    async def _relay_response_body(self, target_reader, client_writer,
                                   framing, idle):
        """转发响应体，读到 framing 说明的边界为止。"""
        kind, value = framing
        if kind == "none":
            return
        if kind == "chunked":
            await _relay_chunked(
                target_reader, client_writer, idle, direction="inbound"
            )
            return
        if kind == "length":
            await _relay_sized(
                target_reader, client_writer, value, idle, direction="inbound"
            )
            return
        await _relay_until_eof_as_chunked(target_reader, client_writer, idle)

    @staticmethod
    def _status_code(status_line):
        parts = status_line.split()
        if len(parts) >= 2:
            try:
                return int(parts[1])
            except ValueError:
                return None
        return None

    @staticmethod
    def _status_text(status_line):
        text = status_line.decode("utf-8", "replace").strip()
        parts = text.split(" ", 2)
        return parts[1] if len(parts) >= 2 else text

    def _build_client_response_head(self, status, headers, framing,
                                    connection_value):
        """拼发给客户端的响应头：剥逐跳头 + 自己定 framing 与 Connection。"""
        kind, value = framing
        out = [status]
        for line in headers:
            try:
                name = line.split(b":", 1)[0].strip().lower()
            except Exception:
                continue
            if name in HOP_BY_HOP_HEADERS:
                continue
            if name == b"transfer-encoding":
                continue
            if name == b"content-length":
                # 无体的响应（HEAD / 204 / 304）保留 Content-Length 的元信息，
                # 其余情形由下面按 framing 重写
                if kind == "none":
                    out.append(line)
                continue
            out.append(line)
        if kind == "length":
            out.append(b"Content-Length: " + str(value).encode() + b"\r\n")
        elif kind in ("chunked", "close"):
            # close-delimited 上游要被重构成 chunked
            out.append(b"Transfer-Encoding: chunked\r\n")
        out.append(b"Connection: " + connection_value + b"\r\n")
        out.append(b"\r\n")
        return b"".join(out)

    @staticmethod
    def _access_line(method, path, status, target, elapsed_ms, note):
        scheme, host, port = target
        return (
            f"REWRITE | {method} {path} | {status} | "
            f"{scheme}://{host}:{int(port)} | {elapsed_ms}ms | {note}"
        )

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
