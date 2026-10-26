"""孤儿事件循环线程放弃阈值 + 内存诊断回归测试（2026-10-26 现场）。

背景：断网后本地代理事件循环僵死，stop() 无法让线程退出，线程被记为
孤儿；健康检查三次自动重启全部被 start() 拒绝，代理空窗 6.5 分钟，
期间系统代理仍指向死端口。同一进程的物理 footprint 已达 41GB
（41955 个 1MB pymalloc arena），但磁盘日志里没有任何内存线索。

这里锁定两件事：
  1. start() 拒绝僵死线程时抛出 ProxyThreadStuckError 并带上存活时长，
     app 层据此在超过 ORPHAN_THREAD_GIVEUP_SECONDS 后提示重启客户端，
     而不是继续退避重试；
  2. 诊断日志输出 rss_mb / py_blocks 且在取值失败时降级为 0。
"""

import os
import sys
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core


class FakeThread:
    def __init__(self, alive=True):
        self.alive = alive

    def is_alive(self):
        return self.alive

    def join(self, timeout=None):
        pass


def test_stuck_error_carries_orphan_age():
    proxy = proxy_core.ProxyCore()
    proxy._orphan_thread = FakeThread(alive=True)
    proxy._orphan_thread_since = time.monotonic() - 42.0

    with pytest.raises(proxy_core.ProxyThreadStuckError) as excinfo:
        proxy._reject_live_orphan_thread()

    assert 41.0 <= excinfo.value.age_seconds <= 44.0
    # 旧日志检索与旧测试都依赖这段文案
    assert "refusing to start a second event loop" in str(excinfo.value)


def test_stuck_error_remains_a_runtime_error():
    """兼容既有 except RuntimeError：新异常必须是其子类。"""
    assert isinstance(proxy_core.ProxyThreadStuckError(0.0), RuntimeError)


def test_orphan_without_recorded_since_reports_near_zero_age():
    """直接注入墓碑（旧路径/测试）时不得报出巨大年龄。"""
    proxy = proxy_core.ProxyCore()
    proxy._orphan_thread = FakeThread(alive=True)

    with pytest.raises(proxy_core.ProxyThreadStuckError) as excinfo:
        proxy._reject_live_orphan_thread()

    assert excinfo.value.age_seconds < 1.0


def test_dead_orphan_clears_recorded_since():
    proxy = proxy_core.ProxyCore()
    proxy._orphan_thread = FakeThread(alive=False)
    proxy._orphan_thread_since = time.monotonic() - 100.0

    proxy._reject_live_orphan_thread()

    assert proxy._orphan_thread is None
    assert proxy._orphan_thread_since is None


def test_stop_records_orphan_since():
    """stop() 放弃未退出的线程时必须记下僵住起点。"""
    proxy = proxy_core.ProxyCore()
    proxy._thread = FakeThread(alive=True)

    proxy.stop()

    assert proxy._orphan_thread is not None
    assert proxy._orphan_thread_since is not None
    with pytest.raises(proxy_core.ProxyThreadStuckError) as excinfo:
        proxy._reject_live_orphan_thread()
    assert excinfo.value.age_seconds < 1.0


def test_stop_does_not_reset_existing_orphan_age():
    """重复 stop() 不得把已记录的存活时长清零（否则永远达不到放弃阈值）。"""
    proxy = proxy_core.ProxyCore()
    thread = FakeThread(alive=True)
    proxy._orphan_thread = thread
    proxy._orphan_thread_since = time.monotonic() - 20.0

    proxy._thread = thread
    proxy.stop()

    assert proxy._orphan_thread_since <= time.monotonic() - 19.0


def test_memory_stats_returns_plausible_values():
    rss_mb, py_blocks = proxy_core._memory_stats()

    assert rss_mb > 0
    assert py_blocks > 0


def test_memory_stats_degrades_to_zero_on_failure(monkeypatch):
    """取分配块数失败时必须降级，不能把诊断协程带崩。"""

    def _boom():
        raise RuntimeError("boom")

    monkeypatch.setattr(proxy_core.sys, "getallocatedblocks", _boom)

    rss_mb, py_blocks = proxy_core._memory_stats()

    assert isinstance(rss_mb, int)
    assert py_blocks == 0


