"""节点连接：DoH 解析 → 多 IP 尝试 → TLS SNI 先试后降级。

部分企业安全软件（实测为阿里的 Aliedr 网络过滤扩展）会按 TLS
ClientHello 里的 SNI 域名注入 RST：TCP 握手正常（节点 RTT 数十毫秒），
但 ClientHello 发出后 6~10ms 内就收到本地伪造的 RST，与目标 IP 的 RTT
无关；同一个 IP 换别的 SNI 立刻恢复正常。拦截依据是 SNI 字符串，不是 IP。

节点服务端用固定证书、不靠 SNI 选证书（socks5/server.js 用
tls.createServer 加单张证书），因此可以退化成不发 SNI：把
server_hostname 传成 IP 字面量时，Python 按 RFC 6066 不发送 SNI 扩展，
服务端给出的证书与 certPin(TOFU) 校验结果都不变。降级只在关闭主机名校验
（allowInsecure）时可用；成功后记入进程内集合，同一域名后续直接跳过 SNI。

地址选择策略（避免持续 DoH 查询，同时保证用的是最新 IP）：

- 连接成功 → 钉住这个 IP 继续用，不做周期性解析；
- 连接失败 → 强制重新解析一次，用新 IP 再试一轮；仍失败即确定失败，
  在此后的复查周期内不再发起 DoH（连接池每秒重试也只走本地尝试）；
- 每 1 小时复查一次解析结果，看 IP 是否变化。
"""

import asyncio
import threading
import time

from logger import crash_logger
from doh_resolver import resolve_node_address

DEFAULT_CONNECT_TIMEOUT = 10

# 钉住的 IP 仍可用时的复查间隔：到点重新解析一次，看 IP 是否变化。
HOURLY_RECHECK_INTERVAL = 3600.0

# 已确认按 SNI 被拦截、需要不发 SNI 的节点域名（进程内记忆）
_sni_suppressed = set()


class _NodeState:
    """某个节点域名当前的地址状态。"""

    __slots__ = ("connect_host", "server_hostname", "all_hosts",
                 "checked_at", "failure_retry_at")

    def __init__(self, connect_host, server_hostname, all_hosts):
        self.connect_host = connect_host
        self.server_hostname = server_hostname
        self.all_hosts = list(all_hosts)
        # 最近一次向 DoH 查询的时间（无论成败）：每小时复查的基准，
        # 同时防止 DoH 故障时每次重试都发查询。
        self.checked_at = None
        # 最近一次“连接失败后强制重解析”的时间：每小时最多一次，
        # 避免节点不可达时连接池的重试变成 DoH 风暴。None 表示从未重试过。
        self.failure_retry_at = None


_node_states = {}
_state_lock = threading.Lock()


def _get_state(host):
    with _state_lock:
        return _node_states.get(host)


def _update_state(host, resolved=None, *, checked_at=None, failure_retry_at=None):
    """就地更新状态，保留未涉及的时间戳（否则每小时复查会被不断推后）。"""
    with _state_lock:
        state = _node_states.get(host)
        if state is None:
            state = _NodeState(
                resolved.connect_host, resolved.server_hostname, resolved.all_hosts
            )
            _node_states[host] = state
        elif resolved is not None:
            state.connect_host = resolved.connect_host
            state.server_hostname = resolved.server_hostname
            state.all_hosts = list(resolved.all_hosts)
        if checked_at is not None:
            state.checked_at = checked_at
        if failure_retry_at is not None:
            state.failure_retry_at = failure_retry_at
        return state


def clear_node_states():
    """清空地址状态与 SNI 降级记忆（测试与手动重试用）。"""
    with _state_lock:
        _node_states.clear()
    _sni_suppressed.clear()


# 兼容旧命名：按“降级记忆”语义使用
def clear_sni_suppression():
    clear_node_states()


def can_suppress_sni(ssl_ctx):
    """关闭主机名校验时才允许不发 SNI，否则握手必然失败。"""
    return not getattr(ssl_ctx, "check_hostname", True)


def is_sni_suppressed(host):
    return str(host).strip() in _sni_suppressed


def remember_sni_suppression(host):
    host = str(host).strip()
    if not host or host in _sni_suppressed:
        return
    _sni_suppressed.add(host)
    crash_logger.warning(
        "TLS SNI for %s is blocked locally (RST injected on ClientHello); "
        "suppressing SNI for this session",
        host,
    )


