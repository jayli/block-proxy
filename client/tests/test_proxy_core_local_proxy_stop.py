"""本地代理 stop/recycle 的 wait_closed 限时与超时取消测试。

背景：屏幕点亮后 EDR（AliEntSafe）每 3s 注入一个探测连接，
server.wait_closed() 要等所有活跃 handler 完成，探测风暴下永不
返回，导致 recycle 卡死（listener 已关闭未重建 → Connection
refused）；15s 超时后僵尸协程继续在旧事件循环上操作 server 引用，
与 health check 的 stop+start（新事件循环）跨循环踩踏
（RuntimeError: Future attached to a different loop + 端口漂移）。
"""

import asyncio
import os
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core


class NeverFinishesServer:
    """close() 后 wait_closed() 永不完成（活跃探测连接持续存在）。"""

    def __init__(self):
        self.closed = False
        self.wait_calls = 0

    def close(self):
        self.closed = True

    async def wait_closed(self):
        self.wait_calls += 1
        await asyncio.sleep(3600)


def test_stop_local_proxy_times_out_instead_of_hanging(monkeypatch):
    """wait_closed 永不完成（EDR 探测连接风暴）→ 限时后返回，server 置 None。

    端口释放只依赖 close()；wait_closed 无限等待会让 recycle 停在
    "已关闭未重建" 的中间态（用户可见 Connection refused）。
    """
    monkeypatch.setattr(proxy_core, "LOCAL_PROXY_STOP_WAIT_TIMEOUT", 0.2)

    proxy = proxy_core.ProxyCore()
    socks = NeverFinishesServer()
    http = NeverFinishesServer()
    proxy._socks_server = socks
    proxy._http_server = http

    async def main():
        await proxy._stop_local_proxy()

    # 修复前：wait_closed 挂死 3600s → 5s 外层超时 → 测试失败
    asyncio.run(asyncio.wait_for(main(), timeout=5))

    # close() 在 wait_closed 之前已同步调用（端口释放不等待连接收尾）
    assert socks.closed
    assert http.closed
    assert proxy._socks_server is None
    assert proxy._http_server is None
    assert proxy._server_sockets == []


def test_recycle_local_proxy_aborts_timed_out_coroutine(monkeypatch):
    """recycle 内部超时兜底：协程在超时后必然自行退出，不产生僵尸协程。

    僵尸协程会在旧事件循环上继续操作 server 引用，与 health check
    的 stop+start（新事件循环）并发 → 跨 loop RuntimeError + 漂移。
    """
    monkeypatch.setattr(proxy_core, "LOCAL_PROXY_RECYCLE_TIMEOUT", 0.2)

    async def never_finish(self):
        await asyncio.sleep(3600)

    monkeypatch.setattr(proxy_core.ProxyCore, "_do_recycle_forced", never_finish)

    proxy = proxy_core.ProxyCore()
    loop = asyncio.new_event_loop()

    def runner():
        asyncio.set_event_loop(loop)
        loop.run_forever()

    t = threading.Thread(target=runner, daemon=True)
    t.start()
    try:
        proxy._loop = loop
        # 不应阻塞 15s：协程被内部 wait_for 在 0.2s 终止，future 正常完成
        proxy.recycle_local_proxy()
        assert not proxy.is_recycling(), "recycle 结束后 _recycling 标志未清除"
    finally:
        loop.call_soon_threadsafe(loop.stop)
        t.join(timeout=2)
        loop.close()


def test_recycling_flag_cleared_after_recycle(monkeypatch):
    """正常完成路径：recycle 后 _recycling 标志清除（health check 不再跳过）。"""

    async def fast_recycle(self):
        pass

    monkeypatch.setattr(proxy_core.ProxyCore, "_do_recycle_forced", fast_recycle)

    proxy = proxy_core.ProxyCore()
    loop = asyncio.new_event_loop()

    def runner():
        asyncio.set_event_loop(loop)
        loop.run_forever()

    t = threading.Thread(target=runner, daemon=True)
    t.start()
    try:
        proxy._loop = loop
        assert not proxy.is_recycling()
        proxy.recycle_local_proxy()
        assert not proxy.is_recycling()
    finally:
        loop.call_soon_threadsafe(loop.stop)
        t.join(timeout=2)
        loop.close()
