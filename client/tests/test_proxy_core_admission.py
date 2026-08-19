"""目标准入、运行时指标与 relay 空闲超时打点测试。

覆盖根因修复新增的三层保护：单目标并发上限（53 端口收紧）、
周期诊断指标聚合、53 端口空闲连接快速回收并打点。
"""

import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core


def test_target_admission_default_cap():
    admission = proxy_core.TargetAdmission(default_limit=2)

    assert admission.try_acquire("example.com", 443)
    assert admission.try_acquire("example.com", 443)
    assert not admission.try_acquire("example.com", 443)

    admission.release("example.com", 443)
    assert admission.try_acquire("example.com", 443)


def test_target_admission_port_53_tight_cap():
    admission = proxy_core.TargetAdmission(default_limit=64)
    limit = admission.limit_for(53)

    acquired = 0
    while admission.try_acquire("30.30.30.30", 53):
        acquired += 1

    assert acquired == limit
    assert admission.snapshot()["rejected_total"] == 1
    top = admission.snapshot()["rejected_top"][0]
    assert top["target"] == "30.30.30.30:53"


def test_target_admission_release_never_negative():
    admission = proxy_core.TargetAdmission()
    admission.release("example.com", 443)
    assert admission.snapshot()["active_total"] == 0


def test_runtime_metrics_snapshot_resets_period():
    metrics = proxy_core.RuntimeMetrics()
    metrics.record_setup_wait(1.5)
    metrics.record_setup_wait(0.2)
    metrics.record_dns_idle_kill()
    metrics.observe_active(30)

    first = metrics.snapshot()
    assert first["setup_wait_count"] == 2
    assert first["setup_wait_max_ms"] == 1500
    assert first["setup_wait_slow"] == 1
    assert first["dns_idle_kills"] == 1
    assert first["active_peak"] == 30

    # snapshot 后清零：每条诊断日志都是周期增量
    assert metrics.snapshot()["setup_wait_count"] == 0


def test_setup_slot_timeout_is_recorded(monkeypatch):
    pc = proxy_core.ProxyCore()
    pc._semaphore = asyncio.Semaphore(1)
    monkeypatch.setattr(proxy_core, "SETUP_ACQUIRE_TIMEOUT", 0.1)

    async def run():
        await pc._acquire_setup_slot()  # 占住唯一槽位
        try:
            await pc._acquire_setup_slot()
        except asyncio.TimeoutError:
            pass
        snapshot = pc._metrics.snapshot()
        assert snapshot["setup_timeout_rejects"] == 1
        pc._release_setup_slot()

    asyncio.run(run())


def test_relay_idle_timeout_calls_callback(monkeypatch):
    class IdleReader:
        async def read(self, n):
            await asyncio.sleep(3600)

    class Writer:
        def __init__(self):
            self.transport = None

        def write(self, data):
            pass

        async def drain(self):
            pass

        def can_write_eof(self):
            return True

        def write_eof(self):
            pass

        async def wait_closed(self):
            pass

    calls = []

    async def run():
        await proxy_core.relay(
            IdleReader(), Writer(), on_idle_timeout=lambda: calls.append(1),
            idle_timeout=0.2,
        )

    asyncio.run(run())
    assert calls == [1]


def test_open_direct_retries_ebadf_once(monkeypatch):
    calls = []

    class BadFdError(OSError):
        def __init__(self):
            super().__init__(9, "Connect call failed")

    async def fake_open(host, port):
        calls.append((host, port))
        if len(calls) == 1:
            raise BadFdError()
        return object(), object()

    monkeypatch.setattr(proxy_core.asyncio, "open_connection", fake_open)
    monkeypatch.setattr(proxy_core, "_set_nodelay", lambda writer: None)

    reader, writer = asyncio.run(proxy_core._open_direct("example.com", 443))

    assert calls == [("example.com", 443), ("example.com", 443)]
    assert writer is not None
