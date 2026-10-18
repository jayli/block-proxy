"""HTTP/2 CONNECT 复用（8002 公网代理端口）。

一条 TLS 连接（ALPN 协商出 h2）上并发承载多条 CONNECT 隧道，省掉每条
本地连接都要重新做的 TLS 握手。服务端没协商到 h2（老版本）时
`H2UpstreamPool.connect()` 返回 None，由调用方降级回现有 HTTP/1.1 路径。

对上层暴露的形状与 `asyncio.StreamReader/StreamWriter` 对齐，可以直接喂给
`proxy_core.relay()`：reader 按消费量回 WINDOW_UPDATE（慢消费者形成背压），
writer 暴露 relay 与 `_force_close_rst()` 会碰到的 transport 成员，
但 `abort()` 只重置本流，绝不 abort 共享的 TLS 连接。
"""

import asyncio
import base64
import logging

logger = logging.getLogger("proxy_core")

try:
    import h2.config
    import h2.connection
    import h2.events
    import h2.settings

    H2_AVAILABLE = True
except ImportError:  # 老环境未安装 h2：不启用 h2，行为与之前完全一致
    H2_AVAILABLE = False

from node_connect import open_node_connection

CONNECT_TIMEOUT = 10
HANDSHAKE_TIMEOUT = 10
# 会话数与单会话软上限：2 条连接分摊 TCP 层 HOL 阻塞，正常浏览只会用到 1 条
MAX_SESSIONS = 2
STREAMS_PER_SESSION = 50
# 接收窗口：大文件下载时不必等往返窗口更新；上限是每流一个窗口的积压
RECV_WINDOW = 262144
PING_INTERVAL = 60
PING_TIMEOUT = 10
IDLE_SESSION_CLOSE = 600


def _set_nodelay(writer):
    try:
        sock = writer.transport.get_extra_info("socket")
        if sock:
            sock.setsockopt(6, 1, 1)  # socket.IPPROTO_TCP / TCP_NODELAY
    except (OSError, AttributeError):
        pass


def _write_now(writer, data):
    if not data:
        return
    try:
        writer.write(data)
    except (OSError, RuntimeError):
        pass


class H2StreamReader:
    """h2 流 → reader 形状：只在数据被消费时回窗口，天然背压。"""

    def __init__(self, stream_id):
        self.stream_id = stream_id
        self._buffer = bytearray()
        self._eof = False
        self._exception = None
        self._waiter = None
        self._session = None

    def bind(self, session):
        self._session = session

    async def read(self, n=-1):
        while True:
            if self._buffer:
                if n is None or n < 0:
                    data = bytes(self._buffer)
                    self._buffer.clear()
                elif n == 0:
                    return b""
                else:
                    data = bytes(self._buffer[:n])
                    del self._buffer[:n]
                if self._session is not None:
                    self._session.ack_consumed(self.stream_id, len(data))
                return data
            if self._exception is not None:
                exc, self._exception = self._exception, None
                raise exc
            if self._eof:
                return b""
            if self._waiter is None:
                self._waiter = asyncio.get_event_loop().create_future()
            await self._waiter

    def at_eof(self):
        return self._eof and not self._buffer

    def feed(self, data):
        if self._eof or not data:
            return
        self._buffer.extend(data)
        self._wake()

    def feed_eof(self):
        self._eof = True
        self._wake()

    def set_exception(self, exc):
        if self._exception is None:
            self._exception = exc
        self._wake()

    def _wake(self):
        waiter = self._waiter
        self._waiter = None
        if waiter is not None and not waiter.done():
            waiter.set_result(None)


class H2StreamTransport:
    """`writer.transport` 垫片：故意不暴露 socket，避免影响共享连接。"""

    def __init__(self, writer):
        self._writer = writer

    def get_extra_info(self, name, default=None):
        return default

    def get_write_buffer_size(self):
        return len(self._writer.pending)

    def abort(self):
        self._writer.abort()

    def is_closing(self):
        return self._writer.is_closing()


