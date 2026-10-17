"""listener 端口泄漏与端口漂移可见性回归测试。

背景（2026-10-17 现场）：屏幕点亮触发 recycle，`_do_recycle_forced`
外套的 `wait_for` 在 `_stop_local_proxy` 的 await 点（
`_upstream_pool.stop()`）取消协程，两个 `server.close()` 还没执行，
旧 listen socket 就永久泄漏 —— 内核继续完成三次握手但无人 accept，
accept 队列塞满后新连接一律 ETIMEDOUT（表现为 `[Errno 60]
Operation timed out`）。随后 health check 的 stop+start 只能绑定
+1 端口（1080/1087 → 1081/1088），漂移全程无声。
"""

import asyncio
import os
import socket
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core


def _config(socks_port, http_port):
    return {
        "server": {
            "protocol": "socks5",
            "address": "127.0.0.1",
            "port": 18999,  # 不可达节点：preconnect 后台失败，不影响本地 listener
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


def _port_is_free(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def _occupy(port):
    """占用端口并返回持锁 socket（调用方负责 close）。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", port))
    s.listen(1)
    return s


def test_cancelled_stop_local_proxy_still_releases_ports(monkeypatch):
    """recycle 的 wait_for 在 await 点取消时，listen socket 必须先已关闭。

    修复前：`_stop_local_proxy` 先 await `_upstream_pool.stop()`，再
    `server.close()`；取消发生在 await 上 → 两个 listen socket 泄漏，
    端口被僵尸 listener 长期占用（能握手、无人 accept）。
    """
    socks_port, http_port = 18980, 18981

    async def scenario():
        proxy = proxy_core.ProxyCore()
        proxy._socks_port = socks_port
        proxy._http_port = http_port
        proxy._configured_socks_port = socks_port
        proxy._configured_http_port = http_port
        proxy._socks_server = await asyncio.start_server(
            lambda r, w: None, "127.0.0.1", socks_port
        )
        proxy._http_server = await asyncio.start_server(
            lambda r, w: None, "127.0.0.1", http_port
        )
        for server in (proxy._socks_server, proxy._http_server):
            for sock in server.sockets or []:
                proxy._server_sockets.append(sock)

        class HangingPool:
            async def stop(self):
                await asyncio.sleep(3600)

        proxy._upstream_pool = HangingPool()

        # 模拟 recycle 的 wait_for 超时取消（EDR 探测风暴下的真实形状）
        try:
            await asyncio.wait_for(proxy._stop_local_proxy(), timeout=0.2)
        except asyncio.TimeoutError:
            pass

        # 必须在 loop 仍存活、proxy 仍持有 server 引用时检查：asyncio.run
        # 返回到达不了这个状态（loop 关闭 + GC 会把泄漏的 socket 一并收掉，
        # 掩盖真实进程里长期存活的僵尸 listener）。
        assert _port_is_free(socks_port), "SOCKS 端口被僵尸 listener 占用"
        assert _port_is_free(http_port), "HTTP 端口被僵尸 listener 占用"

    asyncio.run(scenario())


def test_port_fallback_is_recorded_and_resets_on_clean_start():
    """端口冲突导致漂移时必须留下可读记录，而不是静默 +1。

    修复前：`+1` 只写进 `logging.getLogger("proxy_core")`，而这个
    logger 没有 handler，警告全部丢失，UI 也只显示漂移后的端口。
    """
    configured_socks, configured_http = 18984, 18985
    blocker = _occupy(configured_socks)
    proxy = proxy_core.ProxyCore()
    try:
        proxy.start(_config(configured_socks, configured_http))
        time.sleep(0.3)

        fallback = proxy.port_fallback  # noqa: F841 - 缺失即失败
        assert fallback is not None, "端口漂移未被记录"
        assert fallback["configured_socks"] == configured_socks
        assert fallback["configured_http"] == configured_http
        assert fallback["socks"] == proxy.socks_port != configured_socks
        assert fallback["http"] == proxy.http_port != configured_http
    finally:
        proxy.stop()
        blocker.close()

    # 干净启动（端口都空闲）不应残留漂移标记
    proxy2 = proxy_core.ProxyCore()
    try:
        proxy2.start(_config(18986, 18987))
        time.sleep(0.3)
        assert proxy2.port_fallback is None
    finally:
        proxy2.stop()


def test_port_conflict_message_names_both_ports():
    """漂移记录要能直接拼出「配置端口 → 实际端口」的用户可读文案。"""
    configured_socks, configured_http = 18988, 18989
    blocker = _occupy(configured_socks)
    proxy = proxy_core.ProxyCore()
    try:
        proxy.start(_config(configured_socks, configured_http))
        time.sleep(0.3)
        message = proxy.port_fallback_message()
        assert message, "没有生成用户可读的漂移说明"
        assert str(configured_socks) in message
        assert str(proxy.socks_port) in message
    finally:
        proxy.stop()
        blocker.close()
