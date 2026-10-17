"""relay 空闲超时必须是「整条连接」级，而不是「单方向」级。

背景：上游 LLM 流式响应期间，客户端发完一个请求后整段时间不再上行，
但下行（思考内容）一直在流。旧的 relay() 让两个方向各自 wait_for，
出向 300s 零字节即判空闲 → write_eof + RST，正常请求被代理自己掐断。
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core


class RecordingWriter:
    def __init__(self):
        self.writes = []
        self.eof_sent = False
        self.closed = False
        self.transport = self

    def write(self, data):
        self.writes.append(data)

    def get_write_buffer_size(self):
        return 0

    def can_write_eof(self):
        return True

    def write_eof(self):
        self.eof_sent = True

    async def wait_closed(self):
        return None

    def close(self):
        self.closed = True

    def get_extra_info(self, name):
        return None

    def abort(self):
        self.closed = True


class StreamingReader:
    """每 interval 秒吐一块数据，用完后返回 EOF。"""

    def __init__(self, chunks, interval, eof=True):
        self._chunks = list(chunks)
        self._interval = interval
        self._eof = eof

    async def read(self, n):
        if self._chunks:
            await asyncio.sleep(self._interval)
            return self._chunks.pop(0)
        if self._eof:
            return b""
        await asyncio.sleep(3600)
        return b""


class SilentReader:
    """永不返回数据（模拟客户端上行已经结束）。"""

    async def read(self, n):
        await asyncio.sleep(3600)
        return b""


def test_one_direction_idle_kept_alive_by_sibling_traffic():
    """只有入向有流时，出向不得判空闲：共享 deadline 让两个方向一起续命。

    旧语义下出向会在 idle_timeout 到期时触发 on_idle_timeout（并被
    write_eof 掐断），所以这个用例在旧实现上必然失败。
    """
    kills = []
    idle_timeout = 0.2
    idle = proxy_core.IdleDeadline(idle_timeout)

    client_reader = SilentReader()              # 客户端发完 POST 后不再上行
    remote_reader = StreamingReader(            # 上游持续推流（thinking）
        [b"chunk"] * 6, interval=0.1
    )
    remote_writer = RecordingWriter()
    client_writer = RecordingWriter()

    async def run():
        outbound = asyncio.ensure_future(
            proxy_core.relay(
                client_reader, remote_writer, idle=idle,
                on_idle_timeout=lambda: kills.append("outbound"),
            )
        )
        inbound = asyncio.ensure_future(
            proxy_core.relay(
                remote_reader, client_writer, idle=idle,
                on_idle_timeout=lambda: kills.append("inbound"),
            )
        )
        # 入向 0.6s 内持续推流，期间出向空闲 3 倍 idle_timeout
        await asyncio.sleep(0.65)
        outbound.cancel()
        inbound.cancel()
        for task in (outbound, inbound):
            try:
                await task
            except asyncio.CancelledError:
                pass

    asyncio.run(run())

    assert kills == []                                  # 没有任何方向被判空闲
    assert client_writer.writes == [b"chunk"] * 6        # 流完整送达客户端


def test_both_directions_idle_reports_once():
    """两个方向都静默才到期，且共享 deadline 只上报一次。"""
    kills = []
    idle_timeout = 0.15
    idle = proxy_core.IdleDeadline(idle_timeout)

    async def run():
        await asyncio.gather(
            proxy_core.relay(
                SilentReader(), RecordingWriter(), idle=idle,
                on_idle_timeout=lambda: kills.append("outbound"),
            ),
            proxy_core.relay(
                SilentReader(), RecordingWriter(), idle=idle,
                on_idle_timeout=lambda: kills.append("inbound"),
            ),
        )

    asyncio.run(run())

    assert len(kills) == 1


def test_outbound_expiring_first_does_not_double_report():
    """出向先到期后入向再到期，同一次空闲事件只上报一次。"""

    class ChunkThenSilent:
        def __init__(self):
            self._sent = False

        async def read(self, n):
            if not self._sent:
                self._sent = True
                return b"x"
            await asyncio.sleep(3600)
            return b""

    kills = []
    idle = proxy_core.IdleDeadline(0.1)

    async def run():
        await asyncio.gather(
            proxy_core.relay(
                SilentReader(), RecordingWriter(), idle=idle,
                on_idle_timeout=lambda: kills.append("outbound"),
            ),
            proxy_core.relay(
                ChunkThenSilent(), RecordingWriter(), idle=idle,
                on_idle_timeout=lambda: kills.append("inbound"),
            ),
        )

    asyncio.run(run())
    assert kills == ["outbound"]


def test_idle_deadline_touch_extends_and_expire_is_single_shot():
    idle = proxy_core.IdleDeadline(1.0)
    first = idle.remaining()
    assert 0.0 < first <= 1.0

    idle.touch()
    assert idle.remaining() >= first - 0.01  # 续命后不再递减到已用掉的时间

    assert idle.expire() is True
    assert idle.expire() is False           # 一次到期只认领一次


def test_relay_without_shared_deadline_keeps_unidirectional_semantics():
    """不传 idle 时退化为单向计时（保留原有行为，供独立/单方向场景使用）。"""
    kills = []

    async def run():
        await proxy_core.relay(
            SilentReader(), RecordingWriter(), idle_timeout=0.1,
            on_idle_timeout=lambda: kills.append(1),
        )

    asyncio.run(run())
    assert kills == [1]


def test_non_dns_idle_kill_is_observable(monkeypatch):
    """非 53 端口的空闲超时以前完全静默，必须记 access log + 计数器。"""
    logs = []
    monkeypatch.setattr(
        proxy_core.access_logger, "info",
        lambda fmt, *args, **kwargs: logs.append(fmt % args),
    )

    pc = proxy_core.ProxyCore()
    pc._on_relay_idle_timeout("api.example.com", 443)

    metrics = pc._metrics.snapshot()
    assert metrics["relay_idle_kills"] == 1
    assert metrics["dns_idle_kills"] == 0
    assert len(logs) == 1
    assert "relay-idle-kill" in logs[0]
    assert "api.example.com:443" in logs[0]


def test_dns_idle_kill_keeps_dedicated_counter(monkeypatch):
    """53 端口（TCP DNS 探测）沿用 15s 专用超时与 dns_idle_kills，不刷 access log。"""
    logs = []
    monkeypatch.setattr(
        proxy_core.access_logger, "info",
        lambda fmt, *args, **kwargs: logs.append(fmt % args),
    )

    pc = proxy_core.ProxyCore()
    assert pc._relay_idle_timeout(53) == proxy_core.DNS_TCP_IDLE_TIMEOUT
    assert pc._relay_idle_timeout(443) == proxy_core.RELAY_IDLE_TIMEOUT

    pc._on_relay_idle_timeout("8.8.8.8", 53)

    metrics = pc._metrics.snapshot()
    assert metrics["dns_idle_kills"] == 1
    assert metrics["relay_idle_kills"] == 0
    assert logs == []


def test_http_connect_relay_shares_single_idle_deadline(monkeypatch):
    """CONNECT 分支的两个方向必须共用同一个 IdleDeadline 实例。"""
    seen = []

    async def fake_relay(reader, writer, route=None, direction=None,
                         on_activity=None, idle_timeout=None,
                         on_idle_timeout=None, idle=None):
        seen.append((direction, idle))

    class Reader:
        def __init__(self, lines):
            self._lines = list(lines)

        async def readline(self):
            return self._lines.pop(0) if self._lines else b""

    class Writer(RecordingWriter):
        async def drain(self):
            return None

    async def fake_connect_target(host, port, is_domain=None, route=None):
        return object(), Writer(), "proxy"

    monkeypatch.setattr(proxy_core, "relay", fake_relay)

    pc = proxy_core.ProxyCore()
    pc._server_config = {"protocol": "socks5"}
    pc._proxy_private = False
    pc._routing = None
    pc._connect_target = fake_connect_target

    client_writer = Writer()
    asyncio.run(pc._do_handle_http(
        Reader([b"CONNECT api.example.com:443 HTTP/1.1\r\n", b"\r\n"]),
        client_writer,
    ))

    assert len(seen) == 2
    deadlines = [idle for _, idle in seen]
    assert isinstance(deadlines[0], proxy_core.IdleDeadline)
    assert deadlines[0] is deadlines[1]                 # 同一实例 → 双向共享
    assert {direction for direction, _ in seen} == {"inbound", "outbound"}