class H2StreamWriter:
    """h2 流 → writer 形状（write/drain/write_eof/close/wait_closed）。"""

    def __init__(self, session, stream_id):
        self._session = session
        self.stream_id = stream_id
        self.pending = bytearray()
        self.transport = H2StreamTransport(self)
        self._closed = False
        self._eof_sent = False
        self._eof_pending = False
        self._window = asyncio.Event()
        self._closed_future = asyncio.get_event_loop().create_future()

    def write(self, data):
        if self._closed or self._eof_pending or not data:
            return
        self.pending.extend(data)
        self._flush()

    async def drain(self):
        while not self._closed:
            self._flush()
            if not self.pending:
                await self._session.drain_transport()
                return
            self._window.clear()
            # 清事件后再试一次：窗口更新可能恰好落在 clear 之前
            self._flush()
            if not self.pending or self._closed:
                if not self._closed:
                    await self._session.drain_transport()
                return
            await self._window.wait()

    def write_eof(self):
        if self._closed or self._eof_pending or self._eof_sent:
            return
        self._eof_pending = True
        self._flush()

    def close(self):
        if self._closed:
            return
        self._session.abort_stream(self.stream_id)
        self.mark_closed()

    async def wait_closed(self):
        await self._closed_future

    def is_closing(self):
        return self._closed or self._eof_pending

    def can_write_eof(self):
        return True

    def abort(self):
        # relay 的空闲超时 / 错误路径：只 RST 本流
        self.close()

    def notify_window(self):
        self._window.set()
        self._flush()

    def mark_closed(self):
        if self._closed:
            return
        self._closed = True
        self.pending.clear()
        self._window.set()
        if not self._closed_future.done():
            self._closed_future.set_result(None)

    def _flush(self):
        if self._closed:
            return
        conn = getattr(self._session, "conn", None)
        if conn is None:
            return
        while self.pending and not self._closed:
            try:
                window = conn.local_flow_control_window(self.stream_id)
            except Exception:
                self.mark_closed()
                return
            size = min(window, conn.max_outbound_frame_size, len(self.pending))
            if size <= 0:
                return
            chunk = bytes(self.pending[:size])
            del self.pending[:size]
            try:
                conn.send_data(self.stream_id, chunk)
            except Exception:
                self.mark_closed()
                return
            self._session.send_pending()
        if not self.pending:
            self._window.set()
            if self._eof_pending and not self._eof_sent:
                self._eof_sent = True
                try:
                    conn.end_stream(self.stream_id)
                except Exception:
                    pass
                self._session.send_pending()
                self._session.on_local_eof(self.stream_id)


class _Stream:
    __slots__ = ("reader", "writer", "ready", "local_ended", "remote_ended")

    def __init__(self, reader, writer, ready):
        self.reader = reader
        self.writer = writer
        self.ready = ready
        self.local_ended = False
        self.remote_ended = False


