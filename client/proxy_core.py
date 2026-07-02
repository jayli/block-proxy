import asyncio
import functools
import ipaddress
import logging
import ssl
import struct
import threading

logger = logging.getLogger("proxy_core")

from logger import access_logger, crash_logger
from traffic_stats import add_bytes, flush as flush_stats, init_writer


def _log_access(dest_addr, dest_port, method, direct, error=None):
    route = "direct" if direct else "proxy"
    if error:
        access_logger.info(f"{method} | {dest_addr}:{dest_port} | {route} | {error}")
    else:
        access_logger.info(f"{method} | {dest_addr}:{dest_port} | {route}")


PRIVATE_NETWORKS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]


@functools.lru_cache(maxsize=256)
def is_private_ip(host):
    try:
        addr = ipaddress.ip_address(host)
        return any(addr in net for net in PRIVATE_NETWORKS)
    except ValueError:
        return False


RELAY_IDLE_TIMEOUT = 300
UDP_IDLE_TIMEOUT = 120


async def write_udp_frame(writer, data):
    frame = struct.pack("!H", len(data)) + data
    writer.write(frame)
    await writer.drain()


async def read_udp_frame(reader):
    length_data = await reader.readexactly(2)
    length = struct.unpack("!H", length_data)[0]
    if length == 0 or length > 65535:
        raise Exception("invalid UDP frame length")
    return await reader.readexactly(length)


async def relay(reader, writer, route=None, direction=None):
    try:
        while True:
            data = await asyncio.wait_for(reader.read(65536), timeout=RELAY_IDLE_TIMEOUT)
            if not data:
                break
            writer.write(data)
            if route and direction:
                add_bytes(len(data), route, direction)
            if writer.transport.get_write_buffer_size() > 65536:
                await writer.drain()
    except asyncio.TimeoutError:
        pass
    except (ConnectionResetError, BrokenPipeError, OSError):
        pass
    finally:
        try:
            if writer.can_write_eof():
                writer.write_eof()
            else:
                writer.close()
                await writer.wait_closed()
        except OSError:
            pass


CONNECT_TIMEOUT = 10
HANDSHAKE_TIMEOUT = 10
LOCAL_HANDSHAKE_TIMEOUT = 30


async def connect_upstream_socks5(server_config, dest_addr, dest_port, ssl_ctx=None):
    host = server_config["address"]
    port = server_config["port"]
    username = server_config["username"]
    password = server_config["password"]
    use_tls = server_config["tls"]

    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(
            host, port, ssl=ssl_ctx if use_tls else None,
            server_hostname=host if use_tls else None,
        ),
        timeout=CONNECT_TIMEOUT,
    )

    async def _handshake():
        if username and password:
            writer.write(b"\x05\x01\x02")
        else:
            writer.write(b"\x05\x01\x00")
        await writer.drain()

        resp = await reader.readexactly(2)
        if resp[0] != 0x05:
            raise Exception("SOCKS5 version mismatch")

        if resp[1] == 0x02:
            uname = username.encode("utf-8")
            passwd = password.encode("utf-8")
            writer.write(
                b"\x01"
                + struct.pack("B", len(uname))
                + uname
                + struct.pack("B", len(passwd))
                + passwd
            )
            await writer.drain()
            auth_resp = await reader.readexactly(2)
            if auth_resp[1] != 0x00:
                raise Exception("SOCKS5 auth failed")
        elif resp[1] == 0xFF:
            raise Exception("SOCKS5 no acceptable auth method")

        try:
            addr = ipaddress.ip_address(dest_addr)
            if isinstance(addr, ipaddress.IPv4Address):
                addr_data = b"\x01" + addr.packed
            else:
                addr_data = b"\x04" + addr.packed
        except ValueError:
            encoded = dest_addr.encode("utf-8")
            addr_data = b"\x03" + struct.pack("B", len(encoded)) + encoded

        writer.write(
            b"\x05\x01\x00" + addr_data + struct.pack("!H", dest_port)
        )
        await writer.drain()

        reply = await reader.readexactly(4)
        if reply[1] != 0x00:
            raise Exception(f"SOCKS5 CONNECT failed: {reply[1]:#x}")

        if reply[3] == 0x01:
            await reader.readexactly(4 + 2)
        elif reply[3] == 0x03:
            length = (await reader.readexactly(1))[0]
            await reader.readexactly(length + 2)
        elif reply[3] == 0x04:
            await reader.readexactly(16 + 2)

    try:
        await asyncio.wait_for(_handshake(), timeout=HANDSHAKE_TIMEOUT)
    except Exception:
        writer.close()
        try:
            await writer.wait_closed()
        except OSError:
            pass
        raise

    return reader, writer


