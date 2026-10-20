"""代理生命周期竞态回归测试（2026-10-20 10:07 闪退现场）。

背景：休眠唤醒后旧事件循环线程僵住（线程存活但不再执行任何 task），
唤醒回调线程与健康检查线程各自判定“代理不健康”并各自 stop()+start()：
  1. _run_loop 读共享的 self._loop，线程跑到另一个线程已经 run_forever
     的循环上 → RuntimeError: This event loop is already running；
  2. stop() 在 join 超时后放弃未退出的旧线程，却仍然允许 start() →
     同一进程内两个事件循环共享 _stats_task/_diagnostics_task/server
     引用，跨 loop 取消 + 错误风暴，最终把事件循环线程的栈打穿（SIGILL）。
"""

import asyncio
import os
import socket
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core


class FakeThread:
    def __init__(self, alive):
        self.alive = alive
        self.join_timeouts = []

    def is_alive(self):
        return self.alive

    def join(self, timeout=None):
        self.join_timeouts.append(timeout)


class FakeLoop:
    """真实 event loop + 被替换掉的 run_until_complete/run_forever。

    asyncio.set_event_loop() 只接受 AbstractEventLoop，所以用真 loop，
    只把“跑起来”的两步换掉，避免测试真的起 server。
    """

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.ran_until_complete = []
        self.run_forever_calls = 0
        self.loop.run_until_complete = self._run_until_complete
        self.loop.run_forever = self._run_forever

    def _run_until_complete(self, awaitable):
        self.ran_until_complete.append(awaitable)
        awaitable.close()

    def _run_forever(self):
        self.run_forever_calls += 1

    def close(self):
        self.loop.close()


def test_run_loop_uses_passed_loop_not_shared_attribute(monkeypatch):
    """_run_loop 必须跑线程创建时传给它的 loop。

    修复前它读 self._loop：两路 start() 交错时，先起的线程会去跑后一路
    刚装上的 loop（已在另一个线程 run_forever）→ RuntimeError，且旧循环
    无人回收。
    """
    proxy = proxy_core.ProxyCore()

    async def noop_start_servers():
        pass

    monkeypatch.setattr(proxy, "_start_servers", noop_start_servers)

    passed_loop = FakeLoop()
    other_loop = FakeLoop()
    proxy._loop = other_loop  # 模拟另一路 start() 已改写共享属性
    started = threading.Event()

    try:
        proxy._run_loop(passed_loop.loop, started)
    finally:
        asyncio.set_event_loop(None)
        passed_loop.close()
        other_loop.close()

    assert started.is_set()
    assert len(passed_loop.ran_until_complete) == 1
    assert passed_loop.run_forever_calls == 1
    assert other_loop.ran_until_complete == []
    assert other_loop.run_forever_calls == 0


def test_stop_marks_orphan_thread_when_loop_thread_will_not_exit():
    """stop() 放弃未退出的循环线程后必须留墓碑，供 start() 拒绝。"""
    proxy = proxy_core.ProxyCore()
    thread = FakeThread(alive=True)
    proxy._thread = thread

    proxy.stop()

    assert proxy._orphan_thread is thread
    assert proxy._thread is None
    assert proxy._loop is None
    assert thread.join_timeouts == [3]


def test_start_refuses_when_orphan_loop_thread_still_alive():
    """旧事件循环线程未退出时，start() 必须拒绝造第二个循环。"""
    proxy = proxy_core.ProxyCore()
    proxy._orphan_thread = FakeThread(alive=True)

    with pytest.raises(RuntimeError, match="refusing to start a second event loop"):
        # 检查发生在读配置/建 loop 之前，空配置即可
        proxy.start({"server": {}, "local": {}})


def test_dead_orphan_loop_thread_is_cleared():
    """墓碑线程已退出：清空记录，允许正常重启。"""
    proxy = proxy_core.ProxyCore()
    proxy._orphan_thread = FakeThread(alive=False)

    proxy._reject_live_orphan_thread()

    assert proxy._orphan_thread is None


def test_start_calls_serialize_through_lifecycle_lock(monkeypatch):
    """两路 start() 必须串行进入：否则会各建一个事件循环。"""
    proxy = proxy_core.ProxyCore()
    entered = threading.Semaphore(0)
    release = threading.Event()
    inside = []

    def fake_start_locked(user_config, config_dir=None):
        inside.append(threading.get_ident())
        entered.release()
        release.wait(5)

    monkeypatch.setattr(proxy, "_start_locked", fake_start_locked)

    first = threading.Thread(target=proxy.start, args=({"server": {}},), daemon=True)
    second = threading.Thread(target=proxy.start, args=({"server": {}},), daemon=True)

    first.start()
    assert entered.acquire(timeout=2)
    second.start()
    time.sleep(0.2)
    assert len(inside) == 1, "第二路 start() 没被生命周期锁挡住"

    release.set()
    first.join(timeout=3)
    second.join(timeout=3)

    assert len(inside) == 2
    assert not first.is_alive()
    assert not second.is_alive()


def test_stop_inside_lifecycle_lock_does_not_deadlock():
    """start() 持锁时会内部调 stop()：锁必须可重入。"""
    proxy = proxy_core.ProxyCore()
    done = threading.Event()

    def worker():
        with proxy._lifecycle_lock:
            proxy.stop()
        done.set()

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()

    assert done.wait(timeout=3), "同线程内 stop() 被生命周期锁死锁"
    thread.join(timeout=1)


def _config(socks_port, http_port):
    return {
        "server": {
            "protocol": "socks5",
            "address": "127.0.0.1",
            "port": 18999,  # 不可达节点：preconnect 后台失败，不影响 stop
            "tls": False,
            "username": "",
            "password": "",
        },
        "local": {
            "socks_port": socks_port,
            "http_port": http_port,
            "proxy_private": False,
            "udp": True,
        },
        "tunnel": {},
        "routing": {
            "enabled": False,
            "default": "proxy",
            "direct_rules": [],
            "proxy_rules": [],
        },
    }


def test_concurrent_restarts_never_leave_two_event_loops():
    """真实 loop：两路并发 stop()+start() 只能留下一个事件循环线程。

    2026-10-20 闪退现场就是这种并发：修复前其中一个线程会拎到别人正在
    run_forever 的 loop（RuntimeError: This event loop is already running），
    旧线程又退不掉，最后两个循环共享任务句柄。
    """
    socks_port, http_port = 18974, 18975
    proxy = proxy_core.ProxyCore()
    proxy.start(_config(socks_port, http_port))
    errors = []

    def restart():
        try:
            proxy.stop()
            proxy.start(_config(socks_port, http_port))
        except Exception as exc:  # 旧实现：event loop is already running
            errors.append(exc)

    try:
        threads = [threading.Thread(target=restart, daemon=True) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        assert errors == []
        assert proxy._orphan_thread is None
        loop_threads = [
            thread for thread in threading.enumerate()
            if getattr(thread, "_target", None) == proxy._run_loop and thread.is_alive()
        ]
        assert len(loop_threads) == 1, f"残留 {len(loop_threads)} 个事件循环线程"
        assert proxy.is_running()
        with socket.create_connection(("127.0.0.1", socks_port), timeout=2):
            pass
    finally:
        proxy.stop()