class _H2Session:
    """一条 TLS+h2 连接：pump、流表、PING 保活与 GOAWAY 处理。"""

    def __init__(self, pool, reader, writer, conn, ping_interval, idle_close):
        self._pool = pool
        self._reader = reader
        self._writer = writer
        self.conn = conn
        self._ping_interval = ping_interval
        self._idle_close = idle_close
        self._streams = {}
        self._closed = False
        self._draining = False
        self._pump_task = None
        self._keepalive_task = None
        self._ping_waiter = None
        # 只有业务流才算「有活动」：PING 自己的流量不能续命空闲计时
        self._last_stream_at = asyncio.get_event_loop().time()

    @property
    def closed(self):
        return self._closed

    @property
    def draining(self):
        return self._draining

    @property
    def active_streams(self):
        return len(self._streams)

    def start(self):
        self.send_pending()
        self._pump_task = asyncio.ensure_future(self._pump())
        self._keepalive_task = asyncio.ensure_future(self._keepalive())

    async def close(self):
        if self._closed:
            return
        try:
            self.conn.close_connection()
            self.send_pending()
        except Exception:
            pass
        self._on_lost()

    # ── 上层接口 ────────────────────────────────────────────

    async def open_tunnel(self, host, port):
        if self._closed or self._draining:
            raise ConnectionError("HTTP/2 session not available")
        authority = f"{host}:{port}"
        stream_id = self.conn.get_next_available_stream_id()
        reader = H2StreamReader(stream_id)
        reader.bind(self)
        writer = H2StreamWriter(self, stream_id)
        ready = asyncio.get_event_loop().create_future()
        self._streams[stream_id] = _Stream(reader, writer, ready)

        self._last_stream_at = asyncio.get_event_loop().time()
        headers = [
            (b":method", b"CONNECT"),
            (b":authority", authority.encode("utf-8")),
        ]
        authorization = self._pool.authorization_header()
        if authorization:
            headers.append((b"proxy-authorization", authorization.encode("utf-8")))
        try:
            # CONNECT 不能带 :scheme / :path（RFC 9113 §8.5），带上会被
            # nghttp2 以 PROTOCOL_ERROR 重置，所以 hyper-h2 的出站校验要关掉。
            self.conn.send_headers(stream_id, headers, end_stream=False)
            self.send_pending()
        except Exception:
            self._forget(stream_id)
            raise

        try:
            status = await asyncio.wait_for(ready, HANDSHAKE_TIMEOUT)
        except asyncio.TimeoutError:
            self._reset_stream(stream_id)
            self._forget(stream_id)
            raise
        if status != 200:
            self._forget(stream_id)
            self._reset_stream(stream_id)
            reader.feed_eof()
            raise Exception(f"HTTP proxy CONNECT failed: {status}")
        return reader, writer

    async def drain_transport(self):
        """等共享 TLS 连接的写缓冲排空：h2 流级背压最终要落到这一层。"""
        if self._closed:
            return
        try:
            await self._writer.drain()
        except (OSError, RuntimeError):
            pass

    def send_pending(self):
        try:
            data = self.conn.data_to_send()
        except Exception:
            return
        _write_now(self._writer, data)

    def ack_consumed(self, stream_id, length):
        if self._closed or length <= 0:
            return
        try:
            self.conn.acknowledge_received_data(length, stream_id)
        except Exception:
            return
        self.send_pending()

    def abort_stream(self, stream_id):
        self._reset_stream(stream_id)
        self._forget(stream_id)

    def on_local_eof(self, stream_id):
        stream = self._streams.get(stream_id)
        if stream is None:
            return
        stream.local_ended = True
        if stream.remote_ended:
            self._forget(stream_id)

    # ── 内部 ────────────────────────────────────────────────

    async def _pump(self):
        try:
            while True:
                data = await self._reader.read(65536)
                if not data:
                    break
                events = self.conn.receive_data(data)
                self.send_pending()
                for event in events:
                    self._handle_event(event)
                    self.send_pending()
                if self._writer.transport.get_write_buffer_size() > 65536:
                    await self._writer.drain()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.debug("h2 session reader ended: %s", exc)
        finally:
            self._on_lost()

    def _handle_event(self, event):
        if isinstance(event, h2.events.ResponseReceived):
            stream = self._streams.get(event.stream_id)
            if stream is None or stream.ready.done():
                return
            headers = dict(event.headers)
            status = headers.get(":status", headers.get(b":status"))
            try:
                stream.ready.set_result(int(status))
            except (TypeError, ValueError):
                stream.ready.set_result(None)
        elif isinstance(event, h2.events.DataReceived):
            stream = self._streams.get(event.stream_id)
            if stream is None:
                return
            padding = event.flow_controlled_length - len(event.data)
            if padding > 0:
                try:
                    self.conn.acknowledge_received_data(padding, event.stream_id)
                except Exception:
                    pass
            stream.reader.feed(event.data)
        elif isinstance(event, h2.events.StreamEnded):
            stream = self._streams.get(event.stream_id)
            if stream is None:
                return
            stream.remote_ended = True
            stream.reader.feed_eof()
            if stream.local_ended:
                self._forget(event.stream_id)
        elif isinstance(event, h2.events.StreamReset):
            stream = self._streams.get(event.stream_id)
            if stream is None:
                return
            if not stream.ready.done():
                stream.ready.set_exception(ConnectionResetError(
                    f"HTTP/2 stream reset before response ({event.error_code})"
                ))
            stream.reader.feed_eof()
            stream.writer.mark_closed()
            self._forget(event.stream_id)
        elif isinstance(event, h2.events.WindowUpdated):
            if event.stream_id == 0:
                # 连接级窗口（stream 0）：唤醒所有等窗口的流
                for stream in list(self._streams.values()):
                    stream.writer.notify_window()
            else:
                stream = self._streams.get(event.stream_id)
                if stream is not None:
                    stream.writer.notify_window()
        elif isinstance(event, h2.events.PingAckReceived):
            waiter = self._ping_waiter
            if waiter is not None and not waiter.done():
                waiter.set_result(True)
        elif isinstance(event, h2.events.ConnectionTerminated):
            logger.debug("h2 session GOAWAY error_code=%s", event.error_code)
            self._draining = True
            self._on_lost()
        elif isinstance(event, h2.events.RemoteSettingsChanged):
            if self.conn.remote_settings.max_concurrent_streams is not None:
                pass

    async def _keepalive(self):
        try:
            while not self._closed:
                await asyncio.sleep(self._ping_interval)
                if self._closed:
                    return
                if self._streams:
                    continue
                if asyncio.get_event_loop().time() - self._last_stream_at >= self._idle_close:
                    await self.close()
                    return
                if not await self._ping():
                    self._on_lost()
                    return
        except asyncio.CancelledError:
            raise
        except Exception:
            self._on_lost()

    async def _ping(self):
        waiter = asyncio.get_event_loop().create_future()
        self._ping_waiter = waiter
        try:
            self.conn.ping(b"\x00" * 8)
            self.send_pending()
        except Exception:
            return False
        try:
            return bool(await asyncio.wait_for(waiter, PING_TIMEOUT))
        except asyncio.TimeoutError:
            return False
        finally:
            self._ping_waiter = None

    def _reset_stream(self, stream_id):
        if self._closed:
            return
        try:
            if stream_id in self.conn.streams:
                self.conn.reset_stream(stream_id)
                self.send_pending()
        except Exception:
            pass

    def _forget(self, stream_id):
        stream = self._streams.pop(stream_id, None)
        if stream is None:
            return
        stream.reader.feed_eof()
        stream.writer.mark_closed()

    def _on_lost(self):
        if self._closed:
            return
        self._closed = True
        for stream_id in list(self._streams):
            stream = self._streams.pop(stream_id)
            if not stream.ready.done():
                stream.ready.set_exception(ConnectionError("HTTP/2 session closed"))
            stream.reader.set_exception(ConnectionError("HTTP/2 session closed"))
            stream.writer.mark_closed()
        waiter = self._ping_waiter
        if waiter is not None and not waiter.done():
            waiter.set_result(False)
        self._pool._discard(self)
        try:
            self._writer.close()
        except Exception:
            pass
        current = asyncio.current_task()
        if self._pump_task is not None and self._pump_task is not current:
            self._pump_task.cancel()
        if self._keepalive_task is not None and self._keepalive_task is not current:
            self._keepalive_task.cancel()


