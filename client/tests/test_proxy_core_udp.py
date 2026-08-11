import asyncio
import struct
import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from proxy_core import (
    write_udp_frame, read_udp_frame, ProxyCore, _UdpRelayProtocol,
    connect_upstream_udp_associate,
)


class TestUdpFrameEncoding:
    @staticmethod
    async def _make_pipe():
        """Create a TCP loopback connection pair for testing."""
        server_ready = asyncio.Event()
        conns = []

        async def on_connect(reader, writer):
            conns.append((reader, writer))
            server_ready.set()

        server = await asyncio.start_server(on_connect, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        c_reader, c_writer = await asyncio.open_connection("127.0.0.1", port)
        await asyncio.wait_for(server_ready.wait(), timeout=2)
        s_reader, s_writer = conns[0]
        server.close()
        return c_reader, c_writer, s_reader, s_writer

    def test_frame_round_trip(self):
        async def _run():
            c_reader, c_writer, s_reader, s_writer = await self._make_pipe()

            payload = b"\x00\x00\x00\x01\x7f\x00\x00\x01\x00\x50test data"
            await write_udp_frame(s_writer, payload)
            result = await asyncio.wait_for(read_udp_frame(c_reader), timeout=2)
            assert result == payload

            c_writer.close()
            s_writer.close()

        asyncio.run(_run())

    def test_multiple_frames(self):
        async def _run():
            c_reader, c_writer, s_reader, s_writer = await self._make_pipe()

            payloads = [b"frame1_data", b"frame2_data_longer", b"f3"]
            for p in payloads:
                await write_udp_frame(s_writer, p)

            for p in payloads:
                result = await asyncio.wait_for(read_udp_frame(c_reader), timeout=2)
                assert result == p

            c_writer.close()
            s_writer.close()

        asyncio.run(_run())

    def test_empty_frame_raises(self):
        async def _run():
            c_reader, c_writer, s_reader, s_writer = await self._make_pipe()

            s_writer.write(struct.pack("!H", 0))
            await s_writer.drain()

            with pytest.raises(Exception, match="invalid UDP frame length"):
                await asyncio.wait_for(read_udp_frame(c_reader), timeout=2)

            c_writer.close()
            s_writer.close()

        asyncio.run(_run())


class TestUdpRelayProtocol:
    def test_datagram_received_writes_frame(self):
        async def _run():
            server_ready = asyncio.Event()
            conns = []

            async def on_connect(reader, writer):
                conns.append((reader, writer))
                server_ready.set()

            server = await asyncio.start_server(on_connect, "127.0.0.1", 0)
            port = server.sockets[0].getsockname()[1]
            c_reader, c_writer = await asyncio.open_connection("127.0.0.1", port)
            await asyncio.wait_for(server_ready.wait(), timeout=2)
            s_reader, s_writer = conns[0]
            server.close()

            loop = asyncio.get_event_loop()
            proto = _UdpRelayProtocol(s_writer, loop)
            proto.connection_made(None)

            data = b"\x00\x00\x00\x01\x08\x08\x08\x08\x00\x35dns_query"
            proto.datagram_received(data, ("127.0.0.1", 54321))

            assert proto.client_addr == ("127.0.0.1", 54321)

            # Need to flush since datagram_received doesn't await drain
            await asyncio.sleep(0.05)
            frame = await asyncio.wait_for(read_udp_frame(c_reader), timeout=2)
            assert frame == data

            c_writer.close()
            s_writer.close()

        asyncio.run(_run())


class TestMockSocks5UdpServer:
    """End-to-end test with a mock SOCKS5 server that supports UDP over TCP framing."""

    @staticmethod
    async def _mock_socks5_server(reader, writer):
        # Auth negotiation
        header = await reader.readexactly(2)
        nmethods = header[1]
        await reader.readexactly(nmethods)
        writer.write(b"\x05\x00")  # No auth
        await writer.drain()

        # Request
        req = await reader.readexactly(4)
        cmd = req[1]
        atyp = req[3]
        if atyp == 0x01:
            await reader.readexactly(4 + 2)
        elif atyp == 0x03:
            length = (await reader.readexactly(1))[0]
            await reader.readexactly(length + 2)
        elif atyp == 0x04:
            await reader.readexactly(16 + 2)

        if cmd != 0x03:
            writer.write(b"\x05\x07\x00\x01" + b"\x00" * 4 + b"\x00\x00")
            await writer.drain()
            writer.close()
            return

        # UDP ASSOCIATE success
        writer.write(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
        await writer.drain()

        # Echo server: read frames and echo back with modified payload
        try:
            while True:
                length_data = await reader.readexactly(2)
                length = struct.unpack("!H", length_data)[0]
                payload = await reader.readexactly(length)

                # Parse SOCKS5 UDP header to find data offset, then echo with "REPLY:" prefix
                if len(payload) < 10:
                    continue
                atyp = payload[3]
                if atyp == 0x01:
                    header_len = 10
                elif atyp == 0x03:
                    header_len = 5 + payload[4] + 2
                elif atyp == 0x04:
                    header_len = 22
                else:
                    continue

                udp_header = payload[:header_len]
                udp_data = payload[header_len:]
                response_data = b"REPLY:" + udp_data
                response_payload = udp_header + response_data

                frame = struct.pack("!H", len(response_payload)) + response_payload
                writer.write(frame)
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionResetError, BrokenPipeError):
            pass
        finally:
            writer.close()

    def test_udp_associate_end_to_end(self):
        """Test with ProxyCore in its own thread connecting to mock server."""
        import socket as sock_mod
        import threading

        # Start mock server in a background thread with its own loop
        mock_loop = asyncio.new_event_loop()
        server_ready = threading.Event()
        server_port_holder = [0]
        stop_event = asyncio.Event()

        def run_mock_server():
            asyncio.set_event_loop(mock_loop)
            async def _start():
                server = await asyncio.start_server(
                    self._mock_socks5_server, "127.0.0.1", 0
                )
                server_port_holder[0] = server.sockets[0].getsockname()[1]
                server_ready.set()
                await stop_event.wait()
                server.close()
                await server.wait_closed()
            try:
                mock_loop.run_until_complete(_start())
            except Exception:
                pass
            finally:
                mock_loop.close()

        t = threading.Thread(target=run_mock_server, daemon=True)
        t.start()
        server_ready.wait(timeout=5)
        server_port = server_port_holder[0]

        config = {
            "server": {
                "protocol": "socks5",
                "address": "127.0.0.1",
                "port": server_port,
                "username": "",
                "password": "",
                "tls": False,
                "allowInsecure": True,
            },
            "local": {
                "socks_port": 0,
                "http_port": 0,
                "udp": True,
            },
        }

        s = sock_mod.socket()
        s.bind(("127.0.0.1", 0))
        config["local"]["socks_port"] = s.getsockname()[1]
        s.close()
        s = sock_mod.socket()
        s.bind(("127.0.0.1", 0))
        config["local"]["http_port"] = s.getsockname()[1]
        s.close()

        proxy = ProxyCore()
        proxy.start(config)
        actual_socks_port = proxy.socks_port

        import time
        time.sleep(0.2)

        try:
            # Connect to proxy's local SOCKS5 port
            ctrl_sock = sock_mod.socket(sock_mod.AF_INET, sock_mod.SOCK_STREAM)
            ctrl_sock.settimeout(5)
            ctrl_sock.connect(("127.0.0.1", actual_socks_port))

            # SOCKS5 handshake
            ctrl_sock.sendall(b"\x05\x01\x00")
            resp = ctrl_sock.recv(2)
            assert resp == b"\x05\x00"

            # UDP ASSOCIATE
            ctrl_sock.sendall(b"\x05\x03\x00\x01\x00\x00\x00\x00\x00\x00")
            reply = ctrl_sock.recv(10)
            assert len(reply) == 10
            assert reply[1] == 0x00
            relay_port = struct.unpack("!H", reply[8:10])[0]
            assert relay_port > 0

            # Send UDP to relay
            udp_sock = sock_mod.socket(sock_mod.AF_INET, sock_mod.SOCK_DGRAM)
            udp_sock.settimeout(5)

            udp_header = b"\x00\x00\x00\x01\x08\x08\x08\x08\x00\x35"
            udp_data = b"hello_udp"
            udp_sock.sendto(udp_header + udp_data, ("127.0.0.1", relay_port))

            # Receive response
            response, _ = udp_sock.recvfrom(65535)
            assert response[10:] == b"REPLY:hello_udp"

            udp_sock.close()
            ctrl_sock.close()
        finally:
            proxy.stop()
            mock_loop.call_soon_threadsafe(stop_event.set)

    def test_udp_associate_with_auth(self):
        async def _mock_auth_server(reader, writer):
            header = await reader.readexactly(2)
            nmethods = header[1]
            await reader.readexactly(nmethods)
            writer.write(b"\x05\x02")  # Username/password auth
            await writer.drain()

            # Read auth: [ver(1), ulen(1), username(ulen), plen(1), password(plen)]
            ver = await reader.readexactly(1)
            ulen_b = await reader.readexactly(1)
            ulen = ulen_b[0]
            username = (await reader.readexactly(ulen)).decode()
            plen_b = await reader.readexactly(1)
            plen = plen_b[0]
            password = (await reader.readexactly(plen)).decode()

            if username == "testuser" and password == "testpass":
                writer.write(b"\x01\x00")
            else:
                writer.write(b"\x01\xff")
                writer.close()
                return
            await writer.drain()

            # Request
            req = await reader.readexactly(4)
            if req[3] == 0x01:
                await reader.readexactly(6)

            writer.write(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
            await writer.drain()

            # Keep connection alive briefly
            try:
                await asyncio.wait_for(reader.read(1), timeout=2)
            except (asyncio.TimeoutError, ConnectionResetError):
                pass
            writer.close()

        async def _run():
            server = await asyncio.start_server(
                _mock_auth_server, "127.0.0.1", 0
            )
            server_port = server.sockets[0].getsockname()[1]

            config = {
                "address": "127.0.0.1",
                "port": server_port,
                "username": "testuser",
                "password": "testpass",
                "tls": False,
                "allowInsecure": True,
            }

            reader, writer = await connect_upstream_udp_associate(config)
            assert reader is not None
            assert writer is not None
            writer.close()
            await writer.wait_closed()
            server.close()
            await server.wait_closed()

        asyncio.run(_run())


class TestUdpDisabled:
    def test_http_protocol_rejects_udp(self):
        async def _run():
            import socket as sock_mod

            config = {
                "server": {
                    "protocol": "http",
                    "address": "127.0.0.1",
                    "port": 9999,
                    "username": "",
                    "password": "",
                    "tls": False,
                    "allowInsecure": True,
                },
                "local": {
                    "socks_port": 0,
                    "http_port": 0,
                    "udp": True,
                },
            }

            s = sock_mod.socket()
            s.bind(("127.0.0.1", 0))
            socks_port = s.getsockname()[1]
            s.close()
            s = sock_mod.socket()
            s.bind(("127.0.0.1", 0))
            http_port = s.getsockname()[1]
            s.close()

            config["local"]["socks_port"] = socks_port
            config["local"]["http_port"] = http_port

            proxy = ProxyCore()
            proxy.start(config)
            actual_socks_port = proxy.socks_port

            await asyncio.sleep(0.1)

            reader, writer = await asyncio.open_connection("127.0.0.1", actual_socks_port)
            writer.write(b"\x05\x01\x00")
            await writer.drain()
            await reader.readexactly(2)

            # UDP ASSOCIATE
            writer.write(b"\x05\x03\x00\x01\x00\x00\x00\x00\x00\x00")
            await writer.drain()

            reply = await asyncio.wait_for(reader.readexactly(10), timeout=5)
            assert reply[1] == 0x07  # Command not supported

            writer.close()
            await writer.wait_closed()
            proxy.stop()

        asyncio.run(_run())

    def test_udp_false_config_rejects_udp(self):
        async def _run():
            import socket as sock_mod

            config = {
                "server": {
                    "protocol": "socks5",
                    "address": "127.0.0.1",
                    "port": 9999,
                    "username": "",
                    "password": "",
                    "tls": False,
                    "allowInsecure": True,
                },
                "local": {
                    "socks_port": 0,
                    "http_port": 0,
                    "udp": False,
                },
            }

            s = sock_mod.socket()
            s.bind(("127.0.0.1", 0))
            socks_port = s.getsockname()[1]
            s.close()
            s = sock_mod.socket()
            s.bind(("127.0.0.1", 0))
            http_port = s.getsockname()[1]
            s.close()

            config["local"]["socks_port"] = socks_port
            config["local"]["http_port"] = http_port

            proxy = ProxyCore()
            proxy.start(config)
            actual_socks_port = proxy.socks_port

            await asyncio.sleep(0.1)

            reader, writer = await asyncio.open_connection("127.0.0.1", actual_socks_port)
            writer.write(b"\x05\x01\x00")
            await writer.drain()
            await reader.readexactly(2)

            writer.write(b"\x05\x03\x00\x01\x00\x00\x00\x00\x00\x00")
            await writer.drain()

            reply = await asyncio.wait_for(reader.readexactly(10), timeout=5)
            assert reply[1] == 0x07  # Command not supported

            writer.close()
            await writer.wait_closed()
            proxy.stop()

        asyncio.run(_run())
