import asyncio
import functools
import hashlib
import ipaddress
import logging
import os
import socket
import ssl
import struct
import threading
import time

logger = logging.getLogger("proxy_core")

from logger import access_logger, crash_logger
from doh_resolver import resolve_node_address
from traffic_stats import add_bytes, flush as flush_stats, init_writer


class AuthFailedError(Exception):
    """鉴权失败"""
    pass


class NodeUnreachableError(Exception):
    """节点不可达"""
    pass


class CertPinMismatchError(Exception):
    def __init__(self, saved_pin, new_pin):
        super().__init__("certificate pin mismatch")
        self.saved_pin = saved_pin
        self.new_pin = new_pin


class CertPinUnavailableError(Exception):
    pass


def _log_access(dest_addr, dest_port, method, direct, error=None):
    route = "direct" if direct else "proxy"
    if error:
        access_logger.info(f"{method} | {dest_addr}:{dest_port} | {route} | {error}")
    else:
        access_logger.info(f"{method} | {dest_addr}:{dest_port} | {route}")


PRIVATE_NETWORKS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]


@functools.lru_cache(maxsize=256)
def is_private_ip(host):
    try:
        addr = ipaddress.ip_address(host)
        return any(addr in net for net in PRIVATE_NETWORKS)
    except ValueError:
        return False


RELAY_IDLE_TIMEOUT = 300
UDP_IDLE_TIMEOUT = 120
LOCAL_PROXY_RECYCLE_INTERVAL = 7200
LOCAL_PROXY_RECYCLE_IDLE_SECONDS = 20
LOCAL_PROXY_RECYCLE_DEFER_SECONDS = 300
# 本地代理 fd 残留阈值：超过即认为探测/异常连接堆积（CLOSED fd、
# FIN_WAIT_2 等），唤醒后或定时回收时主动重启本地代理清空。
# 正常运行时 fd 约 50~150；DoH 探测风暴下可堆积到 300+。
LOCAL_PROXY_FD_RECYCLE_THRESHOLD = 250
# server 关闭后 wait_closed() 的最长等待：EDR 探测连接会持续注入新
# 连接，wait_closed() 要等所有活跃 handler 完成，探测风暴下永不返回，
# 使 recycle/stop 卡死在"已关闭未重建"的中间态（Connection refused）。
# 端口释放只依赖 close()（同步关闭 listen socket），超时后直接丢弃
# server 对象，连接由各自 handler 自行收尾。
LOCAL_PROXY_STOP_WAIT_TIMEOUT = 3.0
# recycle 整体（断开活跃连接 + 重建 listener）的最长时限，超时则协程
# 自毁（内部 wait_for），杜绝僵尸协程在旧事件循环上继续操作 server
# 引用（跨 loop RuntimeError / EADDRINUSE 端口漂移）。
LOCAL_PROXY_RECYCLE_TIMEOUT = 15


def _set_nodelay(writer):
    try:
        sock = writer.transport.get_extra_info("socket")
        if sock:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except (OSError, AttributeError):
        pass


async def write_udp_frame(writer, data):
    frame = struct.pack("!H", len(data)) + data
    writer.write(frame)
    await writer.drain()


async def read_udp_frame(reader):
    length_data = await reader.readexactly(2)
    length = struct.unpack("!H", length_data)[0]
    if length == 0 or length > 65535:
        raise Exception("invalid UDP frame length")
    return await reader.readexactly(length)


async def relay(reader, writer, route=None, direction=None, on_activity=None):
    try:
        while True:
            data = await asyncio.wait_for(reader.read(65536), timeout=RELAY_IDLE_TIMEOUT)
            if not data:
                break
            writer.write(data)
            if on_activity:
                on_activity()
            if route and direction:
                add_bytes(len(data), route, direction)
            if writer.transport.get_write_buffer_size() > 65536:
                await writer.drain()
    except asyncio.TimeoutError:
        pass
    except (ConnectionResetError, BrokenPipeError, OSError):
        pass
    finally:
        try:
            if writer.can_write_eof():
                writer.write_eof()
                # 对端可能不回 FIN（如 DoH 探测连接）→ wait_closed 永不完成。
                # 限时等待后 RST 强制关闭，避免 fd 与内核连接残留。
                try:
                    await asyncio.wait_for(
                        writer.wait_closed(), timeout=RELAY_EOF_WAIT_TIMEOUT
                    )
                except asyncio.TimeoutError:
                    _force_close_rst(writer)
            else:
                writer.close()
                await writer.wait_closed()
        except OSError:
            pass


CONNECT_TIMEOUT = 10
HANDSHAKE_TIMEOUT = 10
LOCAL_HANDSHAKE_TIMEOUT = 30
# write_eof() 后等待对端 FIN 的最长时间，超时则 RST 强制关闭。
# 对端（如 DoH 探测连接）经常不回 FIN，优雅关闭会让 fd 和内核连接
# 残留（CLOSED fd 堆积 + FIN_WAIT_2），最终拖垮连接表触发限流黑洞。
RELAY_EOF_WAIT_TIMEOUT = 3.0


def _force_close_rst(writer):
    """RST 强制关闭：设置 SO_LINGER(1, 0) 后 abort，连接立即消失，
    不进入 FIN_WAIT_2，也不残留 fd。"""
    try:
        sock = writer.transport.get_extra_info("socket")
        if sock:
            sock.setsockopt(
                socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0)
            )
    except (OSError, AttributeError):
        pass
    try:
        writer.transport.abort()
    except (OSError, AttributeError, RuntimeError):
        # RuntimeError: 事件循环已关闭（进程退出/回收竞态）
        pass


class EdrBlockDetector:
    """Detects EDR/security software blocking outbound connections.
    
    EDR tools (e.g. AliEntSafe/oneagent) inject RST during TCP handshake
    for processes with untrusted code signatures. This manifests as
    ConnectionResetError on open_connection().
    
    Detection: N consecutive ConnectionResetError on outbound connects
    within a time window → likely EDR blocking.
    """

    THRESHOLD = 3          # consecutive resets to trigger
    WINDOW = 30            # seconds window for counting
    NOTIFY_COOLDOWN = 300  # seconds between notifications

    def __init__(self, on_blocked=None, on_recovered=None):
        self._on_blocked = on_blocked  # callback(dest_addr, dest_port)
        self._on_recovered = on_recovered  # callback() when blocking clears
        self._reset_times = []         # timestamps of recent resets
        self._last_notify = 0
        self._notified = False

    def record_reset(self, dest_addr, dest_port):
        """Record a ConnectionResetError on outbound connect."""
        import time
        now = time.monotonic()
        self._reset_times.append(now)
        # Keep only resets within the window
        cutoff = now - self.WINDOW
        self._reset_times = [t for t in self._reset_times if t > cutoff]

        if len(self._reset_times) >= self.THRESHOLD and not self._notified:
            if now - self._last_notify > self.NOTIFY_COOLDOWN:
                self._notified = True
                self._last_notify = now
                logger.warning(
                    "EDR blocking suspected: %d consecutive ConnectionResetError "
                    "on outbound connects (last: %s:%s)",
                    len(self._reset_times), dest_addr, dest_port,
                )
                if self._on_blocked:
                    self._on_blocked(dest_addr, dest_port)

    def record_success(self):
        """Record a successful outbound connect — resets the detector."""
        self._reset_times.clear()
        if self._notified:
            self._notified = False
            logger.info("EDR blocking no longer detected (connection succeeded)")
            if self._on_recovered:
                self._on_recovered()