async def connect_upstream_http(server_config, dest_addr, dest_port, ssl_ctx=None):
    host = server_config["address"]
    port = server_config["port"]
    username = server_config["username"]
    password = server_config["password"]
    use_tls = server_config["tls"]

    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(
            host, port, ssl=ssl_ctx if use_tls else None,
            server_hostname=host if use_tls else None,
        ),
        timeout=CONNECT_TIMEOUT,
    )

    async def _handshake():
        target = f"{dest_addr}:{dest_port}"
        lines = [f"CONNECT {target} HTTP/1.1", f"Host: {target}"]
        if username and password:
            import base64
            cred = base64.b64encode(f"{username}:{password}".encode()).decode()
            lines.append(f"Proxy-Authorization: Basic {cred}")
        lines.append("")
        lines.append("")
        writer.write("\r\n".join(lines).encode())
        await writer.drain()

        status_line = await reader.readline()
        if not status_line:
            raise Exception("HTTP proxy closed connection")
        parts = status_line.decode().split(" ", 2)
        if len(parts) < 2 or not parts[1].startswith("2"):
            raise Exception(f"HTTP proxy CONNECT failed: {status_line.decode().strip()}")
        while True:
            line = await reader.readline()
            if line in (b"\r\n", b"\n", b""):
                break

    try:
        await asyncio.wait_for(_handshake(), timeout=HANDSHAKE_TIMEOUT)
    except Exception:
        writer.close()
        try:
            await writer.wait_closed()
        except OSError:
            pass
        raise

    return reader, writer


async def connect_upstream_udp_associate(server_config, ssl_ctx=None):
    host = server_config["address"]
    port = server_config["port"]
    username = server_config["username"]
    password = server_config["password"]
    use_tls = server_config["tls"]

    reader, writer = await asyncio.wait_for(
        asyncio.open_connection(
            host, port, ssl=ssl_ctx if use_tls else None,
            server_hostname=host if use_tls else None,
        ),
        timeout=CONNECT_TIMEOUT,
    )

    async def _handshake():
        if username and password:
            writer.write(b"\x05\x01\x02")
        else:
            writer.write(b"\x05\x01\x00")
        await writer.drain()

        resp = await reader.readexactly(2)
        if resp[0] != 0x05:
            raise Exception("SOCKS5 version mismatch")

        if resp[1] == 0x02:
            uname = username.encode("utf-8")
            passwd = password.encode("utf-8")
            writer.write(
                b"\x01"
                + struct.pack("B", len(uname))
                + uname
                + struct.pack("B", len(passwd))
                + passwd
            )
            await writer.drain()
            auth_resp = await reader.readexactly(2)
            if auth_resp[1] != 0x00:
                raise Exception("SOCKS5 auth failed")
        elif resp[1] == 0xFF:
            raise Exception("SOCKS5 no acceptable auth method")

        # CMD=0x03 UDP ASSOCIATE, DST.ADDR=0.0.0.0:0
        writer.write(b"\x05\x03\x00\x01" + b"\x00" * 4 + b"\x00\x00")
        await writer.drain()

        reply = await reader.readexactly(4)
        if reply[1] != 0x00:
            raise Exception(f"SOCKS5 UDP ASSOCIATE failed: {reply[1]:#x}")

        if reply[3] == 0x01:
            await reader.readexactly(4 + 2)
        elif reply[3] == 0x03:
            length = (await reader.readexactly(1))[0]
            await reader.readexactly(length + 2)
        elif reply[3] == 0x04:
            await reader.readexactly(16 + 2)

    try:
        await asyncio.wait_for(_handshake(), timeout=HANDSHAKE_TIMEOUT)
    except Exception:
        writer.close()
        try:
            await writer.wait_closed()
        except OSError:
            pass
        raise

    return reader, writer


