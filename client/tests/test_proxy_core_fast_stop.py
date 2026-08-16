"""stop() 快速确定性关停回归测试。

背景：旧实现 _shutdown 协程内调用 loop.stop()，run_forever 在
run_coroutine_threadsafe 的 future 完成回调执行前退出，future 永不
resolve，.result(timeout=8) 必然超时 —— 每次关闭代理固定白等 8 秒。
"""

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


def _port_is_free(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def test_stop_completes_fast_and_releases_ports():
    socks_port, http_port = 18970, 18971
    proxy = proxy_core.ProxyCore()
    proxy.start(_config(socks_port, http_port))
    time.sleep(0.3)  # 等待 listener 就绪
    assert _port_is_free(socks_port) is False

    t0 = time.monotonic()
    proxy.stop()
    elapsed = time.monotonic() - t0

    # 旧实现固定 8.0s；新实现正常路径 <1s（安全网超时除外）
    assert elapsed < 2.0, f"stop took {elapsed:.2f}s"
    assert _port_is_free(socks_port), "socks 端口未释放"
    assert _port_is_free(http_port), "http 端口未释放"
    assert not proxy.is_running()


def test_stop_with_active_connection_aborts_transport_and_stays_fast():
    socks_port, http_port = 18972, 18973
    proxy = proxy_core.ProxyCore()
    proxy.start(_config(socks_port, http_port))
    time.sleep(0.3)

    # 模拟一个活跃客户端连接：注册 transport，让旧实现 wait_closed 需等待
    class FakeTransport:
        def __init__(self):
            self.aborted = False

        def abort(self):
            self.aborted = True

    transport = FakeTransport()
    proxy._active_transports.add(transport)

    t0 = time.monotonic()
    proxy.stop()
    elapsed = time.monotonic() - t0

    assert elapsed < 2.0, f"stop took {elapsed:.2f}s"
    assert transport.aborted, "全量 stop 应主动 abort 活跃连接"
    assert _port_is_free(socks_port)
    assert _port_is_free(http_port)