async def _socks5_handshake(reader, writer, server_config, dest_addr, dest_port):
    username = server_config["username"]
    password = server_config["password"]

    if username and password:
        writer.write(b"\x05\x01\x02")
    else:
        writer.write(b"\x05\x01\x00")
    await writer.drain()

    resp = await reader.readexactly(2)
    if resp[0] != 0x05:
        raise Exception("SOCKS5 version mismatch")

    if resp[1] == 0x02:
        uname = username.encode("utf-8")
        passwd = password.encode("utf-8")
        writer.write(
            b"\x01"
            + struct.pack("B", len(uname))
            + uname
            + struct.pack("B", len(passwd))
            + passwd
        )
        await writer.drain()
        auth_resp = await reader.readexactly(2)
        if auth_resp[1] != 0x00:
            raise Exception("SOCKS5 auth failed")
    elif resp[1] == 0xFF:
        raise Exception("SOCKS5 no acceptable auth method")

    try:
        addr = ipaddress.ip_address(dest_addr)
        if isinstance(addr, ipaddress.IPv4Address):
            addr_data = b"\x01" + addr.packed
        else:
            addr_data = b"\x04" + addr.packed
    except ValueError:
        encoded = dest_addr.encode("utf-8")
        addr_data = b"\x03" + struct.pack("B", len(encoded)) + encoded

    writer.write(
        b"\x05\x01\x00" + addr_data + struct.pack("!H", dest_port)
    )
    await writer.drain()

    reply = await reader.readexactly(4)
    if reply[1] != 0x00:
        raise Exception(f"SOCKS5 CONNECT failed: {reply[1]:#x}")

    if reply[3] == 0x01:
        await reader.readexactly(4 + 2)
    elif reply[3] == 0x03:
        length = (await reader.readexactly(1))[0]
        await reader.readexactly(length + 2)
    elif reply[3] == 0x04:
        await reader.readexactly(16 + 2)


async def _http_connect_handshake(reader, writer, server_config, dest_addr, dest_port):
    username = server_config["username"]
    password = server_config["password"]
    target = f"{dest_addr}:{dest_port}"
    lines = [f"CONNECT {target} HTTP/1.1", f"Host: {target}"]
    if username and password:
        import base64
        cred = base64.b64encode(f"{username}:{password}".encode()).decode()
        lines.append(f"Proxy-Authorization: Basic {cred}")
    lines.append("")
    lines.append("")
    writer.write("\r\n".join(lines).encode())
    await writer.drain()

    status_line = await reader.readline()
    if not status_line:
        raise Exception("HTTP proxy closed connection")
    parts = status_line.decode().split(" ", 2)
    if len(parts) < 2 or not parts[1].startswith("2"):
        raise Exception(f"HTTP proxy CONNECT failed: {status_line.decode().strip()}")
    while True:
        line = await reader.readline()
        if line in (b"\r\n", b"\n", b""):
            break


async def _close_writer(writer):
    writer.close()
    try:
        await writer.wait_closed()
    except OSError:
        pass


async def connect_upstream_socks5(
    server_config, dest_addr, dest_port, ssl_ctx=None, verify_cert_pin=None
):
    host = server_config["address"]
    port = server_config["port"]
    use_tls = server_config["tls"]
    resolved = await resolve_node_address(host)
    connect_host = resolved.connect_host
    server_hostname = resolved.server_hostname or host

    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(
            connect_host, port, ssl=ssl_ctx if use_tls else None,
            server_hostname=server_hostname if use_tls else None,
        ),
        timeout=CONNECT_TIMEOUT,
    )
    if verify_cert_pin and use_tls:
        verify_cert_pin(writer.get_extra_info("ssl_object"))
    _set_nodelay(writer)

    try:
        await asyncio.wait_for(
            _socks5_handshake(reader, writer, server_config, dest_addr, dest_port),
            timeout=HANDSHAKE_TIMEOUT,
        )
    except Exception:
        await _close_writer(writer)
        raise

    return reader, writer


async def connect_upstream_http(server_config, dest_addr, dest_port, ssl_ctx=None):
    host = server_config["address"]
    port = server_config["port"]
    use_tls = False
    resolved = await resolve_node_address(host)
    connect_host = resolved.connect_host
    server_hostname = resolved.server_hostname or host

    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(
            connect_host, port, ssl=ssl_ctx if use_tls else None,
            server_hostname=server_hostname if use_tls else None,
        ),
        timeout=CONNECT_TIMEOUT,
    )
    _set_nodelay(writer)

    try:
        await asyncio.wait_for(
            _http_connect_handshake(reader, writer, server_config, dest_addr, dest_port),
            timeout=HANDSHAKE_TIMEOUT,
        )
    except Exception:
        await _close_writer(writer)
        raise

    return reader, writer


async def connect_upstream_udp_associate(server_config, ssl_ctx=None):
    host = server_config["address"]
    port = server_config["port"]
    username = server_config["username"]
    password = server_config["password"]
    use_tls = server_config["tls"]
    resolved = await resolve_node_address(host)
    connect_host = resolved.connect_host
    server_hostname = resolved.server_hostname or host

    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(
            connect_host, port, ssl=ssl_ctx if use_tls else None,
            server_hostname=server_hostname if use_tls else None,
        ),
        timeout=CONNECT_TIMEOUT,
    )
    _set_nodelay(writer)

    async def _handshake():
        if username and password:
            writer.write(b"\x05\x01\x02")
        else:
            writer.write(b"\x05\x01\x00")
        await writer.drain()

        resp = await reader.readexactly(2)
        if resp[0] != 0x05:
            raise Exception("SOCKS5 version mismatch")

        if resp[1] == 0x02:
            uname = username.encode("utf-8")
            passwd = password.encode("utf-8")
            writer.write(
                b"\x01"
                + struct.pack("B", len(uname))
                + uname
                + struct.pack("B", len(passwd))
                + passwd
            )
            await writer.drain()
            auth_resp = await reader.readexactly(2)
            if auth_resp[1] != 0x00:
                raise Exception("SOCKS5 auth failed")
        elif resp[1] == 0xFF:
            raise Exception("SOCKS5 no acceptable auth method")

        # CMD=0x03 UDP ASSOCIATE, DST.ADDR=0.0.0.0:0
        writer.write(b"\x05\x03\x00\x01" + b"\x00" * 4 + b"\x00\x00")
        await writer.drain()

        reply = await reader.readexactly(4)
        if reply[1] != 0x00:
            raise Exception(f"SOCKS5 UDP ASSOCIATE failed: {reply[1]:#x}")

        if reply[3] == 0x01:
            await reader.readexactly(4 + 2)
        elif reply[3] == 0x03:
            length = (await reader.readexactly(1))[0]
            await reader.readexactly(length + 2)
        elif reply[3] == 0x04:
            await reader.readexactly(16 + 2)

    try:
        await asyncio.wait_for(_handshake(), timeout=HANDSHAKE_TIMEOUT)
    except Exception:
        await _close_writer(writer)
        raise

    return reader, writer


