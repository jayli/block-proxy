"""relay 忙循环防御 + GC 调优回归测试（2026-10-27 现场）。

背景：断网时事件循环连续停滞 6.8s → 37.4s → 67.8s → 109.2s → 160.0s，
`sample` 显示事件循环线程 100% 停在 `gc_collect_main`，进程 RSS 13.7GB、
footprint 25GB。dump 里 `asyncio.wait_for` 被高频调用，说明 relay 的超时
分支在空转——每次迭代创建 Task/Timeout/TimerHandle，把 GC 逼成连续运行。

这里锁定两件事：
  1. 底层 reader 提前抛 TimeoutError 时，relay 必须退避并在连续多次后
     关闭连接，而不是无条件 continue 形成忙循环；
  2. 启动完成后必须执行 GC 冻结与阈值放宽，慢 GC 要留日志。
"""

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core


class _NoEOFWriter:
    """最小 writer 垫片：不写 EOF、不缓冲。"""

    def write(self, data):
        pass

    def can_write_eof(self):
        return False

    def write_eof(self):
        pass

    async def wait_closed(self):
        pass

    def close(self):
        pass

    @property
    def transport(self):
        class _T:
            def get_write_buffer_size(self):
                return 0

        return _T()


def test_relay_backs_off_and_breaks_on_premature_timeouts(monkeypatch):
    """reader 每次都立即抛 TimeoutError：必须退避 + 熔断，不能空转。"""
    monkeypatch.setattr(proxy_core, "RELAY_TIMEOUT_BACKOFF", 0.001)
    monkeypatch.setattr(proxy_core, "RELAY_TIMEOUT_BURST_LIMIT", 5)

    warnings = []
    monkeypatch.setattr(
        proxy_core.crash_logger,
        "warning",
        lambda *a, **k: warnings.append(a),
    )

    class _Reader:
        def __init__(self):
            self.reads = 0

        async def read(self, n=-1):
            self.reads += 1
            raise asyncio.TimeoutError

    reader = _Reader()

    async def _run():
        await proxy_core.relay(
            reader, _NoEOFWriter(), route="test", direction="outbound"
        )

    asyncio.run(_run())

    # 恰好触发到熔断阈值，不是无限循环
    assert reader.reads == 5
    assert any("premature timeouts" in str(args) for args in warnings)


def test_relay_forwards_data_without_backoff(monkeypatch):
    """正常数据转发不应被防御逻辑影响。"""
    sleeps = []

    async def _fake_sleep(delay):
        sleeps.append(delay)

    monkeypatch.setattr(proxy_core.asyncio, "sleep", _fake_sleep)

    class _Reader:
        def __init__(self):
            self.chunks = [b"hello", b""]

        async def read(self, n=-1):
            return self.chunks.pop(0)

    class _Writer(_NoEOFWriter):
        def __init__(self):
            self.data = bytearray()

        def write(self, data):
            self.data.extend(data)

    writer = _Writer()

    async def _run():
        await proxy_core.relay(
            _Reader(), writer, route="test", direction="inbound"
        )

    asyncio.run(_run())

    assert bytes(writer.data) == b"hello"
    assert sleeps == []


def test_configure_gc_freezes_and_relaxes_threshold(monkeypatch):
    calls = []
    monkeypatch.setattr(proxy_core.gc, "collect", lambda *a, **k: calls.append("collect"))
    monkeypatch.setattr(proxy_core.gc, "freeze", lambda: calls.append("freeze"))
    monkeypatch.setattr(
        proxy_core.gc, "set_threshold", lambda *a: calls.append(("threshold", a))
    )
    monkeypatch.setattr(proxy_core.gc, "callbacks", [])
    monkeypatch.setattr(proxy_core, "_gc_monitor_installed", False)
    monkeypatch.setattr(proxy_core, "_gc_frozen", False)

    proxy_core._configure_gc()

    assert calls[0] == "collect"
    assert "freeze" in calls
    assert ("threshold", proxy_core.GC_THRESHOLD) in calls
    assert len(proxy_core.gc.callbacks) == 1


def test_configure_gc_freezes_only_once(monkeypatch):
    """代理重启会反复调用 _configure_gc，freeze 只能生效一次。"""
    calls = []
    monkeypatch.setattr(proxy_core.gc, "collect", lambda *a, **k: calls.append("collect"))
    monkeypatch.setattr(proxy_core.gc, "freeze", lambda: calls.append("freeze"))
    monkeypatch.setattr(proxy_core.gc, "set_threshold", lambda *a: None)
    monkeypatch.setattr(proxy_core.gc, "callbacks", [])
    monkeypatch.setattr(proxy_core, "_gc_monitor_installed", True)
    monkeypatch.setattr(proxy_core, "_gc_frozen", False)

    proxy_core._configure_gc()
    proxy_core._configure_gc()

    assert calls.count("freeze") == 1


def test_gc_monitor_reports_slow_collection(monkeypatch):
    warnings = []
    monkeypatch.setattr(
        proxy_core.crash_logger,
        "warning",
        lambda *a, **k: warnings.append(a),
    )

    monitor = proxy_core._GcMonitor(slow_seconds=0.0)
    monitor("start", {"generation": 2})
    monitor("stop", {"generation": 2, "collected": 10, "uncollectable": 0})

    assert len(warnings) == 1
    assert "slow GC" in warnings[0][0]
    assert warnings[0][1] == 2


def test_gc_defaults_are_relaxed():
    """阈值必须比 CPython 默认 (700, 10, 10) 明显放宽。"""
    gen0, gen1, gen2 = proxy_core.GC_THRESHOLD

    assert gen0 > 700
    assert gen1 > 10
    assert gen2 > 10
