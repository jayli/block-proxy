"""本地代理单端口（SOCKS5/HTTP 合一）回归测试。

背景：旧版本本地 SOCKS5 与 HTTP 各监听一个端口（默认 1080/1087）；
现在合并为同一端口，按连接首字节自适应分发（0x05 → SOCKS5，其余 →
HTTP），且只绑 127.0.0.1，不接受本机以外的流量。
"""

import asyncio
import ipaddress
import os
import socket
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core
from config import DEFAULT_CONFIG


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _config(local_port, upstream_port):
    return {
        "server": {
            "protocol": "socks5",
            "address": "127.0.0.1",
            "port": upstream_port,
            "username": "",
            "password": "",
            "tls": False,
        },
        "local": {
            "port": local_port,
            # 强制走上游：否则目标是 127.0.0.1 会被判定私有地址直连，
            # 测不到「本地入口 → 上游握手」的完整链路
            "proxy_private": True,
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


async def _mock_upstream(reader, writer):
    """最小 SOCKS5 上游：免认证 CONNECT，成功后双向中继到目标。"""
    try:
        header = await reader.readexactly(2)
        await reader.readexactly(header[1])
        writer.write(b"\x05\x00")
        await writer.drain()

        req = await reader.readexactly(4)
        atyp = req[3]
        if atyp == 0x01:
            raw = await reader.readexactly(4)
            target_host = str(ipaddress.IPv4Address(raw))
        elif atyp == 0x03:
            length = (await reader.readexactly(1))[0]
            target_host = (await reader.readexactly(length)).decode("utf-8")
        else:
            writer.close()
            return
        target_port = struct.unpack("!H", await reader.readexactly(2))[0]

        try:
            t_reader, t_writer = await asyncio.open_connection(target_host, target_port)
        except OSError:
            writer.write(b"\x05\x05\x00\x01" + b"\x00" * 6)
            await writer.drain()
            writer.close()
            return

        writer.write(b"\x05\x00\x00\x01" + b"\x00" * 6)
        await writer.drain()

        async def _pipe(src, dst):
            try:
                while True:
                    data = await src.read(4096)
                    if not data:
                        break
                    dst.write(data)
                    await dst.drain()
            except (ConnectionResetError, BrokenPipeError, OSError):
                pass

        await asyncio.gather(_pipe(reader, t_writer), _pipe(t_reader, writer))
    except (asyncio.IncompleteReadError, ConnectionResetError, BrokenPipeError, OSError):
        pass
    finally:
        writer.close()


async def _echo_target(reader, writer):
    try:
        while True:
            data = await reader.read(4096)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError, OSError):
        pass
    finally:
        writer.close()


def test_default_local_port_is_single_1080():
    assert DEFAULT_CONFIG["local"]["port"] == 1080
    assert "socks_port" not in DEFAULT_CONFIG["local"]
    assert "http_port" not in DEFAULT_CONFIG["local"]


def test_single_port_serves_socks5_and_http_by_first_byte():
    """同一个本地端口：SOCKS5 握手与 HTTP CONNECT 都要能走通。"""

    async def scenario():
        upstream = await asyncio.start_server(_mock_upstream, "127.0.0.1", 0)
        target = await asyncio.start_server(_echo_target, "127.0.0.1", 0)
        upstream_port = upstream.sockets[0].getsockname()[1]
        target_port = target.sockets[0].getsockname()[1]

        proxy = proxy_core.ProxyCore()
        proxy.start(_config(_free_port(), upstream_port))
        await asyncio.sleep(0.3)
        local_port = proxy.local_port
        try:
            # ── SOCKS5 路径（首字节 0x05）──
            r, w = await asyncio.open_connection("127.0.0.1", local_port)
            w.write(b"\x05\x01\x00")
            await w.drain()
            assert await asyncio.wait_for(r.readexactly(2), timeout=5) == b"\x05\x00"
            w.write(
                b"\x05\x01\x00\x01"
                + socket.inet_aton("127.0.0.1")
                + struct.pack("!H", target_port)
            )
            await w.drain()
            reply = await asyncio.wait_for(r.readexactly(10), timeout=5)
            assert reply[:2] == b"\x05\x00", f"SOCKS5 CONNECT 失败: {reply!r}"
            w.write(b"hello-socks")
            await w.drain()
            assert await asyncio.wait_for(r.readexactly(11), timeout=5) == b"hello-socks"
            w.close()

            # ── HTTP 路径（首字节不是 0x05）：同一个端口 ──
            r2, w2 = await asyncio.open_connection("127.0.0.1", local_port)
            w2.write(
                f"CONNECT 127.0.0.1:{target_port} HTTP/1.1\r\n"
                f"Host: 127.0.0.1:{target_port}\r\n\r\n".encode()
            )
            await w2.drain()
            status = await asyncio.wait_for(r2.readline(), timeout=5)
            assert b"200" in status, f"HTTP CONNECT 失败: {status!r}"
            while True:  # 消费剩余响应头
                line = await asyncio.wait_for(r2.readline(), timeout=5)
                if line in (b"\r\n", b"\n", b""):
                    break
            w2.write(b"hello-http")
            await w2.drain()
            assert await asyncio.wait_for(r2.readexactly(10), timeout=5) == b"hello-http"
            w2.close()
        finally:
            proxy.stop()
            upstream.close()
            target.close()

    asyncio.run(scenario())


def test_single_port_rejects_garbage_first_byte():
    """既不是 SOCKS5 也不是合法 HTTP 请求行的连接要被关闭，不能挂住。"""

    async def scenario():
        upstream = await asyncio.start_server(_mock_upstream, "127.0.0.1", 0)
        upstream_port = upstream.sockets[0].getsockname()[1]

        proxy = proxy_core.ProxyCore()
        proxy.start(_config(_free_port(), upstream_port))
        await asyncio.sleep(0.3)
        local_port = proxy.local_port
        try:
            r, w = await asyncio.open_connection("127.0.0.1", local_port)
            w.write(b"\x00garbage\r\n")
            await w.drain()
            # HTTP 分支解析不出合法请求行 → 直接关闭
            data = await asyncio.wait_for(r.read(1024), timeout=5)
            assert data == b"", f"垃圾连接未被干净关闭: {data!r}"
            w.close()
        finally:
            proxy.stop()
            upstream.close()

    asyncio.run(scenario())


def test_local_listener_binds_loopback_only():
    """本地代理端口必须只绑 127.0.0.1（仅监听本机流量）。"""

    async def scenario():
        upstream = await asyncio.start_server(_mock_upstream, "127.0.0.1", 0)
        upstream_port = upstream.sockets[0].getsockname()[1]

        proxy = proxy_core.ProxyCore()
        proxy.start(_config(_free_port(), upstream_port))
        await asyncio.sleep(0.3)
        try:
            socks = proxy._local_server.sockets
            assert socks, "本地 listener 未就绪"
            for sock in socks:
                bind_addr = sock.getsockname()[0]
                assert bind_addr == "127.0.0.1", f"listener 绑到了 {bind_addr}"
        finally:
            proxy.stop()
            upstream.close()

    asyncio.run(scenario())
