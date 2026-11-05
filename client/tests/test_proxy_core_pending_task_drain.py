"""stop() 必须在 loop.close() 之前清空遗留的连接协程。

背景（2026-11-05 13:19:58 闪退现场）：保存分流规则触发重连，stop()
关掉 listener 并 loop.close()，但已经 accept 的 _handle_local 协程还挂在
上游建连的 await 上 —— 它们既不属于 server，也不走 _active_transports 的
收尾路径，一直留到下一次 GC 才被 close()。那时它们会往已关闭的 loop 里
call_soon（asyncio 的 bare except 把 GeneratorExit 换成
"RuntimeError: Event loop is closed"），崩溃报告里 Nuitka 编译版的
协程终结器在异常回溯链的重复 close 里段错误退出。
"""

import asyncio
import gc
import os
import socket
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core


def _config(port):
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
            "port": port,
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


def _open_connect_sockets(port, count=6):
    """建 count 条 CONNECT 请求，让 handler 卡在被 patch 住的上游建连上。"""
    socks = []
    for _ in range(count):
        sock = socket.create_connection(("127.0.0.1", port), timeout=2)
        sock.sendall(
            b"CONNECT 10.0.0.1:443 HTTP/1.1\r\nHost: 10.0.0.1:443\r\n\r\n"
        )
        socks.append(sock)
    return socks


def test_stop_leaves_no_pending_tasks_on_closed_loop(monkeypatch):
    async def _hang(host, port):
        await asyncio.sleep(3600)

    monkeypatch.setattr(proxy_core, "_open_direct", _hang)

    port = 18974
    proxy = proxy_core.ProxyCore()
    proxy.start(_config(port))
    time.sleep(0.3)

    loop = proxy._loop
    socks = _open_connect_sockets(port)
    time.sleep(0.4)

    assert len(asyncio.all_tasks(loop)) >= 6, "测试前提：handler 协程应挂在建连上"

    t0 = time.monotonic()
    proxy.stop()
    elapsed = time.monotonic() - t0

    leftover = asyncio.all_tasks(loop)
    for sock in socks:
        try:
            sock.close()
        except OSError:
            pass

    assert elapsed < 4.0, f"stop took {elapsed:.2f}s"
    assert loop.is_closed(), "loop 应已关闭"
    assert leftover == set(), (
        f"loop 关闭后仍有 {len(leftover)} 个协程残留："
        f"{[t.get_coro().__qualname__ for t in leftover]}"
    )

    # 复现现场条件：没有残留协程时，GC 不应该在关闭的 loop 上 close() 任何
    # 协程（否则会打出 "Task was destroyed but it is pending!" / RuntimeError）
    gc.collect()


def test_stop_without_inflight_connections_still_fast():
    port = 18975
    proxy = proxy_core.ProxyCore()
    proxy.start(_config(port))
    time.sleep(0.3)

    t0 = time.monotonic()
    proxy.stop()
    elapsed = time.monotonic() - t0

    assert elapsed < 2.0, f"stop took {elapsed:.2f}s"
    assert not proxy.is_running()
