import asyncio
import errno
import faulthandler
import functools
import hashlib
import ipaddress
import logging
import os
import socket
import ssl
import struct
import sys
import threading
import time

logger = logging.getLogger("proxy_core")

from logger import access_logger, crash_logger, diagnostics_logger
from node_connect import open_node_connection
from h2_upstream import H2UpstreamPool, H2_AVAILABLE
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


class ProxyThreadStuckError(RuntimeError):
    """旧事件循环线程仍存活，拒绝再起第二个循环。

    age_seconds 是该线程被记为孤儿后存活的秒数：调用方据此区分
    「刚僵住、还可能自己退出」（继续退避重试）与「已僵死、本进程
    内无救」（直接提示用户重启客户端）。消息保留旧文案前缀，便于
    已有日志检索与测试匹配。
    """

    def __init__(self, age_seconds):
        self.age_seconds = age_seconds
        super().__init__(
            "previous proxy event loop thread is still alive "
            "(stuck %.0fs); refusing to start a second event loop"
            % age_seconds
        )


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


# 空闲回收阈值：语义是「整条连接两个方向都没有字节流动满这么久」，
# 而不是「某个方向空闲这么久」（见 IdleDeadline）。LLM 流式响应这类
# 单向长流的连接靠入向持续续命，不会因为出向长时间没数据被误杀。
# 值上仍需有界：TCP 不通知对端死亡，靠它回收挂死连接。
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
# 孤儿事件循环线程的放弃阈值：stop() 没能让线程退出后，start() 每次
# 都会被拒。超过这个时限仍不退出就认定 loop 已僵死，本进程内无法再
# 安全启动代理，app 层据此直接提示用户重启客户端，而不是继续按退避
# 重试（2026-10-26 现场：orphan 线程存活 5 分钟，三次自动重启全被拒，
# 代理空窗 6.5 分钟，期间系统代理仍指向死端口，用户感知为整机卡顿）。
ORPHAN_THREAD_GIVEUP_SECONDS = 30.0
# RSS 告警阈值（MB）：超过即每 10 分钟往 crash.log 记一次，避免对象堆
# 膨胀只在 diagnostics.log 里静默发生（同日现场物理 footprint 41GB，
# 磁盘日志无任何异常记录，只能靠事后 vmmap 才看出来）。
RSS_WARN_THRESHOLD_MB = 2048
# 事件循环卡死检测：loop 连续 5 秒不执行 call_soon_threadsafe 排进去的
# 心跳，就认定线程卡在同步代码里，dump 全部线程栈到 crash.log。卡住
# 期间每 30 秒重 dump 一次（栈可能变化，2026-10-26 两次现场分别停摆
# 4 分钟和 9 分钟，且期间内存从 202MB 涨到 31.9GB）。
WATCHDOG_INTERVAL = 1.0
WATCHDOG_STUCK_SECONDS = 5.0
WATCHDOG_REPORT_INTERVAL = 30.0


def _memory_stats():
    """返回 (rss_mb, py_blocks)：当前常驻内存与 CPython 分配块数。

    2026-10-26 现场：物理 footprint 41GB、41955 个 1MB VM_ALLOCATE
    区域，而 malloc 各 zone 合计仅 30MB —— 膨胀的是 pymalloc arena。
    RSS 与 getallocatedblocks() 必须一起看才能区分成因：
      - 块数持续上涨        → 对象泄漏，去查长期存活的容器；
      - 块数平稳而 RSS 上涨 → arena 碎片化（长寿对象散落在各 arena
        中，短命对象释放后整块 arena 无法归还系统）。
    取不到值时返回 0，不影响诊断日志。
    """
    rss_mb = 0
    try:
        if sys.platform == "darwin":
            import ctypes

            class _TimeValue(ctypes.Structure):
                _fields_ = [
                    ("seconds", ctypes.c_int32),
                    ("microseconds", ctypes.c_int32),
                ]

            class _MachTaskBasicInfo(ctypes.Structure):
                _fields_ = [
                    ("virtual_size", ctypes.c_uint64),
                    ("resident_size", ctypes.c_uint64),
                    ("resident_size_max", ctypes.c_uint64),
                    ("user_time", _TimeValue),
                    ("system_time", _TimeValue),
                    ("policy", ctypes.c_int32),
                    ("suspend_count", ctypes.c_int32),
                ]

            libc = ctypes.CDLL(None)
            info = _MachTaskBasicInfo()
            count = ctypes.c_uint32(
                ctypes.sizeof(info) // ctypes.sizeof(ctypes.c_uint32)
            )
            task = ctypes.c_uint32.in_dll(libc, "mach_task_self_").value
            # MACH_TASK_BASIC_INFO = 20
            kr = libc.task_info(task, 20, ctypes.byref(info), ctypes.byref(count))
            if kr == 0:
                rss_mb = info.resident_size // (1024 * 1024)
        else:
            import resource

            rss_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
    except Exception:
        rss_mb = 0
    try:
        py_blocks = sys.getallocatedblocks()
    except Exception:
        py_blocks = 0
    return rss_mb, py_blocks


def _crash_log_path():
    """crash.log 的磁盘路径；logging 未初始化（测试）时返回 None。"""
    for handler in crash_logger.handlers:
        path = getattr(handler, "baseFilename", None)
        if path:
            return path
    return None


class _LoopWatchdog:
    """事件循环卡死检测：loop 连续数秒不处理回调就 dump 全部线程栈。

    2026-10-26 两次现场（16:34、17:21）事件循环都完全停摆 4~9 分钟，
    期间协程、访问日志、诊断日志全部停转，事后只能确认「卡了多久」，
    无法知道「卡在哪一行」。这里每秒用 call_soon_threadsafe 给 loop
    排一个心跳回调：回调迟迟不执行说明 loop 线程卡在同步代码里，直接
    faulthandler.dump_traceback 把所有线程栈写进 crash.log。
    """

    def __init__(self, loop, log_path, interval=WATCHDOG_INTERVAL,
                 stuck_after=WATCHDOG_STUCK_SECONDS,
                 report_interval=WATCHDOG_REPORT_INTERVAL):
        self._loop = loop
        self._log_path = log_path
        self._interval = interval
        self._stuck_after = stuck_after
        self._report_interval = report_interval
        self._last_beat = time.monotonic()
        self._last_report = 0.0
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if not self._log_path:
            return
        self._thread = threading.Thread(
            target=self._run, name="loop-watchdog", daemon=True
        )
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _beat(self):
        self._last_beat = time.monotonic()

    def _run(self):
        while not self._stop.wait(self._interval):
            try:
                self._loop.call_soon_threadsafe(self._beat)
            except RuntimeError:
                return  # loop 已关闭
            stalled = time.monotonic() - self._last_beat
            if stalled < self._stuck_after:
                continue
            now = time.monotonic()
            if now - self._last_report < self._report_interval:
                continue
            self._last_report = now
            self._dump(stalled)

    def _dump(self, stalled):
        try:
            with open(self._log_path, "a", encoding="utf-8") as fh:
                fh.write(
                    "\n=== event loop stalled %.1fs, dumping all thread "
                    "stacks ===\n" % stalled
                )
                fh.flush()
                faulthandler.dump_traceback(file=fh, all_threads=True)
                fh.write("=== end of stalled dump ===\n")
        except Exception:
            pass


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