DIRECT_CONNECT_TIMEOUT = 10


async def connect_direct(dest_addr, dest_port):
    """直连目标。域名时逐个尝试解析出的 IP（带超时），避免单个
    不可达 IP（如唤醒后系统 DNS 返回的坏缓存/跨网段 IP）挂死整个
    连接（内核 TCP 超时可达 75s）。"""
    try:
        ipaddress.ip_address(dest_addr)
        is_domain = False
    except ValueError:
        is_domain = True

    if not is_domain:
        reader, writer = await asyncio.open_connection(dest_addr, dest_port)
        _set_nodelay(writer)
        return reader, writer

    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(dest_addr, dest_port, type=socket.SOCK_STREAM)
    addrs = []
    seen = set()
    for info in infos:
        addr = info[4]
        if addr not in seen:
            seen.add(addr)
            addrs.append(addr)
    last_exc = None
    for addr in addrs:
        try:
            # 注意：getaddrinfo 的 IPv6 地址是 4 元组 (host, port, flowinfo, scopeid)，
            # open_connection 只接受 (host, port)，取前两个即可
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(addr[0], addr[1]),
                timeout=DIRECT_CONNECT_TIMEOUT,
            )
            _set_nodelay(writer)
            return reader, writer
        except (asyncio.TimeoutError, OSError) as exc:
            last_exc = exc
            continue
        except asyncio.CancelledError:
            raise
    raise last_exc or OSError(
        f"all {len(addrs)} addresses failed for {dest_addr}:{dest_port}"
    )


def _is_edr_reset(exc):
    """Check if an exception looks like EDR RST injection during TCP handshake."""
    return isinstance(exc, ConnectionResetError)


MAX_CONCURRENT = 256

POOL_SIZE = 3
POOL_CHECK_INTERVAL = 1.0
POOL_CONNECT_TIMEOUT = 8


class UpstreamPool:
    def __init__(self, server_config, ssl_ctx, verify_cert_pin=None):
        self._server_config = server_config
        self._ssl_ctx = ssl_ctx
        self._verify_cert_pin = verify_cert_pin
        self._pool = asyncio.Queue(maxsize=POOL_SIZE)
        self._running = False
        self._task = None

    async def start(self):
        self._running = True
        self._task = asyncio.ensure_future(self._maintain())

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        while not self._pool.empty():
            try:
                _, writer = self._pool.get_nowait()
                await _close_writer(writer)
            except asyncio.QueueEmpty:
                break

    async def _maintain(self):
        while self._running:
            if self._pool.qsize() < POOL_SIZE:
                try:
                    reader, writer = await self.create_connection()
                    await self._pool.put((reader, writer))
                except Exception as exc:
                    logger.debug("upstream preconnect failed: %s", exc)
            await asyncio.sleep(POOL_CHECK_INTERVAL)

    async def create_connection(self):
        host = self._server_config["address"]
        port = self._server_config["port"]
        protocol = self._server_config.get("protocol", "socks5")
        use_tls = self._server_config["tls"] if protocol == "socks5" else False
        resolved = await resolve_node_address(host)
        connect_host = resolved.connect_host
        server_hostname = resolved.server_hostname or host

        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(
                connect_host, port,
                ssl=self._ssl_ctx if use_tls else None,
                server_hostname=server_hostname if use_tls else None,
            ),
            timeout=POOL_CONNECT_TIMEOUT,
        )
        if self._verify_cert_pin and use_tls:
            self._verify_cert_pin(writer.get_extra_info("ssl_object"))
        _set_nodelay(writer)
        return reader, writer

    async def acquire(self):
        while not self._pool.empty():
            try:
                reader, writer = self._pool.get_nowait()
            except asyncio.QueueEmpty:
                break
            if writer.is_closing():
                continue
            if reader.at_eof():
                await _close_writer(writer)
                continue
            return reader, writer
        return await self.create_connection()


class _UdpRelayProtocol(asyncio.DatagramProtocol):
    def __init__(self, tcp_writer, loop, on_activity=None):
        self._tcp_writer = tcp_writer
        self._loop = loop
        self._on_activity = on_activity
        self.client_addr = None
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        self.client_addr = addr
        if self._tcp_writer.is_closing():
            return
        frame = struct.pack("!H", len(data)) + data
        self._tcp_writer.write(frame)
        if self._on_activity:
            self._on_activity()
        add_bytes(len(data), "proxy", "outbound")