async def connect_with_sni_fallback(host, connect_host, make_connection, ssl_ctx):
    """在「带 SNI」与「不发 SNI」之间做先试后降级。

    make_connection(server_hostname) 返回可等待的连接结果。传 IP 字面量时
    Python 不发 SNI 扩展；只有 ClientHello 被 RST 才算命中 SNI 拦截。
    """
    host = str(host).strip()
    if host == connect_host or is_sni_suppressed(host):
        # 目标本身就是 IP（本来就没有 SNI），或已确认该域名需要降级
        return await make_connection(connect_host)

    try:
        return await make_connection(host)
    except ConnectionResetError as exc:
        if not can_suppress_sni(ssl_ctx):
            raise
        first_exc = exc

    try:
        result = await make_connection(connect_host)
    except Exception:
        # 降级也失败：上报原始 RST，交给上层按原有的失败路径处理
        raise first_exc
    remember_sni_suppression(host)
    return result


async def _try_hosts(state, attempt, hosts):
    """依次尝试 hosts 里的每个 IP；成功则钉住该 IP 并返回。"""
    last_exc = None
    for connect_host in hosts:
        try:
            result = await attempt(connect_host, state.server_hostname)
        except (OSError, asyncio.TimeoutError) as exc:
            last_exc = exc
            continue
        state.connect_host = connect_host
        return result
    if last_exc is not None:
        raise last_exc
    raise OSError("no node address to try")


async def for_each_node_address(host, attempt):
    """选择可用 IP 连接节点，避免持续的 DoH 查询。

    - IP 连通：钉住它一直用，不做周期性解析（每小时的复查也只是重新解析
      后确认，不改变正在生效的连接）；
    - 连接失败：强制重新解析一次，用新 IP 再试一轮；仍失败即确定失败，
      此后一小时内不再因此发起 DoH；
    - DoH 本身故障：不反复重试查询，继续用已有 IP。
    """
    host = str(host).strip()
    state = _get_state(host)
    failure = None

    # 1) 未到复查时间且已有 IP：直接复用，不查 DoH
    if state is not None and state.connect_host and _is_fresh(state):
        try:
            return await attempt(state.connect_host, state.server_hostname)
        except (OSError, asyncio.TimeoutError) as exc:
            failure = exc
    else:
        # 2) 首次，或到点复查：查询一次 DoH
        recheck = state is not None and state.connect_host is not None
        try:
            resolved = await resolve_node_address(host, force_refresh=recheck)
        except Exception as exc:
            if not recheck:
                raise
            # 复查时 DoH 失败：继续用原 IP，并推迟一小时后再查
            _update_state(host, checked_at=time.monotonic())
            return await attempt(state.connect_host, state.server_hostname)
        state = _update_state(host, resolved, checked_at=time.monotonic())
        try:
            return await _try_hosts(state, attempt, resolved.all_hosts)
        except (OSError, asyncio.TimeoutError) as exc:
            failure = exc

    # 3) 失败：每小时最多一次“重解析后重试一次”，再失败就是确定失败
    return await _retry_once(host, attempt, state, failure)


async def _retry_once(host, attempt, state, failure):
    now = time.monotonic()
    if (
        state.failure_retry_at is not None
        and now - state.failure_retry_at < HOURLY_RECHECK_INTERVAL
    ):
        # 刚刚已经重解析重试过了：不再查 DoH
        raise failure
    state = _update_state(host, checked_at=now, failure_retry_at=now)
    try:
        resolved = await resolve_node_address(host, force_refresh=True)
    except Exception:
        raise failure
    state = _update_state(host, resolved, checked_at=time.monotonic())
    try:
        return await _try_hosts(state, attempt, resolved.all_hosts)
    except (OSError, asyncio.TimeoutError):
        raise failure


def _is_fresh(state):
    return (
        state.checked_at is not None
        and time.monotonic() - state.checked_at < HOURLY_RECHECK_INTERVAL
    )


async def _connect_one_ip(
    connect_host, port, server_hostname, use_tls, ssl_ctx, timeout
):
    if not use_tls:
        return await asyncio.wait_for(
            asyncio.open_connection(connect_host, port), timeout=timeout
        )

    async def make_connection(sni):
        return await asyncio.wait_for(
            asyncio.open_connection(
                connect_host, port, ssl=ssl_ctx, server_hostname=sni
            ),
            timeout=timeout,
        )

    if not server_hostname:
        # 目标本身就是 IP：沿用旧的 server_hostname=IP 行为（IP 字面量不发 SNI）
        return await make_connection(connect_host)
    return await connect_with_sni_fallback(
        server_hostname, connect_host, make_connection, ssl_ctx
    )


async def open_node_connection(
    server_config, *, use_tls, ssl_ctx=None, timeout=DEFAULT_CONNECT_TIMEOUT
):
    """连接节点，返回 (reader, writer)。

    证书 pin 校验由调用方在拿到 writer 后进行。
    """
    host = str(server_config["address"]).strip()
    port = server_config["port"]
    if not host:
        raise RuntimeError("Node host is empty")

    async def attempt(connect_host, server_hostname):
        return await _connect_one_ip(
            connect_host, port, server_hostname, use_tls, ssl_ctx, timeout
        )

    return await for_each_node_address(host, attempt)