class H2UpstreamPool:
    """按负载选会话的 h2 复用池；不支持 h2 时置 `disabled` 并返回 None。"""

    def __init__(self, server_config, ssl_ctx, verify_cert_pin=None, logger=None,
                 max_sessions=MAX_SESSIONS, streams_per_session=STREAMS_PER_SESSION,
                 ping_interval=PING_INTERVAL, idle_close=IDLE_SESSION_CLOSE):
        self._server_config = server_config
        self._ssl_ctx = ssl_ctx
        self._verify_cert_pin = verify_cert_pin
        self._logger = logger or globals()["logger"]
        self._max_sessions = max(1, int(max_sessions))
        self._streams_per_session = max(1, int(streams_per_session))
        self._ping_interval = max(0.05, float(ping_interval))
        self._idle_close = max(0.05, float(idle_close))
        self._sessions = []
        self._lock = asyncio.Lock()
        self._task = None
        self._running = False
        self._disabled = False
        self._downgrade_reported = False
        self._h2_reported = False

    @property
    def disabled(self):
        return self._disabled or not H2_AVAILABLE

    def authorization_header(self):
        username = self._server_config.get("username") or ""
        password = self._server_config.get("password") or ""
        if not username or not password:
            return None
        token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
        return f"Basic {token}"

    async def start(self):
        if self._running:
            return
        self._running = True
        # 只预热一次：空闲被 keepalive 关掉后不再自动重连（用时 connect() 再建），
        # 否则空闲客户端会每 10 分钟重建一次 TLS。
        self._task = asyncio.ensure_future(self._preconnect())

    async def stop(self):
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        sessions, self._sessions = self._sessions, []
        for session in sessions:
            await session.close()

    async def connect(self, host, port):
        if self.disabled:
            return None
        session = await self._pick_session()
        if session is None:
            return None
        try:
            return await session.open_tunnel(host, port)
        except ConnectionError:
            # 会话刚好失效（连接死在握手途中）：换一个新会话重试一次
            if self.disabled:
                return None
            async with self._lock:
                replacement = await self._create_session_locked()
            if replacement is None:
                return None
            return await replacement.open_tunnel(host, port)

    async def _preconnect(self):
        try:
            async with self._lock:
                if not any(not s.closed and not s.draining for s in self._sessions):
                    await self._create_session_locked()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._logger.debug("h2 session preconnect failed: %s", exc)

    async def _pick_session(self):
        async with self._lock:
            usable = [s for s in self._sessions if not s.closed and not s.draining]
            if usable:
                usable.sort(key=lambda s: s.active_streams)
                best = usable[0]
                if best.active_streams < self._streams_per_session or len(usable) >= self._max_sessions:
                    return best
                return await self._create_session_locked() or best
            return await self._create_session_locked()

    async def _create_session_locked(self):
        if self.disabled or not H2_AVAILABLE:
            return None
        reader, writer = await open_node_connection(
            self._server_config,
            use_tls=True,
            ssl_ctx=self._ssl_ctx,
            timeout=CONNECT_TIMEOUT,
        )
        try:
            ssl_object = writer.get_extra_info("ssl_object")
            alpn = ssl_object.selected_alpn_protocol() if ssl_object is not None else None
            if alpn != "h2":
                writer.close()
                self._disabled = True
                if not self._downgrade_reported:
                    self._downgrade_reported = True
                    self._logger.info("服务端未协商 h2，回退 HTTP/1.1")
                return None
            if self._verify_cert_pin is not None:
                self._verify_cert_pin(ssl_object)
        except BaseException:
            try:
                writer.close()
            except Exception:
                pass
            raise

        _set_nodelay(writer)
        conn = h2.connection.H2Connection(config=h2.config.H2Configuration(
            client_side=True,
            header_encoding="utf-8",
            validate_outbound_headers=False,
        ))
        conn.initiate_connection()
        conn.update_settings({
            h2.settings.SettingCodes.INITIAL_WINDOW_SIZE: RECV_WINDOW,
            h2.settings.SettingCodes.ENABLE_PUSH: 0,
        })
        # SETTINGS 只抬高每流窗口；连接级窗口默认 65535，不抬高的话所有流
        # 共享 64KB/RTT（高延迟下比 HTTP/1.1 还慢，且一条流被暂停会卡住全会话）。
        conn.increment_flow_control_window(RECV_WINDOW)
        session = _H2Session(
            self, reader, writer, conn,
            ping_interval=self._ping_interval,
            idle_close=self._idle_close,
        )
        session.start()
        self._sessions.append(session)
        if not self._h2_reported:
            self._h2_reported = True
            self._logger.info("HTTP/2 复用已启用（ALPN h2）")
        return session

    def _discard(self, session):
        try:
            self._sessions.remove(session)
        except ValueError:
            pass
