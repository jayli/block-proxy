import asyncio
import functools
import ipaddress
import logging
import ssl
import struct
import threading

logger = logging.getLogger("proxy_core")

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


async def relay(reader, writer):
    try:
        while True:
            data = await asyncio.wait_for(reader.read(65536), timeout=RELAY_IDLE_TIMEOUT)
            if not data:
                break
            writer.write(data)
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

    await asyncio.wait_for(_handshake(), timeout=HANDSHAKE_TIMEOUT)

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

    await asyncio.wait_for(_handshake(), timeout=HANDSHAKE_TIMEOUT)

    return reader, writer


async def connect_direct(dest_addr, dest_port):
    return await asyncio.open_connection(dest_addr, dest_port)


MAX_CONCURRENT = 256


class ProxyCore:
    def __init__(self):
        self._loop = None
        self._thread = None
        self._socks_server = None
        self._http_server = None
        self._running = False
        self._server_config = None
        self._proxy_private = False
        self._socks_port = 1080
        self._http_port = 1087
        self._ssl_ctx = None
        self._semaphore = None

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

    def start(self, user_config):
        if self._running:
            self.stop()

        self._server_config = user_config["server"]
        local = user_config["local"]
        self._socks_port = local["socks_port"]
        self._http_port = local["http_port"]
        self._proxy_private = local.get("proxy_private", False)
        self._build_ssl_context()

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
            self._thread.join(timeout=2)
        if self._loop:
            self._loop.close()
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
        start = time.monotonic()
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
            username = self._server_config.get("username", "")
            password = self._server_config.get("password", "")
            if username and password:
                writer.write(b"\x05\x01\x02")
            else:
                writer.write(b"\x05\x01\x00")
            await writer.drain()
            resp = await asyncio.wait_for(reader.readexactly(2), timeout=5)
            if resp[0] != 0x05:
                writer.close()
                return None
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
                    writer.close()
                    return None
            elapsed = time.monotonic() - start
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass
            return int(elapsed * 1000)
        except Exception:
            return None

    def measure_latency(self):
        if not self._running or not self._loop or not self._loop.is_running():
            return None
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

    def _should_direct(self, host):
        if self._proxy_private:
            return False
        return is_private_ip(host)

    async def _connect_target(self, dest_addr, dest_port):
        if self._should_direct(dest_addr):
            return await connect_direct(dest_addr, dest_port)
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
            header = await client_reader.readexactly(2)
            ver, nmethods = header
            if ver != 0x05:
                client_writer.close()
                return
            await client_reader.readexactly(nmethods)

            client_writer.write(b"\x05\x00")
            await client_writer.drain()

            req = await client_reader.readexactly(4)
            ver, cmd, _, atyp = req

            if cmd != 0x01:
                client_writer.write(
                    b"\x05\x07\x00\x01" + b"\x00" * 4 + b"\x00\x00"
                )
                await client_writer.drain()
                client_writer.close()
                return

            if atyp == 0x01:
                raw = await client_reader.readexactly(4)
                dest_addr = str(ipaddress.IPv4Address(raw))
            elif atyp == 0x03:
                length = (await client_reader.readexactly(1))[0]
                dest_addr = (await client_reader.readexactly(length)).decode("utf-8")
            elif atyp == 0x04:
                raw = await client_reader.readexactly(16)
                dest_addr = str(ipaddress.IPv6Address(raw))
            else:
                client_writer.write(
                    b"\x05\x08\x00\x01" + b"\x00" * 4 + b"\x00\x00"
                )
                await client_writer.drain()
                client_writer.close()
                return

            port_data = await client_reader.readexactly(2)
            dest_port = struct.unpack("!H", port_data)[0]

            remote_reader, remote_writer = await self._connect_target(
                dest_addr, dest_port
            )

            client_writer.write(
                b"\x05\x00\x00\x01" + b"\x00" * 4 + b"\x00\x00"
            )
            await client_writer.drain()

            await asyncio.gather(
                relay(client_reader, remote_writer),
                relay(remote_reader, client_writer),
            )
        except Exception:
            pass
        finally:
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
            raw_line = await client_reader.readline()
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
                else:
                    host = target
                    port = 443

                while True:
                    header_line = await client_reader.readline()
                    if header_line in (b"\r\n", b"\n", b""):
                        break

                remote_reader, remote_writer = await self._connect_target(
                    host, port
                )

                client_writer.write(
                    b"HTTP/1.1 200 Connection Established\r\n\r\n"
                )
                await client_writer.drain()

                await asyncio.gather(
                    relay(client_reader, remote_writer),
                    relay(remote_reader, client_writer),
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
                        header_line = await client_reader.readline()
                        if header_line in (b"\r\n", b"\n", b""):
                            break
                        headers.append(header_line)

                    remote_reader, remote_writer = await self._connect_target(
                        host, port
                    )

                    request_line = f"{method} {path} {parts[2]}\r\n".encode()
                    remote_writer.write(request_line)
                    for h in headers:
                        remote_writer.write(h)
                    remote_writer.write(b"\r\n")
                    await remote_writer.drain()

                    await asyncio.gather(
                        relay(remote_reader, client_writer),
                        relay(client_reader, remote_writer),
                    )
                else:
                    client_writer.close()
                    return
        except Exception:
            pass
        finally:
            try:
                client_writer.close()
                await client_writer.wait_closed()
            except OSError:
                pass