class IdleDeadline:
    """一条连接（两个方向）共享的空闲截止时间。

    只有整条连接在两个方向上都持续没有字节流动才会到期。LLM 流式响应
    这类“客户端发完请求后长时间只收不发”的流量，出向会长时间空闲，
    但入向一直在流——按方向各自计时会误判为空闲并掐断连接
    （详见 300s 硬墙问题的定位）。
    """

    __slots__ = ("timeout", "_deadline", "_fired")

    def __init__(self, timeout):
        self.timeout = timeout
        self._deadline = time.monotonic() + self._base_timeout()
        self._fired = False

    def _base_timeout(self):
        # timeout=None 表示不设上限（仅供需要显式关闭的场景），避免
        # wait_for(inf) 被误读为“立即超时”。
        return float("inf") if self.timeout is None else self.timeout

    def touch(self):
        self._deadline = time.monotonic() + self._base_timeout()

    def remaining(self):
        return max(0.0, self._deadline - time.monotonic())

    def expire(self):
        """认领到期：只有第一个调用者返回 True。

        两个方向的 relay 都会从超时分支退出，共享同一个 deadline 时
        必须去重，否则一次空闲会重复上报（计数翻倍、日志重复）。
        """
        if self._fired:
            return False
        self._fired = True
        return True