async def connect_direct(dest_addr, dest_port):
    return await asyncio.open_connection(dest_addr, dest_port)


MAX_CONCURRENT = 256


class _UdpRelayProtocol(asyncio.DatagramProtocol):
    def __init__(self, tcp_writer, loop):
        self._tcp_writer = tcp_writer
        self._loop = loop
        self.client_addr = None
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        self.client_addr = addr
        if self._tcp_writer.is_closing():
            return
        frame = struct.pack("!H", len(data)) + data
        self._tcp_writer.write(frame)
        add_bytes(len(data), "proxy", "outbound")


class ProxyCore:
    def __init__(self):
        self._loop = None
        self._thread = None
        self._socks_server = None
        self._http_server = None
        self._running = False
        self._server_config = None
        self._proxy_private = False
        self._udp_enabled = True
        self._socks_port = 1080
        self._http_port = 1087
        self._ssl_ctx = None
        self._semaphore = None
        self._routing = None
        self._tunnel_client = None

    def set_tunnel_client(self, tc):
        self._tunnel_client = tc

    def _build_ssl_context(self):
        server = self._server_config
        if not server["tls"]:
            self._ssl_ctx = None
            return
        ctx = ssl.create_default_context()
        if server["allowInsecure"]:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        self._ssl_ctx = ctx

    def start(self, user_config, config_dir=None):
        if self._running:
            self.stop()

        self._server_config = user_config["server"]
        local = user_config["local"]
        self._socks_port = local["socks_port"]
        self._http_port = local["http_port"]
        self._proxy_private = local.get("proxy_private", False)
        self._udp_enabled = local.get("udp", True)
        self._build_ssl_context()

        # Initialize routing engine (geodata loaded selectively in RoutingEngine.__init__)
        from routing import RoutingEngine, _geodata_dir
        routing_config = user_config.get("routing", {})
        self._routing = RoutingEngine(routing_config, _geodata_dir())

        self._loop = asyncio.new_event_loop()
        started = threading.Event()
        self._start_error = None
        self._thread = threading.Thread(
            target=self._run_loop, args=(started,), daemon=True
        )
        self._thread.start()
        started.wait(timeout=5)
        if self._start_error:
            raise self._start_error
        self._running = True

    def stop(self):
        if not self._running:
            return
        self._running = False
        if self._loop and self._loop.is_running():
            def _shutdown():
                if self._socks_server:
                    self._socks_server.close()
                if self._http_server:
                    self._http_server.close()
                self._loop.stop()
            self._loop.call_soon_threadsafe(_shutdown)
        if self._thread:
            self._thread.join(timeout=5)
            if not self._thread.is_alive() and self._loop:
                self._loop.close()
            elif self._loop:
                logger.warning("proxy thread did not exit in time, skipping loop.close()")
        self._loop = None
        self._thread = None

    def is_running(self):
        return self._running and self._thread is not None and self._thread.is_alive()

    @property
    def socks_port(self):
        return self._socks_port

    @property
    def http_port(self):
        return self._http_port

    async def _measure_latency(self):
        import time
        protocol = self._server_config.get("protocol", "socks5")
        username = self._server_config.get("username", "")
        password = self._server_config.get("password", "")

        start = time.monotonic()
        reader = None
        writer = None
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(
                    self._server_config["address"],
                    self._server_config["port"],
                    ssl=self._ssl_ctx if self._server_config["tls"] else None,
                    server_hostname=self._server_config["address"] if self._server_config["tls"] else None,
                ),
                timeout=5,
            )

            if protocol == "http":
                await self._measure_latency_http(reader, writer, username, password)
            else:
                await self._measure_latency_socks5(reader, writer, username, password)

            elapsed = time.monotonic() - start
            return int(elapsed * 1000)
        except Exception:
            return None
        finally:
            if writer:
                writer.close()
                try:
                    await writer.wait_closed()
                except OSError:
                    pass

    async def _measure_latency_socks5(self, reader, writer, username, password):
        if username and password:
            writer.write(b"\x05\x01\x02")
        else:
            writer.write(b"\x05\x01\x00")
        await writer.drain()
        resp = await asyncio.wait_for(reader.readexactly(2), timeout=5)
        if resp[0] != 0x05:
            raise Exception("not a SOCKS5 server")
        if resp[1] == 0x02 and username and password:
            uname = username.encode("utf-8")
            passwd = password.encode("utf-8")
            writer.write(
                b"\x01"
                + struct.pack("B", len(uname)) + uname
                + struct.pack("B", len(passwd)) + passwd
            )
            await writer.drain()
            auth_resp = await asyncio.wait_for(reader.readexactly(2), timeout=5)
            if auth_resp[1] != 0x00:
                raise Exception("SOCKS5 auth failed")

    async def _measure_latency_http(self, reader, writer, username, password):
        import base64
        target = "127.0.0.1:80"
        lines = [f"CONNECT {target} HTTP/1.1", f"Host: {target}"]
        if username and password:
            cred = base64.b64encode(f"{username}:{password}".encode()).decode()
            lines.append(f"Proxy-Authorization: Basic {cred}")
        lines.append("")
        lines.append("")
        writer.write("\r\n".join(lines).encode())
        await writer.drain()

        status_line = await asyncio.wait_for(reader.readline(), timeout=5)
        if not status_line:
            raise Exception("HTTP proxy closed connection")
        parts = status_line.decode().split(" ", 2)
        if len(parts) < 2 or not parts[1].startswith("2"):
            raise Exception(f"HTTP proxy CONNECT failed: {status_line.decode().strip()}")

    def measure_latency(self):
        if not self._running or not self._loop or not self._loop.is_running():
            return None
        if self._server_config and self._server_config.get("protocol") == "tunnel":
            return "tunnel"
        future = asyncio.run_coroutine_threadsafe(self._measure_latency(), self._loop)
        try:
            return future.result(timeout=6)
        except Exception:
            return None

    def _run_loop(self, started_event):
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._start_servers())
        except OSError as e:
            self._start_error = e
            started_event.set()
            return
        started_event.set()
        self._loop.run_forever()

    async def _start_servers(self):
        self._semaphore = asyncio.Semaphore(MAX_CONCURRENT)
        init_writer()
        asyncio.ensure_future(self._flush_stats_loop())
        max_attempts = 100
        for attempt in range(max_attempts):
            try:
                self._socks_server = await asyncio.start_server(
                    self._handle_socks, "127.0.0.1", self._socks_port
                )
                self._http_server = await asyncio.start_server(
                    self._handle_http, "127.0.0.1", self._http_port
                )
                return
            except OSError as e:
                if e.errno == 48 and attempt < max_attempts - 1:
                    if self._socks_server:
                        self._socks_server.close()
                        await self._socks_server.wait_closed()
                        self._socks_server = None
                    self._socks_port += 1
                    self._http_port += 1
                else:
                    raise

    async def _stop_servers(self):
        if self._socks_server:
            self._socks_server.close()
            await self._socks_server.wait_closed()
        if self._http_server:
            self._http_server.close()
            await self._http_server.wait_closed()

    async def _flush_stats_loop(self):
        while True:
            await asyncio.sleep(2)
            flush_stats()

    def _should_direct(self, host):
        if self._proxy_private:
            return False
        return is_private_ip(host)

    def _select_route(self, dest_addr, is_domain=None):
        if is_domain is None:
            # Auto-detect: try parsing as IP address
            try:
                ipaddress.ip_address(dest_addr)
                is_domain = False
            except ValueError:
                is_domain = True

        # 0. Private IP check (highest priority, always direct, not affected by routing)
        if self._should_direct(dest_addr):
            return "direct"

        # 1. Routing check (if enabled)
        if self._routing:
            route = self._routing.resolve(dest_addr, is_domain)
            if route == "direct":
                return "direct"
            # route == "proxy" or resolve returned default → fall through

        # 2. Tunnel check (if protocol is tunnel, always use it)
        if self._server_config.get("protocol") == "tunnel":
            return "tunnel"

        # 3. Fallback: upstream proxy
        return "proxy"

    async def _connect_target(self, dest_addr, dest_port, is_domain=None, route=None):
        if route is None:
            route = self._select_route(dest_addr, is_domain=is_domain)
        if route == "tunnel":
            reader, writer = await self._connect_via_tunnel(dest_addr, dest_port)
            return reader, writer, "tunnel"
        if route == "direct":
            reader, writer = await connect_direct(dest_addr, dest_port)
            return reader, writer, "direct"
        reader, writer = await self._connect_upstream(dest_addr, dest_port)
        return reader, writer, "proxy"

    async def _connect_via_tunnel(self, dest_addr, dest_port):
        loop = asyncio.get_event_loop()
        sock = await loop.run_in_executor(
            None, self._tunnel_client.forward_connect_sync, dest_addr, dest_port
        )
        reader, writer = await asyncio.open_connection(sock=sock)
        return reader, writer

    async def _connect_upstream(self, dest_addr, dest_port):
        protocol = self._server_config.get("protocol", "socks5")
        if protocol == "http":
            return await connect_upstream_http(
                self._server_config, dest_addr, dest_port, ssl_ctx=self._ssl_ctx
            )
        return await connect_upstream_socks5(
            self._server_config, dest_addr, dest_port, ssl_ctx=self._ssl_ctx
        )

    async def _handle_socks(self, client_reader, client_writer):
        async with self._semaphore:
            await self._do_handle_socks(client_reader, client_writer)

    async def _do_handle_socks(self, client_reader, client_writer):
        try:
            header = await asyncio.wait_for(client_reader.readexactly(2), timeout=LOCAL_HANDSHAKE_TIMEOUT)
            ver, nmethods = header
            if ver != 0x05:
                client_writer.close()
                return
            await asyncio.wait_for(client_reader.readexactly(nmethods), timeout=LOCAL_HANDSHAKE_TIMEOUT)

            client_writer.write(b"\x05\x00")
            await client_writer.drain()

            req = await asyncio.wait_for(client_reader.readexactly(4), timeout=LOCAL_HANDSHAKE_TIMEOUT)
            ver, cmd, _, atyp = req

            if cmd == 0x03:
                await self._handle_udp_associate(client_reader, client_writer, atyp)
                return

            if cmd != 0x01:
                client_writer.write(
                    b"\x05\x07\x00\x01" + b"\x00" * 4 + b"\x00\x00"
                )
                await client_writer.drain()
                client_writer.close()
                return

            if atyp == 0x01:
                raw = await asyncio.wait_for(client_reader.readexactly(4), timeout=LOCAL_HANDSHAKE_TIMEOUT)
                dest_addr = str(ipaddress.IPv4Address(raw))
            elif atyp == 0x03:
                length = (await asyncio.wait_for(client_reader.readexactly(1), timeout=LOCAL_HANDSHAKE_TIMEOUT))[0]
                dest_addr = (await asyncio.wait_for(client_reader.readexactly(length), timeout=LOCAL_HANDSHAKE_TIMEOUT)).decode("utf-8")
            elif atyp == 0x04:
                raw = await asyncio.wait_for(client_reader.readexactly(16), timeout=LOCAL_HANDSHAKE_TIMEOUT)
                dest_addr = str(ipaddress.IPv6Address(raw))
            else:
                client_writer.write(
                    b"\x05\x08\x00\x01" + b"\x00" * 4 + b"\x00\x00"
                )
                await client_writer.drain()
                client_writer.close()
                return

            port_data = await asyncio.wait_for(client_reader.readexactly(2), timeout=LOCAL_HANDSHAKE_TIMEOUT)
            dest_port = struct.unpack("!H", port_data)[0]

            # Determine if target is a domain or IP
            try:
                ipaddress.ip_address(dest_addr)
                is_domain = False
            except ValueError:
                is_domain = True

            route = self._select_route(dest_addr, is_domain=is_domain)
            direct = route == "direct"
            try:
                remote_reader, remote_writer, route = await self._connect_target(
                    dest_addr, dest_port, is_domain=is_domain, route=route
                )
            except Exception as e:
                _log_access(dest_addr, dest_port, "CONNECT", direct, str(e))
                if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                    crash_logger.warning(f"SOCKS5 connect failed: {dest_addr}:{dest_port}", exc_info=True)
                return

            _log_access(dest_addr, dest_port, "CONNECT", direct)

            client_writer.write(
                b"\x05\x00\x00\x01" + b"\x00" * 4 + b"\x00\x00"
            )
            await client_writer.drain()

            await asyncio.gather(
                relay(client_reader, remote_writer, route, "outbound"),
                relay(remote_reader, client_writer, route, "inbound"),
            )
        except Exception as e:
            if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                crash_logger.warning("SOCKS5 handler unexpected error", exc_info=True)
        finally:
            try:
                client_writer.close()
                await client_writer.wait_closed()
            except OSError:
                pass

    async def _handle_udp_associate(self, client_reader, client_writer, atyp):
        # 消费掉请求中剩余的地址和端口字段
        try:
            if atyp == 0x01:
                await asyncio.wait_for(client_reader.readexactly(4 + 2), timeout=LOCAL_HANDSHAKE_TIMEOUT)
            elif atyp == 0x03:
                length = (await asyncio.wait_for(client_reader.readexactly(1), timeout=LOCAL_HANDSHAKE_TIMEOUT))[0]
                await asyncio.wait_for(client_reader.readexactly(length + 2), timeout=LOCAL_HANDSHAKE_TIMEOUT)
            elif atyp == 0x04:
                await asyncio.wait_for(client_reader.readexactly(16 + 2), timeout=LOCAL_HANDSHAKE_TIMEOUT)
        except Exception:
            client_writer.close()
            return

        protocol = self._server_config.get("protocol", "socks5")
        udp_enabled = getattr(self, "_udp_enabled", True)
        if protocol != "socks5" or not udp_enabled:
            client_writer.write(b"\x05\x07\x00\x01" + b"\x00" * 4 + b"\x00\x00")
            await client_writer.drain()
            client_writer.close()
            return

        try:
            remote_reader, remote_writer = await connect_upstream_udp_associate(
                self._server_config, ssl_ctx=self._ssl_ctx
            )
            _log_access("UDP-ASSOCIATE", 0, "UDP", False)
        except Exception as e:
            _log_access("UDP-ASSOCIATE", 0, "UDP", False, str(e))
            if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                crash_logger.warning("UDP associate failed", exc_info=True)
            client_writer.write(b"\x05\x05\x00\x01" + b"\x00" * 4 + b"\x00\x00")
            await client_writer.drain()
            client_writer.close()
            return

        loop = asyncio.get_event_loop()
        transport, udp_relay = await loop.create_datagram_endpoint(
            lambda: _UdpRelayProtocol(remote_writer, loop),
            local_addr=("127.0.0.1", 0),
        )
        relay_addr = transport.get_extra_info("sockname")
        relay_port = relay_addr[1]

        # 回复客户端 UDP relay 地址
        reply = b"\x05\x00\x00\x01\x7f\x00\x00\x01" + struct.pack("!H", relay_port)
        client_writer.write(reply)
        await client_writer.drain()

        async def _tcp_to_udp():
            try:
                while True:
                    frame_data = await asyncio.wait_for(
                        read_udp_frame(remote_reader), timeout=UDP_IDLE_TIMEOUT
                    )
                    add_bytes(len(frame_data), "proxy", "inbound")
                    if udp_relay.client_addr:
                        transport.sendto(frame_data, udp_relay.client_addr)
            except (asyncio.TimeoutError, asyncio.IncompleteReadError,
                    ConnectionResetError, BrokenPipeError, OSError):
                pass

        async def _wait_control_close():
            try:
                await client_reader.read(1)
            except (ConnectionResetError, BrokenPipeError, OSError):
                pass

        tasks = [
            asyncio.ensure_future(_tcp_to_udp()),
            asyncio.ensure_future(_wait_control_close()),
        ]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in tasks:
                t.cancel()
        finally:
            transport.close()
            remote_writer.close()
            try:
                await remote_writer.wait_closed()
            except OSError:
                pass
            try:
                client_writer.close()
                await client_writer.wait_closed()
            except OSError:
                pass

    async def _handle_http(self, client_reader, client_writer):
        async with self._semaphore:
            await self._do_handle_http(client_reader, client_writer)

    async def _do_handle_http(self, client_reader, client_writer):
        try:
            raw_line = await asyncio.wait_for(client_reader.readline(), timeout=LOCAL_HANDSHAKE_TIMEOUT)
            if not raw_line:
                client_writer.close()
                return
            line = raw_line.decode("utf-8", errors="replace").strip()
            parts = line.split()
            if len(parts) < 3:
                client_writer.close()
                return

            method = parts[0].upper()

            if method == "CONNECT":
                target = parts[1]
                if ":" in target:
                    host, port_str = target.rsplit(":", 1)
                    port = int(port_str)
                    # Strip IPv6 brackets
                    if host.startswith("[") and host.endswith("]"):
                        host = host[1:-1]
                else:
                    host = target
                    port = 443

                while True:
                    header_line = await asyncio.wait_for(client_reader.readline(), timeout=LOCAL_HANDSHAKE_TIMEOUT)
                    if header_line in (b"\r\n", b"\n", b""):
                        break

                try:
                    ipaddress.ip_address(host)
                    is_domain = False
                except ValueError:
                    is_domain = True

                route = self._select_route(host, is_domain=is_domain)
                direct = route == "direct"
                try:
                    remote_reader, remote_writer, route = await self._connect_target(
                        host, port, is_domain=is_domain, route=route
                    )
                except Exception as e:
                    _log_access(host, port, "CONNECT", direct, str(e))
                    if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                        crash_logger.warning(f"HTTP CONNECT failed: {host}:{port}", exc_info=True)
                    return

                _log_access(host, port, "CONNECT", direct)
                logger.info(f'[HTTP] CONNECT tunnel established: {host}:{port}, route={route}')

                client_writer.write(
                    b"HTTP/1.1 200 Connection Established\r\n\r\n"
                )
                await client_writer.drain()
                logger.info(f'[HTTP] Sent 200 Connection Established to client: {host}:{port}')

                await asyncio.gather(
                    relay(client_reader, remote_writer, route, "outbound"),
                    relay(remote_reader, client_writer, route, "inbound"),
                )
            else:
                url = parts[1]
                if url.startswith("http://"):
                    url_body = url[7:]
                    slash_idx = url_body.find("/")
                    if slash_idx == -1:
                        host_part = url_body
                        path = "/"
                    else:
                        host_part = url_body[:slash_idx]
                        path = url_body[slash_idx:]

                    if ":" in host_part:
                        host, port_str = host_part.rsplit(":", 1)
                        port = int(port_str)
                    else:
                        host = host_part
                        port = 80

                    headers = []
                    while True:
                        header_line = await asyncio.wait_for(client_reader.readline(), timeout=LOCAL_HANDSHAKE_TIMEOUT)
                        if header_line in (b"\r\n", b"\n", b""):
                            break
                        headers.append(header_line)

                    try:
                        ipaddress.ip_address(host)
                        is_domain = False
                    except ValueError:
                        is_domain = True

                    route = self._select_route(host, is_domain=is_domain)
                    direct = route == "direct"
                    try:
                        remote_reader, remote_writer, route = await self._connect_target(
                            host, port, is_domain=is_domain, route=route
                        )
                    except Exception as e:
                        _log_access(host, port, method, direct, str(e))
                        if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                            crash_logger.warning(f"HTTP request failed: {host}:{port}", exc_info=True)
                        return

                    _log_access(host, port, method, direct)

                    if direct:
                        # 直连目标服务器：用路径格式
                        request_line = f"{method} {path} {parts[2]}\r\n".encode()
                    else:
                        # 下游是代理（tunnel 或 upstream proxy）：保留完整 URL
                        request_line = f"{method} {url} {parts[2]}\r\n".encode()
                    remote_writer.write(request_line)
                    for h in headers:
                        remote_writer.write(h)
                    remote_writer.write(b"\r\n")
                    await remote_writer.drain()

                    await asyncio.gather(
                        relay(remote_reader, client_writer, route, "inbound"),
                        relay(client_reader, remote_writer, route, "outbound"),
                    )
                else:
                    client_writer.close()
                    return
        except Exception as e:
            if not isinstance(e, (ConnectionResetError, BrokenPipeError, TimeoutError, OSError)):
                crash_logger.warning("HTTP handler unexpected error", exc_info=True)
        finally:
            try:
                client_writer.close()
                await client_writer.wait_closed()
            except OSError:
                pass