class ProxyCore:
    def __init__(self):
        self._loop = None
        self._thread = None
        self._socks_server = None
        self._http_server = None
        self._running = False
        self._server_config = None
        self._tunnel_config = {}
        self._proxy_private = False
        self._udp_enabled = True
        self._socks_port = 1080
        self._http_port = 1087
        self._ssl_ctx = None
        self._semaphore = None
        self._routing = None
        self._tunnel_client = None
        self._stop_lock = threading.Lock()
        self._configured_socks_port = None
        self._configured_http_port = None
        self._server_sockets = []
        self._cert_bind_enabled = False
        self._cert_pin = ""
        self._on_pin_callback = None
        self._cert_pin_lock = threading.Lock()
        self._cert_pin_mismatch_reported = False
        self._edr_detector = None
        self._on_edr_blocked = None
        self._on_edr_recovered = None
        self._upstream_pool = None
        self._active_connections = 0
        self._last_proxy_activity = time.monotonic()
        self._recycle_task = None
        # 活跃客户端连接的 transport 注册表，用于强制回收（屏幕点亮等
        # 场景主动断开旧连接，避免 server.wait_closed() 等待自然结束）
        self._active_transports = set()
        self._local_proxy_lock = None
        # recycle 进行中标志（跨线程安全）：app 层 health check 借此
        # 跳过本轮检查，避免在 listener 重建窗口内触发并发 stop/start
        self._recycling = threading.Event()

    def set_tunnel_client(self, tc):
        self._tunnel_client = tc

    def set_pin_callback(self, callback):
        self._on_pin_callback = callback

    def set_edr_callback(self, callback, on_recovered=None):
        """Set callbacks for EDR blocking detection.

        callback(dest_addr, dest_port) fires when blocking is suspected;
        on_recovered() fires when a later connection succeeds and clears the suspicion.
        """
        self._on_edr_blocked = callback
        self._on_edr_recovered = on_recovered

    def _emit_pin_event(self, event_type, data):
        cb = self._on_pin_callback
        if cb:
            cb(event_type, data)

    def _verify_cert_pin(self, ssl_obj):
        if not self._cert_bind_enabled:
            return
        cert_der = ssl_obj.getpeercert(binary_form=True) if ssl_obj else None
        if not cert_der:
            raise CertPinUnavailableError("peer certificate unavailable")

        new_pin = hashlib.sha256(cert_der).hexdigest()
        with self._cert_pin_lock:
            if not self._cert_pin:
                self._cert_pin = new_pin
                self._cert_pin_mismatch_reported = False
                crash_logger.warning("Cert pin TOFU: %s", new_pin)
                self._emit_pin_event("tofu", new_pin)
                return

            if self._cert_pin != new_pin:
                saved_pin = self._cert_pin
                if not self._cert_pin_mismatch_reported:
                    self._cert_pin_mismatch_reported = True
                    crash_logger.warning(
                        "Cert pin MISMATCH! saved=%s... new=%s...",
                        saved_pin[:16],
                        new_pin[:16],
                    )
                    self._emit_pin_event("mismatch", (saved_pin, new_pin))
                else:
                    crash_logger.debug("Cert pin mismatch suppressed; already reported")
                raise CertPinMismatchError(saved_pin, new_pin)

            if self._cert_pin_mismatch_reported:
                self._cert_pin_mismatch_reported = False
                self._emit_pin_event("match", new_pin)

    def _build_ssl_context(self):
        server = self._server_config
        if not server["tls"]:
            self._cert_bind_enabled = False
            self._cert_pin = ""
            self._cert_pin_mismatch_reported = False
            self._ssl_ctx = None
            return
        self._cert_bind_enabled = bool(server.get("certBindEnabled", False))
        self._cert_pin = server.get("certPin", "") or ""
        self._cert_pin_mismatch_reported = bool(server.get("certPinMismatch", False))
        ctx = ssl.create_default_context()
        if server["allowInsecure"]:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        self._ssl_ctx = ctx

    def start(self, user_config, config_dir=None):
        if self._running:
            self.stop()

        self._server_config = user_config["server"]
        self._tunnel_config = user_config.get("tunnel", {})
        local = user_config["local"]
        # 保存配置的原始端口，每次 start() 重置（防止端口漂移累积）
        self._configured_socks_port = local["socks_port"]
        self._configured_http_port = local["http_port"]
        self._socks_port = local["socks_port"]
        self._http_port = local["http_port"]
        self._proxy_private = local.get("proxy_private", False)
        self._udp_enabled = local.get("udp", True)
        self._build_ssl_context()
        self._edr_detector = EdrBlockDetector(
            on_blocked=self._on_edr_blocked,
            on_recovered=self._on_edr_recovered,
        )

        # Initialize routing engine (geodata loaded selectively in RoutingEngine.__init__)
        from routing import RoutingEngine, _geodata_dir
        routing_config = user_config.get("routing", {})
        self._routing = RoutingEngine(routing_config, _geodata_dir())

        self._loop = asyncio.new_event_loop()
        started = threading.Event()
        self._start_error = None
        self._thread = threading.Thread(
            target=self._run_loop, args=(started,), daemon=True
        )
        self._thread.start()
        started.wait(timeout=5)
        if self._start_error:
            raise self._start_error
        self._running = True

    def stop(self):
        with self._stop_lock:
            self._running = False
            loop = self._loop
            thread = self._thread

            if loop and loop.is_running():
                # 先关闭 server sockets 释放端口，再停 loop。
                # 必须等待 _shutdown 完成（内部 wait_closed 与锁等待均
                # 已限时），否则残留协程（如超时未退出的 recycle）会在
                # 新事件循环上继续操作 server 引用，导致跨循环
                # RuntimeError 与 EADDRINUSE 端口漂移。
                async def _shutdown():
                    await self._stop_servers()
                    loop.stop()
                try:
                    asyncio.run_coroutine_threadsafe(_shutdown(), loop).result(
                        timeout=LOCAL_PROXY_STOP_WAIT_TIMEOUT * 2 + 2
                    )
                    # 正常路径：端口已释放，清空引用防止新 loop 误操作
                    self._socks_server = None
                    self._http_server = None
                    self._server_sockets = []
                except Exception:
                    logger.warning("proxy shutdown timed out, forcing close", exc_info=True)
                    # 超时路径：保留 _server_sockets 供下方强制关闭兜底，
                    # 只丢弃 server 对象（跨 loop 操作会抛 RuntimeError）
                    self._socks_server = None
                    self._http_server = None

            if thread:
                # Wait for thread to exit with short timeout
                thread.join(timeout=3)
                if not thread.is_alive() and loop:
                    try:
                        loop.close()
                    except Exception:
                        pass
                elif loop:
                    # 线程未退出：强制关闭 server sockets 释放端口
                    for sock in self._server_sockets:
                        try:
                            sock.close()
                        except Exception:
                            pass
                    logger.warning("proxy thread did not exit in time, forced server socket close")
            self._loop = None
            self._thread = None

    def is_running(self):
        thread = self._thread
        return self._running and thread is not None and thread.is_alive()

    def fd_count(self):
        """当前进程 fd 数量。残留连接（探测连接的 CLOSED fd / FIN_WAIT_2）
        会堆积在此，超过阈值说明需要回收（唤醒时或 recycle 时）。"""
        try:
            return len(os.listdir("/dev/fd"))
        except OSError:
            return 0

    def recycle_local_proxy(self):
        """同步触发本地 SOCKS/HTTP listener 静默重启（类似 8b96bc4 的
        recycle 机制）：**主动断开所有活跃连接**、关闭旧 listener 与
        连接池，重建新的，清空旧连接会话（如 EDR 审查产生的慢连接）。
        不触碰事件循环、tunnel 与应用其他状态。供 app 层在屏幕点亮
        等事件后调用。

        协程内部自带超时兜底（_recycle_local_proxy_forced_once 用
        wait_for 包裹），最坏在 LOCAL_PROXY_RECYCLE_TIMEOUT 内必然
        退出，不会留下僵尸协程在新事件循环上继续操作 server 引用。"""
        loop = self._loop
        if not loop or not loop.is_running():
            return
        self._recycling.set()
        try:
            future = asyncio.run_coroutine_threadsafe(
                self._recycle_local_proxy_forced_once(), loop
            )
            # 内部 wait_for 保证协程在 LOCAL_PROXY_RECYCLE_TIMEOUT 内
            # 完成，此处 +5s 缓冲只兜底调度延迟，不会真的等待 20s
            future.result(timeout=LOCAL_PROXY_RECYCLE_TIMEOUT + 5)
        except Exception:
            crash_logger.warning("local proxy recycle (screen wake) failed", exc_info=True)
        finally:
            self._recycling.clear()

    def is_recycling(self):
        """recycle 是否进行中。app 层 health check 借此跳过本轮检查，
        避免在 listener 重建窗口（~3s）内触发并发 stop/start。"""
        return self._recycling.is_set()

    async def _recycle_local_proxy_forced_once(self):
        """强制回收：先主动断开所有活跃连接（不等自然结束），
        再执行常规 recycle，让 server.wait_closed() 快速返回。
        整体限时自毁，防止探测风暴下卡成僵尸协程。"""
        try:
            await asyncio.wait_for(
                self._do_recycle_forced(), timeout=LOCAL_PROXY_RECYCLE_TIMEOUT
            )
        except asyncio.TimeoutError:
            crash_logger.warning(
                "local proxy recycle exceeded %.1fs, aborted",
                LOCAL_PROXY_RECYCLE_TIMEOUT,
            )

    async def _do_recycle_forced(self):
        async with self._get_local_proxy_lock():
            for transport in list(self._active_transports):
                try:
                    transport.abort()
                except (OSError, RuntimeError):
                    pass
            await self._recycle_local_proxy_once_unlocked()

    @property
    def socks_port(self):
        return self._socks_port

    @property
    def http_port(self):
        return self._http_port

    async def _measure_latency(self):
        import time
        protocol = self._server_config.get("protocol", "socks5")
        username = self._server_config.get("username", "")
        password = self._server_config.get("password", "")

        # 隧道协议：复用已建立的隧道连接，通过 CONNECT 握手测量延迟
        if protocol == "tunnel":
            if not self._tunnel_client:
                raise NodeUnreachableError("Tunnel not configured")
            # 检查隧道当前状态
            tunnel_status = self._tunnel_client.get_status()
            if tunnel_status == 'reconnecting':
                return (None, "reconnecting")
            if not self._tunnel_client.is_connected():
                raise NodeUnreachableError("Tunnel not connected")
            latency = self._tunnel_client.measure_latency(timeout=5)
            if latency is None:
                raise NodeUnreachableError("Tunnel CONNECT failed")
            return (latency, None)

        addr = self._server_config["address"]
        port = self._server_config["port"]
        resolved = await resolve_node_address(addr)
        connect_addr = resolved.connect_host
        server_hostname = resolved.server_hostname or addr

        start = time.monotonic()
        reader = None
        writer = None
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(
                    connect_addr, port,
                    ssl=self._ssl_ctx if self._server_config["tls"] else None,
                    server_hostname=server_hostname if self._server_config["tls"] else None,
                ),
                timeout=5,
            )

            if protocol == "socks5" and self._server_config["tls"]:
                self._verify_cert_pin(writer.get_extra_info("ssl_object"))

            if protocol == "http":
                await self._measure_latency_http(reader, writer, username, password)
            else:
                await self._measure_latency_socks5(reader, writer, username, password)

            elapsed = time.monotonic() - start
            return (int(elapsed * 1000), None)
        except AuthFailedError:
            return (None, "auth_failed")
        except CertPinMismatchError:
            return (None, "pin_mismatch")
        except (NodeUnreachableError, ConnectionRefusedError, ConnectionResetError,
                OSError, asyncio.TimeoutError, TimeoutError):
            return (None, "unreachable")
        except Exception:
            return (None, "error")
        finally:
            if writer:
                writer.close()
                try:
                    await writer.wait_closed()
                except OSError:
                    pass

    async def _measure_latency_socks5(self, reader, writer, username, password):
        if username and password:
            writer.write(b"\x05\x01\x02")
        else:
            writer.write(b"\x05\x01\x00")
        await writer.drain()
        resp = await asyncio.wait_for(reader.readexactly(2), timeout=5)
        if resp[0] != 0x05:
            raise Exception("not a SOCKS5 server")
        if resp[1] == 0x02 and username and password:
            uname = username.encode("utf-8")
            passwd = password.encode("utf-8")
            writer.write(
                b"\x01"
                + struct.pack("B", len(uname)) + uname
                + struct.pack("B", len(passwd)) + passwd
            )
            await writer.drain()
            auth_resp = await asyncio.wait_for(reader.readexactly(2), timeout=5)
            if auth_resp[1] != 0x00:
                raise AuthFailedError("SOCKS5 auth failed")

    async def _measure_latency_http(self, reader, writer, username, password):
        import base64
        target = "127.0.0.1:80"
        lines = [f"CONNECT {target} HTTP/1.1", f"Host: {target}"]
        if username and password:
            cred = base64.b64encode(f"{username}:{password}".encode()).decode()
            lines.append(f"Proxy-Authorization: Basic {cred}")
        lines.append("")
        lines.append("")
        writer.write("\r\n".join(lines).encode())
        await writer.drain()

        status_line = await asyncio.wait_for(reader.readline(), timeout=5)
        if not status_line:
            raise NodeUnreachableError("HTTP proxy closed connection")
        parts = status_line.decode().split(" ", 2)
        if len(parts) < 2 or not parts[1].startswith("2"):
            status_code = parts[1] if len(parts) >= 2 else "?"
            if status_code == "407":
                raise AuthFailedError(f"HTTP proxy auth failed: {status_line.decode().strip()}")
            raise NodeUnreachableError(f"HTTP proxy CONNECT failed: {status_line.decode().strip()}")

    def measure_latency(self):
        """测量代理延迟，返回 (protocol_name, latency_ms_or_None, failure_reason_or_None)。代理未运行时返回 None。"""
        if not self._running or not self._loop or not self._loop.is_running():
            return None
        protocol = self._server_config.get("protocol", "socks5")
        name_map = {"http": "http", "socks5": "socks5", "tunnel": "隧道"}
        protocol_name = name_map.get(protocol, protocol)

        future = asyncio.run_coroutine_threadsafe(self._measure_latency(), self._loop)
        try:
            latency, failure_reason = future.result(timeout=6)
            return (protocol_name, latency, failure_reason)
        except Exception:
            return (protocol_name, None, "unreachable")

    def _run_loop(self, started_event):
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._start_servers())
        except OSError as e:
            self._start_error = e
            started_event.set()
            return
        started_event.set()
        self._loop.run_forever()

    async def _start_servers(self):
        self._semaphore = asyncio.Semaphore(MAX_CONCURRENT)
        init_writer()
        asyncio.ensure_future(self._flush_stats_loop())
        self._active_connections = 0
        self._mark_proxy_activity()
        await self._start_local_proxy(allow_port_retry=True)
        self._recycle_task = asyncio.ensure_future(self._local_proxy_recycle_loop())

    async def _start_local_proxy(self, allow_port_retry):
        self._server_sockets = []
        # 防御：丢弃上一轮（可能属于已关闭事件循环）的 server 引用。
        # 跨 loop 的 server 对象在 close/wait_closed 时抛 "Future
        # attached to a different loop"，且占用端口导致 EADDRINUSE 漂移。
        self._socks_server = None
        self._http_server = None
        protocol = self._server_config.get("protocol", "socks5")
        self._upstream_pool = None
        max_attempts = 100
        for attempt in range(max_attempts):
            try:
                self._socks_server = await asyncio.start_server(
                    self._handle_socks, "127.0.0.1", self._socks_port
                )
                self._http_server = await asyncio.start_server(
                    self._handle_http, "127.0.0.1", self._http_port
                )
                # 收集 server sockets 用于强制关闭
                for server in (self._socks_server, self._http_server):
                    for sock in server.sockets or []:
                        self._server_sockets.append(sock)
                if protocol in ("socks5", "http"):
                    self._upstream_pool = UpstreamPool(
                        self._server_config, self._ssl_ctx,
                        verify_cert_pin=self._verify_cert_pin if self._cert_bind_enabled else None,
                    )
                    await self._upstream_pool.start()
                return
            except OSError as e:
                if allow_port_retry and e.errno == 48 and attempt < max_attempts - 1:
                    # 关闭本轮已创建的 server，避免 socket 泄漏
                    if self._socks_server:
                        self._socks_server.close()
                        await self._close_server_limited(self._socks_server)
                        self._socks_server = None
                    if self._http_server:
                        self._http_server.close()
                        await self._close_server_limited(self._http_server)
                        self._http_server = None
                    logger.warning(
                        "local proxy port %s/%s in use, retrying with +%d offset",
                        self._socks_port, self._http_port, attempt + 1,
                    )
                    # 每次重试从配置的原始端口开始偏移，防止漂移累积
                    self._socks_port = self._configured_socks_port + attempt + 1
                    self._http_port = self._configured_http_port + attempt + 1
                else:
                    raise

    async def _stop_servers(self):
        if self._recycle_task and self._recycle_task is not asyncio.current_task():
            self._recycle_task.cancel()
            try:
                await self._recycle_task
            except asyncio.CancelledError:
                pass
        self._recycle_task = None
        try:
            # 整体限时：等待锁被僵尸协程释放 + 关闭 server 收尾，
            # 超时强制关 socket 释放端口，保证 stop() 必然快速完成
            await asyncio.wait_for(
                self._stop_local_proxy_locked(),
                timeout=LOCAL_PROXY_STOP_WAIT_TIMEOUT + 2,
            )
        except asyncio.TimeoutError:
            logger.warning("stop local proxy timed out, forcing socket close")
            for sock in self._server_sockets:
                try:
                    sock.close()
                except Exception:
                    pass
            self._server_sockets = []
            self._socks_server = None
            self._http_server = None

    async def _stop_local_proxy_locked(self):
        async with self._get_local_proxy_lock():
            await self._stop_local_proxy()

    def _get_local_proxy_lock(self):
        if self._local_proxy_lock is None:
            self._local_proxy_lock = asyncio.Lock()
        return self._local_proxy_lock

    async def _close_server_limited(self, server):
        """关闭 server 后限时等待连接收尾。端口释放只依赖 close()
        （同步关闭 listen socket）；对端（如 EDR 探测连接）会持续注入
        新连接，wait_closed() 无限等待会让 recycle 停在"已关未建"
        中间态（Connection refused），超时后丢弃 server 对象即可，
        连接由各自 handler 自行收尾。"""
        try:
            await asyncio.wait_for(
                server.wait_closed(), timeout=LOCAL_PROXY_STOP_WAIT_TIMEOUT
            )
        except asyncio.TimeoutError:
            logger.warning(
                "server wait_closed timed out after %.1fs, dropping server",
                LOCAL_PROXY_STOP_WAIT_TIMEOUT,
            )

    async def _stop_local_proxy(self):
        if self._upstream_pool:
            await self._upstream_pool.stop()
            self._upstream_pool = None
        if self._socks_server:
            self._socks_server.close()
            await self._close_server_limited(self._socks_server)
            self._socks_server = None
        if self._http_server:
            self._http_server.close()
            await self._close_server_limited(self._http_server)
            self._http_server = None
        self._server_sockets = []

    def _mark_proxy_activity(self):
        self._last_proxy_activity = time.monotonic()

    def _connection_started(self):
        self._active_connections += 1
        self._mark_proxy_activity()

    def _connection_finished(self):
        self._active_connections = max(0, self._active_connections - 1)
        self._mark_proxy_activity()

    def _can_recycle_local_proxy(self, now=None):
        now = time.monotonic() if now is None else now
        if (
            self._active_connections == 0
            and now - self._last_proxy_activity >= LOCAL_PROXY_RECYCLE_IDLE_SECONDS
        ):
            return True
        # fd 残留过多（探测连接堆积，如 8.8.8.8:53 的 DoH 探测）时提前回收，
        # 防止连接表被持续占用并在突发并发时触发网关 SYN 限流（30s 黑洞）
        return (
            self._active_connections == 0
            and self.fd_count() > LOCAL_PROXY_FD_RECYCLE_THRESHOLD
        )

    async def _local_proxy_recycle_loop(self):
        await asyncio.sleep(LOCAL_PROXY_RECYCLE_INTERVAL)
        while True:
            if self._can_recycle_local_proxy():
                try:
                    await self._recycle_local_proxy_once()
                except Exception:
                    crash_logger.warning("local proxy recycle failed", exc_info=True)
                await asyncio.sleep(LOCAL_PROXY_RECYCLE_INTERVAL)
            else:
                idle_for = time.monotonic() - self._last_proxy_activity
                logger.info(
                    "local proxy recycle deferred: active=%d idle=%.1fs",
                    self._active_connections,
                    idle_for,
                )
                await asyncio.sleep(LOCAL_PROXY_RECYCLE_DEFER_SECONDS)

    async def _recycle_local_proxy_once(self):
        async with self._get_local_proxy_lock():
            await self._recycle_local_proxy_once_unlocked()

    async def _recycle_local_proxy_once_unlocked(self):
        logger.info("local proxy recycle starting")
        await self._stop_local_proxy()
        await self._start_local_proxy(allow_port_retry=False)
        self._mark_proxy_activity()
        logger.info(
            "local proxy recycle completed: socks=%s http=%s",
            self._socks_port,
            self._http_port,
        )

    async def _flush_stats_loop(self):
        while True:
            await asyncio.sleep(2)
            flush_stats()

    def _should_direct(self, host):
        if self._proxy_private:
            return False
        return is_private_ip(host)

    def _select_route(self, dest_addr, is_domain=None):
        if is_domain is None:
            # Auto-detect: try parsing as IP address
            try:
                ipaddress.ip_address(dest_addr)
                is_domain = False
            except ValueError:
                is_domain = True

        # 0. Private IP check (highest priority, always direct, not affected by routing)
        if self._should_direct(dest_addr):
            return "direct"

        # 1. Routing check (if enabled)
        if self._routing:
            route = self._routing.resolve(dest_addr, is_domain)
            if route == "direct":
                return "direct"
            # route == "proxy" or resolve returned default → fall through

        # 2. Tunnel check (if protocol is tunnel, always use it)
        if self._server_config.get("protocol") == "tunnel":
            return "tunnel"

        # 3. Fallback: upstream proxy
        return "proxy"

    async def _connect_target(self, dest_addr, dest_port, is_domain=None, route=None):
        if route is None:
            route = self._select_route(dest_addr, is_domain=is_domain)
        try:
            if route == "tunnel":
                reader, writer = await self._connect_via_tunnel(dest_addr, dest_port)
                return reader, writer, "tunnel"
            if route == "direct":
                reader, writer = await connect_direct(dest_addr, dest_port)
                if self._edr_detector:
                    self._edr_detector.record_success()
                return reader, writer, "direct"
            reader, writer = await self._connect_upstream(dest_addr, dest_port)
            if self._edr_detector:
                self._edr_detector.record_success()
            return reader, writer, "proxy"
        except ConnectionResetError:
            if self._edr_detector:
                self._edr_detector.record_reset(dest_addr, dest_port)
            raise

    async def _connect_via_tunnel(self, dest_addr, dest_port):
        loop = asyncio.get_event_loop()
        sock = await loop.run_in_executor(
            None, self._tunnel_client.forward_connect_sync, dest_addr, dest_port
        )
        reader, writer = await asyncio.open_connection(sock=sock)
        return reader, writer

    async def _connect_upstream(self, dest_addr, dest_port):
        protocol = self._server_config.get("protocol", "socks5")
        if protocol == "http":
            if self._upstream_pool:
                return await self._connect_with_pool(
                    dest_addr, dest_port, _http_connect_handshake
                )
            return await connect_upstream_http(
                self._server_config, dest_addr, dest_port, ssl_ctx=self._ssl_ctx
            )
        if self._upstream_pool:
            return await self._connect_with_pool(
                dest_addr, dest_port, _socks5_handshake
            )
        return await connect_upstream_socks5(
            self._server_config,
            dest_addr,
            dest_port,
            ssl_ctx=self._ssl_ctx,
            verify_cert_pin=self._verify_cert_pin,
        )

    async def _connect_with_pool(self, dest_addr, dest_port, handshake):
        reader, writer = await self._upstream_pool.acquire()
        try:
            await asyncio.wait_for(
                handshake(reader, writer, self._server_config, dest_addr, dest_port),
                timeout=HANDSHAKE_TIMEOUT,
            )
            return reader, writer
        except Exception:
            await _close_writer(writer)

        reader, writer = await self._upstream_pool.create_connection()
        try:
            await asyncio.wait_for(
                handshake(reader, writer, self._server_config, dest_addr, dest_port),
                timeout=HANDSHAKE_TIMEOUT,
            )
            return reader, writer
        except Exception:
            await _close_writer(writer)
            raise

    async def _handle_socks(self, client_reader, client_writer):
        transport = client_writer.transport
        self._active_transports.add(transport)
        try:
            async with self._semaphore:
                self._connection_started()
                try:
                    await self._do_handle_socks(client_reader, client_writer)
                finally:
                    self._connection_finished()
        finally:
            self._active_transports.discard(transport)

    async def _do_handle_socks(self, client_reader, client_writer):
        _set_nodelay(client_writer)
        try:
            header = await asyncio.wait_for(client_reader.readexactly(2), timeout=LOCAL_HANDSHAKE_TIMEOUT)
            ver, nmethods = header
            if ver != 0x05:
                client_writer.close()
                return
            await asyncio.wait_for(client_reader.readexactly(nmethods), timeout=LOCAL_HANDSHAKE_TIMEOUT)

            client_writer.write(b"\x05\x00")
            await client_writer.drain()

            req = await asyncio.wait_for(client_reader.readexactly(4), timeout=LOCAL_HANDSHAKE_TIMEOUT)
            ver, cmd, _, atyp = req

            if cmd == 0x03:
                await self._handle_udp_associate(client_reader, client_writer, atyp)
                return

            if cmd != 0x01:
                client_writer.write(
                    b"\x05\x07\x00\x01" + b"\x00" * 4 + b"\x00\x00"
                )
                await client_writer.drain()
                client_writer.close()
                return

            if atyp == 0x01:
                raw = await asyncio.wait_for(client_reader.readexactly(4), timeout=LOCAL_HANDSHAKE_TIMEOUT)
                dest_addr = str(ipaddress.IPv4Address(raw))
            elif atyp == 0x03:
                length = (await asyncio.wait_for(client_reader.readexactly(1), timeout=LOCAL_HANDSHAKE_TIMEOUT))[0]
                dest_addr = (await asyncio.wait_for(client_reader.readexactly(length), timeout=LOCAL_HANDSHAKE_TIMEOUT)).decode("utf-8")
            elif atyp == 0x04:
                raw = await asyncio.wait_for(client_reader.readexactly(16), timeout=LOCAL_HANDSHAKE_TIMEOUT)
                dest_addr = str(ipaddress.IPv6Address(raw))
            else:
                client_writer.write(
                    b"\x05\x08\x00\x01" + b"\x00" * 4 + b"\x00\x00"
                )
                await client_writer.drain()
                client_writer.close()
                return

            port_data = await asyncio.wait_for(client_reader.readexactly(2), timeout=LOCAL_HANDSHAKE_TIMEOUT)
            dest_port = struct.unpack("!H", port_data)[0]

            # Determine if target is a domain or IP
            try:
                ipaddress.ip_address(dest_addr)
                is_domain = False
            except ValueError:
                is_domain = True

            route = self._select_route(dest_addr, is_domain=is_domain)
            direct = route == "direct"
            try:
                remote_reader, remote_writer, route = await self._connect_target(
                    dest_addr, dest_port, is_domain=is_domain, route=route
                )
            except Exception as e:
                _log_access(dest_addr, dest_port, "CONNECT", direct, str(e))
                if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                    crash_logger.warning(f"SOCKS5 connect failed: {dest_addr}:{dest_port}", exc_info=True)
                return

            _log_access(dest_addr, dest_port, "CONNECT", direct)

            relay_started = False
            try:
                client_writer.write(
                    b"\x05\x00\x00\x01" + b"\x00" * 4 + b"\x00\x00"
                )
                await client_writer.drain()
                relay_started = True

                await asyncio.gather(
                    relay(client_reader, remote_writer, route, "outbound", self._mark_proxy_activity),
                    relay(remote_reader, client_writer, route, "inbound", self._mark_proxy_activity),
                )
            finally:
                # 与 HTTP 分支同理：握手后客户端立即断开时兜底关闭 remote_writer
                if not relay_started:
                    _force_close_rst(remote_writer)
        except asyncio.IncompleteReadError:
            return
        except Exception as e:
            if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                crash_logger.warning("SOCKS5 handler unexpected error", exc_info=True)
        finally:
            try:
                client_writer.close()
                await client_writer.wait_closed()
            except OSError:
                pass

    async def _handle_udp_associate(self, client_reader, client_writer, atyp):
        # 消费掉请求中剩余的地址和端口字段
        try:
            if atyp == 0x01:
                await asyncio.wait_for(client_reader.readexactly(4 + 2), timeout=LOCAL_HANDSHAKE_TIMEOUT)
            elif atyp == 0x03:
                length = (await asyncio.wait_for(client_reader.readexactly(1), timeout=LOCAL_HANDSHAKE_TIMEOUT))[0]
                await asyncio.wait_for(client_reader.readexactly(length + 2), timeout=LOCAL_HANDSHAKE_TIMEOUT)
            elif atyp == 0x04:
                await asyncio.wait_for(client_reader.readexactly(16 + 2), timeout=LOCAL_HANDSHAKE_TIMEOUT)
        except Exception:
            client_writer.close()
            return

        protocol = self._server_config.get("protocol", "socks5")
        udp_enabled = getattr(self, "_udp_enabled", True)
        if protocol != "socks5" or not udp_enabled:
            client_writer.write(b"\x05\x07\x00\x01" + b"\x00" * 4 + b"\x00\x00")
            await client_writer.drain()
            client_writer.close()
            return

        try:
            remote_reader, remote_writer = await connect_upstream_udp_associate(
                self._server_config, ssl_ctx=self._ssl_ctx
            )
            _log_access("UDP-ASSOCIATE", 0, "UDP", False)
        except Exception as e:
            _log_access("UDP-ASSOCIATE", 0, "UDP", False, str(e))
            if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                crash_logger.warning("UDP associate failed", exc_info=True)
            client_writer.write(b"\x05\x05\x00\x01" + b"\x00" * 4 + b"\x00\x00")
            await client_writer.drain()
            client_writer.close()
            return

        loop = asyncio.get_event_loop()
        transport, udp_relay = await loop.create_datagram_endpoint(
            lambda: _UdpRelayProtocol(remote_writer, loop, self._mark_proxy_activity),
            local_addr=("127.0.0.1", 0),
        )
        relay_addr = transport.get_extra_info("sockname")
        relay_port = relay_addr[1]

        # 回复客户端 UDP relay 地址
        reply = b"\x05\x00\x00\x01\x7f\x00\x00\x01" + struct.pack("!H", relay_port)
        try:
            client_writer.write(reply)
            await client_writer.drain()

            async def _tcp_to_udp():
                try:
                    while True:
                        frame_data = await asyncio.wait_for(
                            read_udp_frame(remote_reader), timeout=UDP_IDLE_TIMEOUT
                        )
                        self._mark_proxy_activity()
                        add_bytes(len(frame_data), "proxy", "inbound")
                        if udp_relay.client_addr:
                            transport.sendto(frame_data, udp_relay.client_addr)
                except (asyncio.TimeoutError, asyncio.IncompleteReadError,
                        ConnectionResetError, BrokenPipeError, OSError):
                    pass

            async def _wait_control_close():
                try:
                    await client_reader.read(1)
                except (ConnectionResetError, BrokenPipeError, OSError):
                    pass

            tasks = [
                asyncio.ensure_future(_tcp_to_udp()),
                asyncio.ensure_future(_wait_control_close()),
            ]
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in tasks:
                t.cancel()
        finally:
            transport.close()
            try:
                remote_writer.close()
                await asyncio.wait_for(
                    remote_writer.wait_closed(), timeout=RELAY_EOF_WAIT_TIMEOUT
                )
            except (asyncio.TimeoutError, OSError):
                _force_close_rst(remote_writer)
            try:
                client_writer.close()
                await client_writer.wait_closed()
            except OSError:
                pass

    async def _handle_http(self, client_reader, client_writer):
        transport = client_writer.transport
        self._active_transports.add(transport)
        try:
            async with self._semaphore:
                self._connection_started()
                try:
                    await self._do_handle_http(client_reader, client_writer)
                finally:
                    self._connection_finished()
        finally:
            self._active_transports.discard(transport)

    async def _do_handle_http(self, client_reader, client_writer):
        _set_nodelay(client_writer)
        try:
            raw_line = await asyncio.wait_for(client_reader.readline(), timeout=LOCAL_HANDSHAKE_TIMEOUT)
            if not raw_line:
                client_writer.close()
                return
            line = raw_line.decode("utf-8", errors="replace").strip()
            parts = line.split()
            if len(parts) < 3:
                client_writer.close()
                return

            method = parts[0].upper()

            if method == "CONNECT":
                target = parts[1]
                if ":" in target:
                    host, port_str = target.rsplit(":", 1)
                    port = int(port_str)
                    # Strip IPv6 brackets
                    if host.startswith("[") and host.endswith("]"):
                        host = host[1:-1]
                else:
                    host = target
                    port = 443

                while True:
                    header_line = await asyncio.wait_for(client_reader.readline(), timeout=LOCAL_HANDSHAKE_TIMEOUT)
                    if header_line in (b"\r\n", b"\n", b""):
                        break

                try:
                    ipaddress.ip_address(host)
                    is_domain = False
                except ValueError:
                    is_domain = True

                route = self._select_route(host, is_domain=is_domain)
                direct = route == "direct"
                try:
                    remote_reader, remote_writer, route = await self._connect_target(
                        host, port, is_domain=is_domain, route=route
                    )
                except Exception as e:
                    _log_access(host, port, "CONNECT", direct, str(e))
                    if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                        crash_logger.warning(f"HTTP CONNECT failed: {host}:{port}", exc_info=True)
                    return

                _log_access(host, port, "CONNECT", direct)

                relay_started = False
                try:
                    client_writer.write(
                        b"HTTP/1.1 200 Connection Established\r\n\r\n"
                    )
                    await client_writer.drain()
                    relay_started = True

                    await asyncio.gather(
                        relay(client_reader, remote_writer, route, "outbound", self._mark_proxy_activity),
                        relay(remote_reader, client_writer, route, "inbound", self._mark_proxy_activity),
                    )
                finally:
                    # 客户端在握手后立即断开（如探测连接）时，drain 抛异常
                    # 会跳过 relay，remote_writer 必须在此兜底关闭，防止 fd 泄漏
                    if not relay_started:
                        _force_close_rst(remote_writer)
            else:
                url = parts[1]
                if url.startswith("http://"):
                    url_body = url[7:]
                    slash_idx = url_body.find("/")
                    if slash_idx == -1:
                        host_part = url_body
                        path = "/"
                    else:
                        host_part = url_body[:slash_idx]
                        path = url_body[slash_idx:]

                    if ":" in host_part:
                        host, port_str = host_part.rsplit(":", 1)
                        port = int(port_str)
                    else:
                        host = host_part
                        port = 80

                    headers = []
                    while True:
                        header_line = await asyncio.wait_for(client_reader.readline(), timeout=LOCAL_HANDSHAKE_TIMEOUT)
                        if header_line in (b"\r\n", b"\n", b""):
                            break
                        headers.append(header_line)

                    try:
                        ipaddress.ip_address(host)
                        is_domain = False
                    except ValueError:
                        is_domain = True

                    route = self._select_route(host, is_domain=is_domain)
                    direct = route == "direct"
                    try:
                        remote_reader, remote_writer, route = await self._connect_target(
                            host, port, is_domain=is_domain, route=route
                        )
                    except Exception as e:
                        _log_access(host, port, method, direct, str(e))
                        if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                            crash_logger.warning(f"HTTP request failed: {host}:{port}", exc_info=True)
                        return

                    _log_access(host, port, method, direct)

                    relay_started = False
                    try:
                        if direct:
                            # 直连目标服务器：用路径格式
                            request_line = f"{method} {path} {parts[2]}\r\n".encode()
                        else:
                            # 下游是代理（tunnel 或 upstream proxy）：保留完整 URL
                            request_line = f"{method} {url} {parts[2]}\r\n".encode()
                        remote_writer.write(request_line)
                        for h in headers:
                            remote_writer.write(h)
                        remote_writer.write(b"\r\n")
                        await remote_writer.drain()
                        relay_started = True

                        await asyncio.gather(
                            relay(remote_reader, client_writer, route, "inbound", self._mark_proxy_activity),
                            relay(client_reader, remote_writer, route, "outbound", self._mark_proxy_activity),
                        )
                    finally:
                        if not relay_started:
                            _force_close_rst(remote_writer)
                else:
                    client_writer.close()
                    return
        except Exception as e:
            if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                crash_logger.warning("HTTP handler unexpected error", exc_info=True)
        finally:
            try:
                client_writer.close()
                await client_writer.wait_closed()
            except OSError:
                pass