async def relay(reader, writer, route=None, direction=None, on_activity=None,
                idle_timeout=RELAY_IDLE_TIMEOUT, on_idle_timeout=None, idle=None):
    # idle 由兄弟方向共享时，任一方向读到字节都会续命；不传则退化为
    # 单向计时（旧的单方向语义）。
    deadline = idle if idle is not None else IdleDeadline(idle_timeout)
    timed_out = False
    try:
        while True:
            try:
                data = await asyncio.wait_for(
                    reader.read(65536), timeout=deadline.remaining()
                )
            except asyncio.TimeoutError:
                # 到期瞬间兄弟方向可能刚续过命，重新看一次剩余时间，
                # 避免把刚有流量的连接误判为空闲。
                if deadline.remaining() > 0:
                    continue
                timed_out = True
                break
            if not data:
                break
            deadline.touch()
            writer.write(data)
            if on_activity:
                on_activity()
            if route and direction:
                add_bytes(len(data), route, direction)
            if writer.transport.get_write_buffer_size() > 65536:
                await writer.drain()
    except (ConnectionResetError, BrokenPipeError, OSError):
        pass
    finally:
        if timed_out and on_idle_timeout and deadline.expire():
            on_idle_timeout()
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
                try:
                    await asyncio.wait_for(
                        writer.wait_closed(), timeout=RELAY_EOF_WAIT_TIMEOUT
                    )
                except asyncio.TimeoutError:
                    _force_close_rst(writer)
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

    两种失败形状，可信度不同，分开处理：

    - EBADF (errno 9)：socket fd 在 connect 过程中被本机置为无效。网络故障
      作用在数据包上（SYN 无回应→超时、对端回 RST→拒绝、DNS 失败），
      都不可能让本地的 fd 失效；能在 connect 半途作废 fd 的只有本机的
      网络过滤扩展（如 AliEntSafe 的 networkFilter）。因此这是定性信号，
      单次即认定，不需要累计阈值。
    - ConnectionResetError：可能是 EDR 在 ClientHello 上注入 RST，也可能
      是网络中间设备或对端真的 RST，形状有歧义，仍需窗口内连续多次才怀疑。

    EDR 拦截是间歇性的（实测同一进程同一目标可在成功与 EBADF 之间反复，
    且按进程/策略区分，同机其他进程可能完全正常），所以 EBADF 的判定按
    时间衰减，不被无关的成功连接清除。
    """

    THRESHOLD = 3          # consecutive resets to trigger (ambiguous shape)
    WINDOW = 30            # seconds window for counting
    NOTIFY_COOLDOWN = 300  # seconds between notifications
    EBADF_STICKY = 60      # seconds a conclusive EBADF verdict stays valid

    def __init__(self, on_blocked=None, on_recovered=None):
        self._on_blocked = on_blocked  # callback(dest_addr, dest_port)
        self._on_recovered = on_recovered  # callback() when blocking clears
        self._reset_times = []         # timestamps of recent resets
        self._last_notify = 0
        self._notified = False         # 歧义信号（reset）已触发且未恢复
        self._block_notified = False   # 已向 UI 报过拦截（任一路径），等待恢复通知
        self._badfd_at = None          # monotonic time of last conclusive EBADF

    @property
    def blocked(self):
        """当前是否判定为 EDR 拦截（定性 EBADF 未过期，或歧义信号已触发）。"""
        if (
            self._badfd_at is not None
            and time.monotonic() - self._badfd_at < self.EBADF_STICKY
        ):
            return True
        return self._notified

    def record_reset(self, dest_addr, dest_port, errno_value=None):
        """Record an outbound connect failure (ConnectionResetError or EBADF)."""
        now = time.monotonic()

        if errno_value == errno.EBADF:
            # 定性信号：单次即认定，并只在上一轮判定已过期时重新告警
            expired = (
                self._badfd_at is None
                or now - self._badfd_at >= self.EBADF_STICKY
            )
            self._badfd_at = now
            if expired:
                self._notify(now, dest_addr, dest_port, "EBADF (fd invalidated locally)")
            return

        self._reset_times.append(now)
        # Keep only resets within the window
        cutoff = now - self.WINDOW
        self._reset_times = [t for t in self._reset_times if t > cutoff]

        if len(self._reset_times) >= self.THRESHOLD and not self._notified:
            if self._notify(
                now, dest_addr, dest_port,
                f"{len(self._reset_times)} consecutive ConnectionResetError",
            ):
                self._notified = True

    def _notify(self, now, dest_addr, dest_port, cause):
        """触发拦截告警，受 NOTIFY_COOLDOWN 限流。返回是否真的通知了。"""
        if now - self._last_notify <= self.NOTIFY_COOLDOWN:
            return False
        self._last_notify = now
        self._block_notified = True
        logger.warning(
            "EDR blocking suspected: %s on outbound connects (last: %s:%s)",
            cause, dest_addr, dest_port,
        )
        if self._on_blocked:
            self._on_blocked(dest_addr, dest_port)
        return True

    def record_success(self):
        """Record a successful outbound connect.

        只清除有歧义的 ConnectionResetError 怀疑。EBADF 是定性信号，不被
        无关的成功连接清除——EDR 按进程/行为间歇拦截时，直连成功与节点
        EBADF 会同时存在，用成功去清判定正是把「EDR 拦截」误报成
        「节点不通」的原因；它只按 EBADF_STICKY 时间衰减。

        恢复通知则在「已报过拦截且当前不再判定为拦截」时发出，两条路径
        共用，避免 EBADF 的 sticky UI 状态永远不清。
        """
        self._reset_times.clear()
        if self._notified:
            self._notified = False
        if self._block_notified and not self.blocked:
            self._block_notified = False
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
        await asyncio.wait_for(writer.wait_closed(), timeout=RELAY_EOF_WAIT_TIMEOUT)
    except asyncio.TimeoutError:
        _force_close_rst(writer)
    except (OSError, AttributeError, RuntimeError):
        pass


def _close_writer_force(writer):
    """立即 RST 关闭（SO_LINGER=0 + abort），不等对端 FIN。
    用于 stop 时清空上游连接池；有 transport 时走 RST，否则退化为 close。"""
    transport = getattr(writer, "transport", None)
    if transport is not None:
        _force_close_rst(writer)
    else:
        writer.close()


async def connect_upstream_socks5(
    server_config, dest_addr, dest_port, ssl_ctx=None, verify_cert_pin=None
):
    use_tls = server_config["tls"]
    reader, writer = await open_node_connection(
        server_config, use_tls=use_tls, ssl_ctx=ssl_ctx, timeout=CONNECT_TIMEOUT
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


async def connect_upstream_http(
    server_config, dest_addr, dest_port, ssl_ctx=None, verify_cert_pin=None
):
    use_tls = server_config["tls"]
    reader, writer = await open_node_connection(
        server_config, use_tls=use_tls, ssl_ctx=ssl_ctx, timeout=CONNECT_TIMEOUT
    )
    if verify_cert_pin and use_tls:
        verify_cert_pin(writer.get_extra_info("ssl_object"))
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
    username = server_config["username"]
    password = server_config["password"]
    use_tls = server_config["tls"]
    reader, writer = await open_node_connection(
        server_config, use_tls=use_tls, ssl_ctx=ssl_ctx, timeout=CONNECT_TIMEOUT
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


async def _open_direct(host, port):
    """直连 open_connection，EBADF（errno 9）失败自动重试一次。

    公司 EDR（如 AliEntSafe）会在握手期间让 socket fd 失效，表现为
    "Connect call failed" + errno 9。单次重试通常即可绕开这类注入。
    """
    last_exc = None
    for attempt in range(2):
        try:
            reader, writer = await asyncio.open_connection(host, port)
            _set_nodelay(writer)
            return reader, writer
        except OSError as exc:
            last_exc = exc
            if exc.errno != errno.EBADF or attempt == 1:
                raise
    raise last_exc


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
        return await _open_direct(dest_addr, dest_port)

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
            return await asyncio.wait_for(
                _open_direct(addr[0], addr[1]),
                timeout=DIRECT_CONNECT_TIMEOUT,
            )
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

# 全局活跃连接总量上限。信号量只覆盖建连阶段后，用它兜底防止
# fd/内存被无限多的长寿命连接耗尽（正常使用远达不到）。
TOTAL_CONNECTION_LIMIT = 2048
# 获取建连槽位的最长等待时间，超时快速失败而不是无限排队。
SETUP_ACQUIRE_TIMEOUT = 10.0
# TCP DNS（端口 53）的空闲超时：连接成功但查询永不回复的探测连接
# 会在 15s 内自动回收，不再挂满 300s。
DNS_TCP_IDLE_TIMEOUT = 15.0
# 单目标并发上限：53 端口收紧，普通目标放宽（避免误伤 CDN 高并发）。
TARGET_LIMIT_DEFAULT = 64
TARGET_LIMIT_PORT_53 = 8
# 诊断指标汇总周期。
DIAGNOSTICS_INTERVAL = 60.0


class RuntimeMetrics:
    """聚合代理运行时的排队/异常指标，供周期诊断日志输出。

    所有方法只在事件循环线程中调用，无需加锁。snapshot() 读取并
    清空累计值，使每条诊断日志都是“上一个周期内”的增量。
    """

    def __init__(self):
        self.setup_wait_count = 0
        self.setup_wait_total = 0.0
        self.setup_wait_max = 0.0
        self.setup_wait_slow = 0
        self.setup_timeout_rejects = 0
        self.total_ceiling_rejects = 0
        self.dns_idle_kills = 0
        self.relay_idle_kills = 0
        self.edr_badfd = 0
        self.active_peak = 0

    def record_setup_wait(self, wait_seconds):
        self.setup_wait_count += 1
        self.setup_wait_total += wait_seconds
        if wait_seconds > self.setup_wait_max:
            self.setup_wait_max = wait_seconds
        if wait_seconds >= 1.0:
            self.setup_wait_slow += 1

    def record_setup_timeout(self):
        self.setup_timeout_rejects += 1

    def record_total_ceiling_reject(self):
        self.total_ceiling_rejects += 1

    def record_dns_idle_kill(self):
        self.dns_idle_kills += 1

    def record_relay_idle_kill(self):
        self.relay_idle_kills += 1

    def record_edr_badfd(self):
        self.edr_badfd += 1

    def observe_active(self, count):
        if count > self.active_peak:
            self.active_peak = count

    def snapshot(self):
        count = self.setup_wait_count
        avg_ms = round(self.setup_wait_total / count * 1000.0) if count else 0
        data = {
            "setup_wait_count": count,
            "setup_wait_avg_ms": avg_ms,
            "setup_wait_max_ms": round(self.setup_wait_max * 1000.0),
            "setup_wait_slow": self.setup_wait_slow,
            "setup_timeout_rejects": self.setup_timeout_rejects,
            "total_ceiling_rejects": self.total_ceiling_rejects,
            "dns_idle_kills": self.dns_idle_kills,
            "relay_idle_kills": self.relay_idle_kills,
            "edr_badfd": self.edr_badfd,
            "active_peak": self.active_peak,
        }
        self.__init__()
        return data


class TargetAdmission:
    """单目标并发准入：限制同一 host:port 的并发连接数。

    异常流量（如连上但永不回复的 TCP DNS 探测）超限时会被快速拒绝，
    只消耗它自己的配额，无法拖垮全局连接表或建连队列。
    """

    def __init__(self, default_limit=TARGET_LIMIT_DEFAULT):
        self._default_limit = default_limit
        self._counts = {}
        self._rejected = {}

    @staticmethod
    def _key(host, port):
        try:
            host_key = str(host).lower()
        except Exception:
            host_key = ""
        try:
            port_key = int(port)
        except (TypeError, ValueError):
            port_key = 0
        return (host_key, port_key)

    def limit_for(self, port):
        try:
            port_int = int(port)
        except (TypeError, ValueError):
            port_int = 0
        if port_int == 53:
            return TARGET_LIMIT_PORT_53
        return self._default_limit

    def try_acquire(self, host, port):
        key = self._key(host, port)
        count = self._counts.get(key, 0)
        if count >= self.limit_for(port):
            self._rejected[key] = self._rejected.get(key, 0) + 1
            return False
        self._counts[key] = count + 1
        return True

    def release(self, host, port):
        key = self._key(host, port)
        count = self._counts.get(key, 0)
        if count <= 1:
            self._counts.pop(key, None)
        else:
            self._counts[key] = count - 1

    def snapshot(self):
        top_active = sorted(
            self._counts.items(), key=lambda kv: kv[1], reverse=True
        )[:5]
        top_rejected = sorted(
            self._rejected.items(), key=lambda kv: kv[1], reverse=True
        )[:5]
        return {
            "active_total": sum(self._counts.values()),
            "active_top": [
                {"target": f"{host}:{port}", "count": count}
                for (host, port), count in top_active
            ],
            "rejected_total": sum(self._rejected.values()),
            "rejected_top": [
                {"target": f"{host}:{port}", "count": count}
                for (host, port), count in top_rejected
            ],
        }


POOL_SIZE = 3
POOL_CHECK_INTERVAL = 1.0
POOL_CONNECT_TIMEOUT = 8
_POOL_ZOMBIE = object()


class UpstreamPool:
    def __init__(self, server_config, ssl_ctx, verify_cert_pin=None):
        self._server_config = server_config
        self._ssl_ctx = ssl_ctx
        self._verify_cert_pin = verify_cert_pin
        self._pool = asyncio.Queue(maxsize=POOL_SIZE)
        self._running = False
        self._task = None

    async def start(self):
        if self._task is not None:
            return
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
                entry = self._pool.get_nowait()
            except asyncio.QueueEmpty:
                break
            self._pool.task_done()
            if entry is _POOL_ZOMBIE:
                continue
            _, writer = entry
            _close_writer_force(writer)

    def _tracks_tls_preconnects(self):
        protocol = self._server_config.get("protocol", "socks5")
        return protocol in ("socks5", "http") and bool(self._server_config.get("tls"))

    async def _mark_closed_preconnects(self):
        if not self._tracks_tls_preconnects():
            return

        entries = []
        while not self._pool.empty():
            try:
                entry = self._pool.get_nowait()
            except asyncio.QueueEmpty:
                break
            self._pool.task_done()
            entries.append(entry)

        stale_writers = []
        for entry in entries:
            if entry is _POOL_ZOMBIE:
                self._pool.put_nowait(entry)
                continue
            reader, writer = entry
            if writer.is_closing() or reader.at_eof():
                self._pool.put_nowait(_POOL_ZOMBIE)
                stale_writers.append(writer)
            else:
                self._pool.put_nowait(entry)

        for writer in stale_writers:
            logger.debug("discarding closed TLS preconnect")
            await _close_writer(writer)

    async def _maintain(self):
        while self._running:
            await self._mark_closed_preconnects()
            if self._pool.qsize() < POOL_SIZE:
                try:
                    reader, writer = await self.create_connection()
                    await self._pool.put((reader, writer))
                except Exception as exc:
                    logger.debug("upstream preconnect failed: %s", exc)
            await asyncio.sleep(POOL_CHECK_INTERVAL)

    async def create_connection(self):
        protocol = self._server_config.get("protocol", "socks5")
        use_tls = bool(self._server_config["tls"]) if protocol in ("socks5", "http") else False
        reader, writer = await open_node_connection(
            self._server_config,
            use_tls=use_tls,
            ssl_ctx=self._ssl_ctx,
            timeout=POOL_CONNECT_TIMEOUT,
        )
        if self._verify_cert_pin and use_tls:
            self._verify_cert_pin(writer.get_extra_info("ssl_object"))
        _set_nodelay(writer)
        return reader, writer

    async def acquire(self):
        while not self._pool.empty():
            try:
                entry = self._pool.get_nowait()
            except asyncio.QueueEmpty:
                break
            self._pool.task_done()
            if entry is _POOL_ZOMBIE:
                continue
            reader, writer = entry
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
        # start()/stop() 共用同一把可重入锁：两路重启（唤醒回调线程与
        # 健康检查线程）交错会在同一进程里造出两个事件循环。
        self._lifecycle_lock = threading.RLock()
        # stop() 时没能退出的旧事件循环线程（唤醒后 loop 僵住的现场）。
        # 只要它还活着就拒绝 start()，否则新旧两个循环共享 self.* 的
        # 任务句柄与 server 引用。_since 记录首次被记为孤儿的 monotonic
        # 时间，供调用方按存活时长决定「继续重试」还是「放弃并提示重启」。
        self._orphan_thread = None
        self._orphan_thread_since = None
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
        self._h2_pool = None
        self._h2_ssl_ctx = None
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
        # 统计刷新协程句柄，stop 时先取消，避免残留任务在新 loop 上
        # 继续调度 flush_stats
        self._stats_task = None
        self._metrics = RuntimeMetrics()
        self._target_admission = TargetAdmission()
        self._diagnostics_task = None
        # 事件循环心跳看门狗：卡死时把线程栈 dump 进 crash.log
        self._watchdog = None
        # RSS 超阈值告警的限流时间戳（monotonic），避免每分钟刷 crash.log
        self._last_rss_warn = 0.0
        # 端口冲突导致的漂移记录（None 表示按配置端口正常监听）
        self._port_fallback = None

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
            self._h2_ssl_ctx = None
            return
        self._cert_bind_enabled = bool(server.get("certBindEnabled", False))
        self._cert_pin = server.get("certPin", "") or ""
        self._cert_pin_mismatch_reported = bool(server.get("certPinMismatch", False))
        ctx = ssl.create_default_context()
        if server["allowInsecure"]:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        self._ssl_ctx = ctx
        # h2 必须用独立的 SSLContext：基础上下文一旦宣告 ALPN，健康检查、
        # 延迟探测等 HTTP/1.1 路径会被协商成 h2 而解析失败。
        self._h2_ssl_ctx = None
        if server.get("protocol") == "http" and H2_AVAILABLE:
            h2_ctx = ssl.create_default_context()
            if server["allowInsecure"]:
                h2_ctx.check_hostname = False
                h2_ctx.verify_mode = ssl.CERT_NONE
            h2_ctx.set_alpn_protocols(["h2", "http/1.1"])
            self._h2_ssl_ctx = h2_ctx

    def start(self, user_config, config_dir=None):
        with self._lifecycle_lock:
            self._start_locked(user_config, config_dir)

    def _reject_live_orphan_thread(self):
        stuck = self._orphan_thread
        if stuck is None:
            return
        if stuck.is_alive():
            since = self._orphan_thread_since
            # 未记录起点（直接注入墓碑的旧路径 / 测试）视为刚僵住
            age = time.monotonic() - since if since is not None else 0.0
            raise ProxyThreadStuckError(age)
        self._orphan_thread = None
        self._orphan_thread_since = None

    def _start_locked(self, user_config, config_dir=None):
        if self._running:
            self.stop()
        # 内部 stop() 可能刚把一个僵住的线程记成孤儿：此时不能再起新循环
        self._reject_live_orphan_thread()

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
        # 干净启动前先清掉上一轮的漂移标记，_start_local_proxy 命中
        # EADDRINUSE 时再重新记录。
        self._port_fallback = None
        self._build_ssl_context()
        self._edr_detector = EdrBlockDetector(
            on_blocked=self._on_edr_blocked,
            on_recovered=self._on_edr_recovered,
        )

        # Initialize routing engine (geodata loaded selectively in RoutingEngine.__init__)
        from routing import RoutingEngine, _geodata_dir
        routing_config = user_config.get("routing", {})
        self._routing = RoutingEngine(routing_config, _geodata_dir())

        loop = asyncio.new_event_loop()
        self._loop = loop
        started = threading.Event()
        self._start_error = None
        # loop 必须随线程参数传入：_run_loop 若读 self._loop，两路 start()
        # 交错时线程会去跑另一个线程已 run_forever 的 loop（历史上表现为
        # "This event loop is already running"，并留下无人回收的旧循环）。
        self._thread = threading.Thread(
            target=self._run_loop, args=(loop, started), daemon=True
        )
        self._thread.start()
        started.wait(timeout=5)
        if self._start_error:
            raise self._start_error
        self._running = True

    def stop(self):
        with self._lifecycle_lock:
            self._running = False
            loop = self._loop
            thread = self._thread

            if loop and loop.is_running():
                # 收尾协程只做清理，不在协程内调用 loop.stop()：
                # loop.stop() 会让 run_forever 在 future 完成回调执行前
                # 退出，run_coroutine_threadsafe(...).result() 永远超时，
                # 每次 stop 固定白等 8s。协程正常返回 → future 正常
                # resolve，调用方在 finally 里再停 loop。
                async def _shutdown():
                    await self._stop_servers()
                try:
                    asyncio.run_coroutine_threadsafe(_shutdown(), loop).result(
                        timeout=LOCAL_PROXY_STOP_WAIT_TIMEOUT * 2 + 2
                    )
                except Exception:
                    # 仅剩的安全网：僵尸锁等极端情况超时，强制关 socket
                    # 释放端口，保证 stop() 必然完成
                    logger.warning("proxy shutdown timed out, forcing close", exc_info=True)
                    self._close_listen_sockets()
                finally:
                    # future 已 resolve（或已放弃等待），此时停 loop 不会再
                    # 吞掉任何回调；call_soon_threadsafe 保证线程安全
                    if loop.is_running():
                        loop.call_soon_threadsafe(loop.stop)

                # _server_sockets 必须留到线程真正退出后再清：下面
                # thread.join() 超时分支还要靠它做最后一次强制关闭。
                # 修复前这里无条件清空，那条兜底遍历的一直是空列表。
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
                    self._close_listen_sockets()
                    logger.warning("proxy thread did not exit in time, forced server socket close")

            if thread is not None and thread.is_alive():
                # 唤醒后 loop 僵住时，_shutdown 协程排不进队列，线程也就退不掉。
                # 这里留作墓碑而不是直接丢弃：再 start() 会造出第二个事件循环，
                # 两个循环共享任务句柄 / server 引用，历史上表现为跨 loop 取消、
                # 端口漂移 1081/1088，最终在异常回溯链析构时把线程栈打穿闪退。
                # 只记首次僵住时间：stop() 可能被多次调用（健康检查每轮
                # 都会先 stop 再 start），重复重置会让存活时长永远归零。
                if self._orphan_thread is not thread:
                    self._orphan_thread_since = time.monotonic()
                self._orphan_thread = thread
                logger.error(
                    "proxy event loop thread is still alive after stop; "
                    "refusing further starts until it exits"
                )
            # 线程已退出（或已放弃等待），清空 socket 引用，防止新 loop
            # 误操作（跨 loop server 引用会抛 RuntimeError + EADDRINUSE 漂移）
            self._server_sockets = []
            self._loop = None
            self._thread = None

    def is_running(self):
        thread = self._thread
        return self._running and thread is not None and thread.is_alive()

    def orphan_thread_alive(self):
        """stop() 放弃的旧事件循环线程是否仍活着。

        stop() 会清空 _thread，is_running() 因此恒为 False。健康检查
        若只看 is_running()，会把「孤儿还活着、只是没人接手」误报成
        「Proxy thread died」（2026-10-26 17:26:08 现场）。
        """
        stuck = self._orphan_thread
        return stuck is not None and stuck.is_alive()

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

        use_tls = self._server_config["tls"]

        start = time.monotonic()
        reader = None
        writer = None
        try:
            reader, writer = await open_node_connection(
                self._server_config,
                use_tls=use_tls,
                ssl_ctx=self._ssl_ctx,
                timeout=5,
            )

            if protocol in ("socks5", "http") and use_tls:
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
                OSError, asyncio.TimeoutError, TimeoutError) as exc:
            # EBADF 是定性信号：网络故障造不出「本地 fd 失效」这个形状，
            # 所以这是本机 EDR 拦截，不是节点真的不可达。
            # （TimeoutError 是 OSError 子类但 errno 为 None，仍走 unreachable。）
            if isinstance(exc, OSError) and exc.errno == errno.EBADF:
                if self._edr_detector:
                    self._edr_detector.record_reset(
                        self._server_config.get("address", "?"),
                        self._server_config.get("port", 0),
                        errno_value=exc.errno,
                    )
                return (None, "edr_blocked")
            return (None, "unreachable")
        except Exception:
            return (None, "error")
        finally:
            if writer:
                writer.close()
                try:
                    await asyncio.wait_for(
                        writer.wait_closed(), timeout=RELAY_EOF_WAIT_TIMEOUT
                    )
                except asyncio.TimeoutError:
                    _force_close_rst(writer)
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

    def _run_loop(self, loop, started_event):
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._start_servers())
        except OSError as e:
            self._start_error = e
            started_event.set()
            return
        started_event.set()
        loop.run_forever()

    async def _start_servers(self):
        self._metrics = RuntimeMetrics()
        self._target_admission = TargetAdmission()
        self._semaphore = asyncio.Semaphore(MAX_CONCURRENT)
        init_writer()
        self._stats_task = asyncio.ensure_future(self._flush_stats_loop())
        self._active_connections = 0
        self._mark_proxy_activity()
        self._diagnostics_task = asyncio.ensure_future(self._diagnostics_loop())
        self._watchdog = _LoopWatchdog(asyncio.get_running_loop(), _crash_log_path())
        self._watchdog.start()
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
        self._h2_pool = None
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
                    if protocol == "http" and self._h2_ssl_ctx is not None:
                        # HTTP/2 生效时不预连 HTTP/1.1 套接字：降级时才开始
                        self._h2_pool = H2UpstreamPool(
                            self._server_config, self._h2_ssl_ctx,
                            verify_cert_pin=self._verify_cert_pin if self._cert_bind_enabled else None,
                        )
                        await self._h2_pool.start()
                    else:
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
                    self._record_port_fallback(
                        attempt + 1,
                        self._configured_socks_port,
                        self._configured_http_port,
                    )
                else:
                    raise

    async def _stop_servers(self):
        if self._watchdog is not None:
            self._watchdog.stop()
            self._watchdog = None
        if self._stats_task and self._stats_task is not asyncio.current_task():
            self._stats_task.cancel()
            try:
                await self._stats_task
            except asyncio.CancelledError:
                pass
        self._stats_task = None
        if self._diagnostics_task and self._diagnostics_task is not asyncio.current_task():
            self._diagnostics_task.cancel()
            try:
                await self._diagnostics_task
            except asyncio.CancelledError:
                pass
        self._diagnostics_task = None
        if self._recycle_task and self._recycle_task is not asyncio.current_task():
            self._recycle_task.cancel()
            try:
                await self._recycle_task
            except asyncio.CancelledError:
                pass
        self._recycle_task = None
        try:
            # 整体限时：等待锁被僵尸协程释放 + 关闭 server 收尾，
            # 超时强制关 socket 释放端口，保证 stop() 必然快速完成。
            # 正常路径在 force_abort 下亚秒完成，此超时只兜底异常。
            await asyncio.wait_for(
                self._stop_local_proxy_locked(force_abort=True),
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

    async def _stop_local_proxy_locked(self, force_abort=True):
        async with self._get_local_proxy_lock():
            await self._stop_local_proxy(force_abort=force_abort)

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

    async def _stop_local_proxy(self, force_abort=True):
        if force_abort:
            # 全量 stop 才主动断开活跃连接（用户点“关闭代理”即预期断开）。
            # 各 handler 立即收尾，server.wait_closed() 不再等待
            # keep-alive / 探测连接自然结束，3s 限时退化为纯安全网。
            for transport in list(self._active_transports):
                try:
                    transport.abort()
                except (OSError, RuntimeError):
                    pass
        # 先同步关 listen socket，再做任何 await。
        # 端口释放只依赖 close()，而 recycle 外层 wait_for 会把协程在第一个
        # await 点取消（现场：EDR 探测风暴下卡在 _upstream_pool.stop()）——
        # 若 close() 排在 await 之后，旧 listener 就永久泄漏：内核继续完成
        # 三次握手但无人 accept，accept 队列塞满后新连接一律 ETIMEDOUT。
        self._close_listen_sockets()
        if self._h2_pool:
            h2_pool, self._h2_pool = self._h2_pool, None
            try:
                await h2_pool.stop()
            except (OSError, RuntimeError):
                pass
        if self._upstream_pool:
            pool, self._upstream_pool = self._upstream_pool, None
            try:
                await pool.stop()
            except (OSError, RuntimeError):
                pass
        if self._socks_server:
            await self._close_server_limited(self._socks_server)
            self._socks_server = None
        if self._http_server:
            await self._close_server_limited(self._http_server)
            self._http_server = None
        self._server_sockets = []

    def _close_listen_sockets(self):
        """幂等地同步关闭两个 listen server，释放端口。

        server.close() 是同步的（只关 listen socket），对端的活跃连接由
        各自 handler 收尾；因此这里不 await，取消/异常都不会漏关端口。
        `_server_sockets` 里的 `asyncio.TransportSocket` 没有 `close()`，
        且只在 server 对象已被丢弃（stop() 超时兜底）时才需要，故取底层
        socket 关闭作为补充。
        """
        for server in (self._socks_server, self._http_server):
            if not server:
                continue
            try:
                server.close()
            except (OSError, RuntimeError):
                pass
        for sock in self._server_sockets:
            raw = getattr(sock, "_sock", sock)
            try:
                raw.close()
            except (OSError, AttributeError):
                pass

    def _clear_port_fallback(self):
        self._port_fallback = None

    def _record_port_fallback(self, attempt, configured_socks, configured_http):
        self._port_fallback = {
            "attempt": attempt,
            "configured_socks": configured_socks,
            "configured_http": configured_http,
            "socks": self._socks_port,
            "http": self._http_port,
        }
        crash_logger.warning(
            "local proxy ports %d/%d in use, fell back to %d/%d",
            configured_socks, configured_http, self._socks_port, self._http_port,
        )

    @property
    def port_fallback(self):
        """端口冲突导致的漂移记录；None 表示按配置端口正常监听。"""
        return self._port_fallback

    def port_fallback_message(self):
        info = self._port_fallback
        if not info:
            return None
        return (
            f"端口被占用，已改用 {info['socks']}/{info['http']} "
            f"（配置为 {info['configured_socks']}/{info['configured_http']}）"
        )

    def _mark_proxy_activity(self):
        self._last_proxy_activity = time.monotonic()

    def _connection_started(self):
        self._active_connections += 1
        self._metrics.observe_active(self._active_connections)
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
        await self._stop_local_proxy(force_abort=False)
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

    async def _acquire_setup_slot(self):
        """获取建连槽位，带超时与排队时长打点。

        槽位只在建连阶段持有（见 _handle_http/_handle_socks），
        超时后快速失败，避免异常流量把真实请求堵在队列里。
        """
        if self._semaphore is None:
            return
        started = time.monotonic()
        try:
            await asyncio.wait_for(
                self._semaphore.acquire(), timeout=SETUP_ACQUIRE_TIMEOUT
            )
        except asyncio.TimeoutError:
            self._metrics.record_setup_timeout()
            raise
        self._metrics.record_setup_wait(time.monotonic() - started)

    def _release_setup_slot(self):
        if self._semaphore is not None:
            self._semaphore.release()

    async def _close_client_writer(self, writer):
        """有界关闭客户端侧 writer：对端不回 FIN 时超时 RST。

        避免 handler 卡在无限 wait_closed()，杜绝 CLOSED fd 与
        FIN_WAIT_2 堆积。
        """
        try:
            writer.close()
            try:
                await asyncio.wait_for(
                    writer.wait_closed(), timeout=RELAY_EOF_WAIT_TIMEOUT
                )
            except asyncio.TimeoutError:
                _force_close_rst(writer)
        except (OSError, RuntimeError, AttributeError):
            pass

    @staticmethod
    async def _write_http_503(client_writer):
        try:
            client_writer.write(
                b"HTTP/1.1 503 Service Unavailable\r\n"
                b"Content-Length: 0\r\nConnection: close\r\n\r\n"
            )
            await client_writer.drain()
        except OSError:
            pass

    @staticmethod
    def _relay_idle_timeout(port):
        try:
            port_int = int(port)
        except (TypeError, ValueError):
            port_int = 0
        if port_int == 53:
            return DNS_TCP_IDLE_TIMEOUT
        return RELAY_IDLE_TIMEOUT

    def _on_relay_idle_timeout(self, dest, port):
        """空闲超时回收一条连接。

        非 53 端口的超时以前完全静默（只有 DNS 计数），排障时无法从
        日志看出连接被代理自己掐掉。现在两者都记：53 端口沿用
        dns_idle_kills，其余计入 relay_idle_kills 并落一条 access log。
        """
        try:
            port_int = int(port)
        except (TypeError, ValueError):
            port_int = 0
        if port_int == 53:
            self._metrics.record_dns_idle_kill()
            return
        self._metrics.record_relay_idle_kill()
        access_logger.info(
            "IDLE | %s:%d | relay-idle-kill | timeout=%ss",
            dest, port_int, self._relay_idle_timeout(port_int),
        )

    async def _diagnostics_loop(self):
        while True:
            await asyncio.sleep(DIAGNOSTICS_INTERVAL)
            try:
                self._log_diagnostics()
            except Exception:
                crash_logger.warning("diagnostics logging failed", exc_info=True)

    def _log_diagnostics(self):
        metrics = self._metrics.snapshot()
        admission = self._target_admission.snapshot()
        rss_mb, py_blocks = _memory_stats()
        self._warn_if_memory_bloated(rss_mb, py_blocks)
        active_top = ",".join(
            f"{entry['target']}={entry['count']}" for entry in admission["active_top"]
        )
        rejected_top = ",".join(
            f"{entry['target']}={entry['count']}" for entry in admission["rejected_top"]
        )
        diagnostics_logger.info(
            "fd=%d rss_mb=%d py_blocks=%d active=%d active_peak=%d "
            "setup_wait_n=%d setup_wait_avg_ms=%d "
            "setup_wait_max_ms=%d setup_wait_slow=%d setup_timeout_rejects=%d "
            "total_ceiling_rejects=%d dns_idle_kills=%d relay_idle_kills=%d edr_badfd=%d "
            "target_active=%d target_active_top=%s target_rejected_total=%d "
            "target_rejected_top=%s",
            self.fd_count(),
            rss_mb,
            py_blocks,
            self._active_connections,
            metrics["active_peak"],
            metrics["setup_wait_count"],
            metrics["setup_wait_avg_ms"],
            metrics["setup_wait_max_ms"],
            metrics["setup_wait_slow"],
            metrics["setup_timeout_rejects"],
            metrics["total_ceiling_rejects"],
            metrics["dns_idle_kills"],
            metrics["relay_idle_kills"],
            metrics["edr_badfd"],
            admission["active_total"],
            active_top or "-",
            admission["rejected_total"],
            rejected_top or "-",
        )

    def _warn_if_memory_bloated(self, rss_mb, py_blocks):
        """RSS 超阈值时往 crash.log 留痕（10 分钟限流）。

        diagnostics.log 每分钟一条、按天滚动，排障时不会主动翻；
        crash.log 才是出问题时会看的地方。2026-10-26 的 41GB 现场里
        磁盘上没有任何内存告警，只能事后 vmmap 才看出来。
        """
        if rss_mb < RSS_WARN_THRESHOLD_MB:
            return
        now = time.monotonic()
        if now - self._last_rss_warn < 600:
            return
        self._last_rss_warn = now
        crash_logger.warning(
            "high memory: rss=%dMB py_blocks=%d active=%d (threshold %dMB)",
            rss_mb,
            py_blocks,
            self._active_connections,
            RSS_WARN_THRESHOLD_MB,
        )

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
        except OSError as e:
            if e.errno == errno.EBADF:
                self._metrics.record_edr_badfd()
                if self._edr_detector:
                    self._edr_detector.record_reset(
                        dest_addr, dest_port, errno_value=e.errno
                    )
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
            if self._h2_pool is not None and not self._h2_pool.disabled:
                pair = await self._h2_pool.connect(dest_addr, dest_port)
                if pair is not None:
                    return pair
                # 服务端没协商到 h2：本代配置内不再尝试，改用 HTTP/1.1 路径
                if self._upstream_pool is not None:
                    await self._upstream_pool.start()
            if self._upstream_pool:
                return await self._connect_with_pool(
                    dest_addr, dest_port, _http_connect_handshake
                )
            return await connect_upstream_http(
                self._server_config, dest_addr, dest_port,
                ssl_ctx=self._ssl_ctx,
                verify_cert_pin=self._verify_cert_pin,
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
            if self._active_connections >= TOTAL_CONNECTION_LIMIT:
                self._metrics.record_total_ceiling_reject()
                await self._close_client_writer(client_writer)
                return
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
            if not self._target_admission.try_acquire(dest_addr, dest_port):
                _log_access(dest_addr, dest_port, "CONNECT", direct, "target-limit")
                client_writer.write(b"\x05\x01\x00\x01" + b"\x00" * 4 + b"\x00\x00")
                try:
                    await client_writer.drain()
                except OSError:
                    pass
                return

            slot_held = False
            try:
                try:
                    await self._acquire_setup_slot()
                    slot_held = True
                except asyncio.TimeoutError:
                    _log_access(dest_addr, dest_port, "CONNECT", direct, "setup-busy")
                    client_writer.write(b"\x05\x01\x00\x01" + b"\x00" * 4 + b"\x00\x00")
                    try:
                        await client_writer.drain()
                    except OSError:
                        pass
                    return
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

                    idle_timeout = self._relay_idle_timeout(dest_port)
                    idle = IdleDeadline(idle_timeout)
                    await asyncio.gather(
                        relay(client_reader, remote_writer, route, "outbound",
                              self._mark_proxy_activity, idle=idle,
                              on_idle_timeout=lambda: self._on_relay_idle_timeout(dest_addr, dest_port)),
                        relay(remote_reader, client_writer, route, "inbound",
                              self._mark_proxy_activity, idle=idle,
                              on_idle_timeout=lambda: self._on_relay_idle_timeout(dest_addr, dest_port)),
                    )
                finally:
                    # 与 HTTP 分支同理：握手后客户端立即断开时兜底关闭 remote_writer
                    if not relay_started:
                        _force_close_rst(remote_writer)
            finally:
                if slot_held:
                    self._release_setup_slot()
                self._target_admission.release(dest_addr, dest_port)
        except asyncio.IncompleteReadError:
            return
        except Exception as e:
            if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                crash_logger.warning("SOCKS5 handler unexpected error", exc_info=True)
        finally:
            await self._close_client_writer(client_writer)

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
            await self._close_client_writer(client_writer)

    async def _handle_http(self, client_reader, client_writer):
        transport = client_writer.transport
        self._active_transports.add(transport)
        try:
            if self._active_connections >= TOTAL_CONNECTION_LIMIT:
                self._metrics.record_total_ceiling_reject()
                await self._write_http_503(client_writer)
                await self._close_client_writer(client_writer)
                return
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
                if not self._target_admission.try_acquire(host, port):
                    _log_access(host, port, "CONNECT", direct, "target-limit")
                    await self._write_http_503(client_writer)
                    return

                slot_held = False
                try:
                    try:
                        await self._acquire_setup_slot()
                        slot_held = True
                    except asyncio.TimeoutError:
                        _log_access(host, port, "CONNECT", direct, "setup-busy")
                        await self._write_http_503(client_writer)
                        return
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

                        idle_timeout = self._relay_idle_timeout(port)
                        idle = IdleDeadline(idle_timeout)
                        await asyncio.gather(
                            relay(client_reader, remote_writer, route, "outbound",
                                  self._mark_proxy_activity, idle=idle,
                                  on_idle_timeout=lambda: self._on_relay_idle_timeout(host, port)),
                            relay(remote_reader, client_writer, route, "inbound",
                                  self._mark_proxy_activity, idle=idle,
                                  on_idle_timeout=lambda: self._on_relay_idle_timeout(host, port)),
                        )
                    finally:
                        # 客户端在握手后立即断开（如探测连接）时，drain 抛异常
                        # 会跳过 relay，remote_writer 必须在此兜底关闭，防止 fd 泄漏
                        if not relay_started:
                            _force_close_rst(remote_writer)
                finally:
                    if slot_held:
                        self._release_setup_slot()
                    self._target_admission.release(host, port)
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
                    if not self._target_admission.try_acquire(host, port):
                        _log_access(host, port, method, direct, "target-limit")
                        await self._write_http_503(client_writer)
                        return

                    slot_held = False
                    try:
                        try:
                            await self._acquire_setup_slot()
                            slot_held = True
                        except asyncio.TimeoutError:
                            _log_access(host, port, method, direct, "setup-busy")
                            await self._write_http_503(client_writer)
                            return
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

                            idle_timeout = self._relay_idle_timeout(port)
                            idle = IdleDeadline(idle_timeout)
                            await asyncio.gather(
                                relay(remote_reader, client_writer, route, "inbound",
                                      self._mark_proxy_activity, idle=idle,
                                      on_idle_timeout=lambda: self._on_relay_idle_timeout(host, port)),
                                relay(client_reader, remote_writer, route, "outbound",
                                      self._mark_proxy_activity, idle=idle,
                                      on_idle_timeout=lambda: self._on_relay_idle_timeout(host, port)),
                            )
                        finally:
                            if not relay_started:
                                _force_close_rst(remote_writer)
                    finally:
                        if slot_held:
                            self._release_setup_slot()
                        self._target_admission.release(host, port)
                else:
                    client_writer.close()
                    return
        except Exception as e:
            if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                crash_logger.warning("HTTP handler unexpected error", exc_info=True)
        finally:
            await self._close_client_writer(client_writer)