def test_log_diagnostics_includes_memory_fields(monkeypatch):
    proxy = proxy_core.ProxyCore()
    captured = {}

    def _fake_info(fmt, *args):
        captured["fmt"] = fmt
        captured["args"] = args

    monkeypatch.setattr(proxy_core.diagnostics_logger, "info", _fake_info)

    proxy._log_diagnostics()

    assert "rss_mb=%d py_blocks=%d" in captured["fmt"]
    # fd, rss, blocks, active, active_peak, setup_wait_* (4), timeout,
    # ceiling, dns, relay, edr, target_active, top, rejected_total, top
    assert len(captured["args"]) == 18


def test_memory_warning_is_rate_limited(monkeypatch):
    proxy = proxy_core.ProxyCore()
    proxy._last_rss_warn = time.monotonic() - 601
    calls = []
    monkeypatch.setattr(
        proxy_core.crash_logger, "warning", lambda *a, **k: calls.append(a)
    )

    proxy._warn_if_memory_bloated(4096, 1000)
    proxy._warn_if_memory_bloated(4096, 1000)

    assert len(calls) == 1
    assert "high memory" in calls[0][0]


def test_memory_warning_skipped_below_threshold(monkeypatch):
    proxy = proxy_core.ProxyCore()
    calls = []
    monkeypatch.setattr(
        proxy_core.crash_logger, "warning", lambda *a, **k: calls.append(a)
    )

    proxy._warn_if_memory_bloated(proxy_core.RSS_WARN_THRESHOLD_MB - 1, 1000)

    assert calls == []


# ── 事件循环看门狗 ───────────────────────────────────────────────


class FakeLoop:
    """只记录 call_soon_threadsafe；heartbeat=True 时模拟 loop 正常推进。"""

    def __init__(self, heartbeat):
        self.heartbeat = heartbeat
        self.scheduled = 0

    def call_soon_threadsafe(self, callback):
        self.scheduled += 1
        if self.heartbeat:
            callback()


def test_watchdog_dumps_when_loop_stops_beating(tmp_path):
    """loop 不执行排进去的回调 → 判定卡死并 dump（只按 report 间隔重复）。"""
    loop = FakeLoop(heartbeat=False)
    watchdog = proxy_core._LoopWatchdog(
        loop, str(tmp_path / "crash.log"),
        interval=0.01, stuck_after=0.03, report_interval=10.0,
    )
    calls = []
    watchdog._dump = calls.append
    watchdog.start()
    time.sleep(0.2)
    watchdog.stop()

    assert len(calls) == 1
    assert calls[0] >= 0.03


def test_watchdog_silent_when_loop_keeps_beating(tmp_path):
    loop = FakeLoop(heartbeat=True)
    watchdog = proxy_core._LoopWatchdog(
        loop, str(tmp_path / "crash.log"),
        interval=0.01, stuck_after=0.03, report_interval=10.0,
    )
    calls = []
    watchdog._dump = calls.append
    watchdog.start()
    time.sleep(0.15)
    watchdog.stop()

    assert loop.scheduled > 0
    assert calls == []


def test_watchdog_without_log_path_does_not_start(tmp_path):
    """logging 未初始化（无 crash.log 路径）时不启动线程。"""
    loop = FakeLoop(heartbeat=False)
    watchdog = proxy_core._LoopWatchdog(loop, None, interval=0.01, stuck_after=0.01)

    watchdog.start()

    assert watchdog._thread is None
    assert loop.scheduled == 0


def test_watchdog_dump_writes_all_thread_stacks(tmp_path):
    log_path = tmp_path / "crash.log"
    watchdog = proxy_core._LoopWatchdog(
        FakeLoop(heartbeat=True), str(log_path), interval=1.0, stuck_after=1.0
    )

    watchdog._dump(12.5)

    text = log_path.read_text()
    assert "event loop stalled 12.5s" in text
    assert "end of stalled dump" in text


def test_orphan_thread_alive_tracks_orphan_state():
    proxy = proxy_core.ProxyCore()
    assert proxy.orphan_thread_alive() is False

    thread = FakeThread(alive=True)
    proxy._orphan_thread = thread
    assert proxy.orphan_thread_alive() is True

    thread.alive = False
    assert proxy.orphan_thread_alive() is False


def test_crash_log_path_comes_from_rotating_handler(tmp_path):
    """看门狗必须能定位 crash.log；真实运行时由 RotatingFileHandler 提供。"""
    import logging.handlers

    target = str(tmp_path / "crash.log")
    handler = logging.handlers.RotatingFileHandler(target)
    proxy_core.crash_logger.addHandler(handler)
    try:
        assert proxy_core._crash_log_path() == target
    finally:
        proxy_core.crash_logger.removeHandler(handler)
        handler.close()
