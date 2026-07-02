import struct
import asyncio
import ipaddress
import ssl
import threading
import socket
import logging
from logger import crash_logger

logger = logging.getLogger('tunnel_client')

# Frame types
FRAME_CONNECT        = 0x01
FRAME_DATA           = 0x02
FRAME_CLOSE          = 0x03
FRAME_CONNECT_OK     = 0x04
FRAME_PING           = 0x10
FRAME_PONG           = 0x11
FRAME_AUTH           = 0x20
FRAME_AUTH_OK        = 0x21
FRAME_AUTH_FAIL      = 0x22
FRAME_ERROR          = 0x23
FRAME_CONNECT_FAILED = 0x81

# Address types
ATYP_IPV4   = 0x01
ATYP_DOMAIN = 0x03
ATYP_IPV6   = 0x04

CONNECT_TIMEOUT = 30  # seconds for target connection
IDLE_TIMEOUT = 60     # seconds without data → disconnect
MAX_FRAME_PAYLOAD = 65535
DATA_HEADER_LEN = 3   # type(1) + reqid(2)
MAX_DATA_CHUNK = MAX_FRAME_PAYLOAD - DATA_HEADER_LEN

# Forward reqid range: 0x8000-0xFFFE (server uses 1-0x7FFF for reverse)
FORWARD_REQID_START = 0x8000


class TunnelOccupiedError(Exception):
    """Server tunnel port is occupied by another client."""
    pass


class TunnelAuthFailedError(Exception):
    """Tunnel authentication failed. This is not recoverable by retrying."""
    pass


def encode_frame(frame_type, **kwargs):
    """Encode a frame with 2-byte length prefix."""
    payload = bytearray([frame_type])

    if frame_type == FRAME_AUTH:
        u = kwargs['username'].encode('utf-8')
        p = kwargs['password'].encode('utf-8')
        payload.extend(struct.pack('B', len(u)))
        payload.extend(u)
        payload.extend(struct.pack('B', len(p)))
        payload.extend(p)

    elif frame_type in (FRAME_CONNECT_OK, FRAME_CONNECT_FAILED, FRAME_CLOSE):
        payload.extend(struct.pack('!H', kwargs['reqid']))

    elif frame_type == FRAME_CONNECT:
        payload.extend(struct.pack('!H', kwargs['reqid']))
        atyp = kwargs['atyp']
        payload.append(atyp)
        if atyp == ATYP_DOMAIN:
            addr_bytes = kwargs['addr'].encode('utf-8')
            payload.append(len(addr_bytes))
            payload.extend(addr_bytes)
        elif atyp == ATYP_IPV4:
            parts = kwargs['addr'].split('.')
            payload.extend(bytes(int(p) for p in parts))
        payload.extend(struct.pack('!H', kwargs['port']))

    elif frame_type == FRAME_DATA:
        payload.extend(struct.pack('!H', kwargs['reqid']))
        data = kwargs['data']
        if len(data) > MAX_DATA_CHUNK:
            raise ValueError(f'DATA frame too large: {len(data)} > {MAX_DATA_CHUNK}')
        payload.extend(data)

    # PING, PONG, AUTH_OK, AUTH_FAIL: just the type byte

    elif frame_type == FRAME_ERROR:
        msg = kwargs.get('message', '').encode('utf-8')
        payload.append(len(msg))
        payload.extend(msg)

    header = struct.pack('!H', len(payload))
    return header + bytes(payload)


def decode_frame_from_buffer(buf):
    """Decode a single frame from a complete buffer (with length prefix)."""
    if len(buf) < 2:
        raise ValueError('Buffer too short')
    length = struct.unpack('!H', buf[:2])[0]
    if len(buf) < 2 + length:
        raise ValueError('Incomplete frame')
    return _decode_payload(buf[2:2+length])


async def read_frame(reader):
    """Read and decode one frame from an asyncio StreamReader."""
    header = await reader.readexactly(2)
    length = struct.unpack('!H', header)[0]
    payload = await reader.readexactly(length)
    return _decode_payload(payload)


def _decode_payload(payload):
    """Decode a frame payload (without length prefix)."""
    frame_type = payload[0]
    result = {'type': frame_type}
    offset = 1

    if frame_type == FRAME_CONNECT:
        reqid = struct.unpack('!H', payload[offset:offset+2])[0]
        offset += 2
        atyp = payload[offset]
        offset += 1

        if atyp == ATYP_DOMAIN:
            addr_len = payload[offset]
            offset += 1
            addr = payload[offset:offset+addr_len].decode('utf-8')
            offset += addr_len
        elif atyp == ATYP_IPV4:
            addr = '.'.join(str(b) for b in payload[offset:offset+4])
            offset += 4
        elif atyp == ATYP_IPV6:
            addr = payload[offset:offset+16].hex()
            offset += 16
        else:
            raise ValueError(f'Unsupported ATYP: {atyp}')

        port = struct.unpack('!H', payload[offset:offset+2])[0]
        result.update(reqid=reqid, atyp=atyp, addr=addr, port=port)

    elif frame_type in (FRAME_DATA, FRAME_CLOSE, FRAME_CONNECT_OK, FRAME_CONNECT_FAILED):
        reqid = struct.unpack('!H', payload[offset:offset+2])[0]
        result['reqid'] = reqid
        if frame_type == FRAME_DATA:
            result['data'] = payload[offset+2:]

    elif frame_type == FRAME_ERROR:
        msg_len = payload[offset]
        offset += 1
        result['message'] = payload[offset:offset+msg_len].decode('utf-8')

    # PING, PONG, AUTH_OK, AUTH_FAIL: no additional fields

    return result


class TunnelClient:
    """Bidirectional tunnel client. Connects to Server, receives CONNECT requests
    (reverse direction) and can initiate CONNECT through tunnel (forward direction)."""

    def __init__(self, config, on_status_change):
        """
        config: full config dict with 'server' and 'tunnel' sections.
        on_status_change: callback(status: str, detail: str) -> None.
            status values: 'connecting', 'connected', 'reconnecting',
                          'occupied', 'auth_failed', 'disconnected'
        """
        self._tunnel_cfg = config['tunnel']
        self._server_cfg = config['server']
        self._on_status_change = on_status_change
        self._running = False
        self._thread = None
        self._loop = None
        self._ssl_ctx = None
        self._tunnel_writers = []  # List of StreamWriter (up to 2 connections)
        self._tunnel_readers = []  # List of StreamReader
        self._rr_counter = 0  # Round-robin counter for forward connections
        self._connection_tasks = []  # asyncio tasks for each connection's read loop
        self._main_task = None
        self._connected = False
        self._connected_event = threading.Event()

        # Reverse direction: server-initiated connections
        self._reverse_reqid_counter = 0
        # Forward direction: client-initiated connections (reqid range 0x8000-0xFFFE)
        self._forward_reqid_counter = FORWARD_REQID_START
        self._forward_requests = {}  # reqid → {'connected': Event, 'connect_error': str|None, 'queue': Queue, 'writer': StreamWriter}
        self._relay_tasks = set()  # Keep references to relay tasks to prevent GC

    def is_connected(self):
        return self._connected

    @staticmethod
    def _set_tcp_options(writer):
        """Set TCP_NODELAY and SO_KEEPALIVE on the underlying socket."""
        sock = writer.get_extra_info('socket')
        if sock is None:
            return
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            if hasattr(socket, 'TCP_KEEPIDLE'):
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 60)
            if hasattr(socket, 'TCP_KEEPINTVL'):
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 10)
            if hasattr(socket, 'TCP_KEEPCNT'):
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3)
        except OSError:
            pass  # Unix domain sockets or closed sockets

    def measure_latency(self, timeout=5):
        """Measure tunnel round-trip latency via a lightweight CONNECT.
        Returns latency in ms on success, or None on failure.
        Called from ProxyCore's thread via run_coroutine_threadsafe."""
        if not self._connected or not self._loop or not self._loop.is_running():
            return None
        try:
            future = asyncio.run_coroutine_threadsafe(
                self._measure_latency_async(), self._loop
            )
            return future.result(timeout=timeout)
        except Exception:
            return None

    async def _measure_latency_async(self):
        """Send a CONNECT through the tunnel, measure RTT to CONNECT_OK, then close."""
        import time

        if not self._connected or not self._tunnel_writers:
            return None

        writer = self._tunnel_writers[0]  # Always use first connection for latency
        reqid = self._allocate_forward_reqid()
        fwd = {
            'connected': asyncio.Event(),
            'connect_error': None,
            'writer': writer,
        }
        self._forward_requests[reqid] = fwd

        start = time.monotonic()
        try:
            # Connect to the tunnel server itself (port 80) — lightweight, just needs CONNECT_OK
            writer.write(encode_frame(
                FRAME_CONNECT, reqid=reqid, atyp=ATYP_IPV4, addr='127.0.0.1', port=80
            ))
            await writer.drain()

            await asyncio.wait_for(fwd['connected'].wait(), timeout=5)

            if fwd['connect_error']:
                return None

            elapsed = time.monotonic() - start
            return int(elapsed * 1000)
        except Exception:
            return None
        finally:
            self._forward_requests.pop(reqid, None)
            # Send CLOSE to clean up the server-side connection
            try:
                if not writer.is_closing():
                    writer.write(encode_frame(FRAME_CLOSE, reqid=reqid))
                    await writer.drain()
            except Exception:
                pass

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run_thread, daemon=True, name='TunnelClient')
        self._thread.start()

    def stop(self):
        self._running = False
        self._connected = False
        self._connected_event.clear()
        if self._loop and self._loop.is_running():
            def _request_stop():
                for writer in self._tunnel_writers:
                    if not writer.is_closing():
                        writer.close()
                for task in self._connection_tasks:
                    if not task.done():
                        task.cancel()
                if self._main_task and not self._main_task.done():
                    self._main_task.cancel()
            self._loop.call_soon_threadsafe(_request_stop)
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None

    def forward_connect_sync(self, host, port, timeout=30):
        """Synchronous forward connect. Called from ProxyCore's thread.
        Returns a connected socket for relay on ProxyCore's event loop."""
        if not self._connected:
            raise Exception('Tunnel not connected')

        a, b = socket.socketpair()
        # Set both sockets to non-blocking mode
        a.setblocking(False)
        b.setblocking(False)
        try:
            fut = asyncio.run_coroutine_threadsafe(
                self._forward_connect_async(host, port, b), self._loop
            )
            fut.result(timeout=timeout)
            return a
        except Exception:
            a.close()
            b.close()
            raise

    def _run_thread(self):
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)

        if self._server_cfg.get('tls'):
            self._ssl_ctx = ssl.create_default_context()
            if self._server_cfg.get('allowInsecure'):
                self._ssl_ctx.check_hostname = False
                self._ssl_ctx.verify_mode = ssl.CERT_NONE

        try:
            self._main_task = self._loop.create_task(self._run_loop())
            self._loop.run_until_complete(self._main_task)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f'Tunnel loop error: {e}')
        finally:
            self._main_task = None
            self._loop.close()

    async def _run_loop(self):
        """Main reconnection loop with exponential backoff."""
        backoff = 1

        while self._running:
            try:
                self._on_status_change('connecting', '')
                await self._connect_and_serve()
                backoff = 1  # Reset on success
            except TunnelOccupiedError as e:
                self._on_status_change('occupied', str(e))
                logger.error(f'Tunnel occupied: {e}')
                break  # Don't retry
            except TunnelAuthFailedError as e:
                self._on_status_change('auth_failed', str(e))
                logger.error(f'Tunnel authentication failed: {e}')
                break  # Don't retry: bad credentials will not heal by reconnecting
            except Exception as e:
                logger.error(f'Tunnel connection failed: {e}')
                self._on_status_change('reconnecting', f'{backoff}s')
                try:
                    await asyncio.sleep(backoff)
                except asyncio.CancelledError:
                    break
                backoff = min(backoff * 2, 60)

        self._on_status_change('disconnected', '')

    async def _connect_and_serve(self):
        """Connect, authenticate, handle requests with dual connections."""
        addr = self._tunnel_cfg.get('server_address') or self._server_cfg['address']
        port = self._tunnel_cfg.get('server_port', 8004)
        credentials = {
            'username': self._server_cfg.get('username', ''),
            'password': self._server_cfg.get('password', '')
        }

        logger.info(f'Connecting to tunnel {addr}:{port}')

        # Establish connection 1 (required)
        conn1 = await self._establish_connection(addr, port, credentials)
        self._tunnel_writers.append(conn1['writer'])
        self._tunnel_readers.append(conn1['reader'])

        self._connected = True
        self._connected_event.set()
        self._on_status_change('connected', '')

        # Establish connection 2 (non-fatal if it fails)
        try:
            conn2 = await self._establish_connection(addr, port, credentials)
            self._tunnel_writers.append(conn2['writer'])
            self._tunnel_readers.append(conn2['reader'])
            logger.info('Dual-tunnel established (2 connections)')
        except TunnelOccupiedError as e:
            logger.info(f'Server does not support dual connections, running single: {e}')
        except Exception as e:
            logger.warning(f'Second tunnel connection failed: {e} (running single)')

        try:
            # Serve all connections concurrently
            tasks = []
            for i, (reader, writer) in enumerate(zip(self._tunnel_readers, self._tunnel_writers)):
                task = asyncio.ensure_future(
                    self._handle_requests(reader, writer, conn_index=i)
                )
                tasks.append(task)
                self._connection_tasks.append(task)

            # Wait for ALL connections to end
            await asyncio.gather(*tasks, return_exceptions=True)
        finally:
            self._connected = False
            self._connected_event.clear()
            # Fail ALL remaining forward requests (both connections dead)
            for fwd in self._forward_requests.values():
                fwd['connect_error'] = 'tunnel disconnected'
                fwd['connected'].set()
            self._forward_requests.clear()
            # Close all writers
            for writer in self._tunnel_writers:
                try:
                    writer.close()
                    await writer.wait_closed()
                except Exception:
                    pass
            self._tunnel_writers.clear()
            self._tunnel_readers.clear()
            self._connection_tasks.clear()

    async def _establish_connection(self, addr, port, credentials):
        """Connect and authenticate. Returns {'reader', 'writer'}."""
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(
                addr, port,
                ssl=self._ssl_ctx,
                server_hostname=addr if self._ssl_ctx else None
            ),
            timeout=10
        )

        self._set_tcp_options(writer)

        writer.write(encode_frame(
            FRAME_AUTH,
            username=credentials['username'],
            password=credentials['password']
        ))
        await writer.drain()

        response = await read_frame(reader)

        if response['type'] == FRAME_AUTH_OK:
            return {'reader': reader, 'writer': writer}
        elif response['type'] == FRAME_ERROR:
            writer.close()
            raise TunnelOccupiedError(response.get('message', 'Port occupied'))
        elif response['type'] == FRAME_AUTH_FAIL:
            writer.close()
            raise TunnelAuthFailedError('Authentication failed')
        else:
            writer.close()
            raise Exception(f'Unexpected response: {response["type"]:#x}')

    async def _handle_requests(self, reader, writer, conn_index=0):
        """Main frame processing loop. Handles PING/PONG, CONNECT, DATA, CLOSE."""
        active_writers = {}  # reqid → target_writer (reverse direction)
        target_write_tasks = set()

        async def write_to_target(reqid, target_writer, data):
            try:
                target_writer.write(data)
                await target_writer.drain()
            except (ConnectionResetError, BrokenPipeError, OSError) as e:
                logger.debug(f'Target write failed {reqid}: {e}')
                active_writers.pop(reqid, None)
                target_writer.close()

        try:
            while self._running:
                try:
                    frame = await asyncio.wait_for(read_frame(reader), timeout=IDLE_TIMEOUT)

                    if frame['type'] == FRAME_PING:
                        writer.write(encode_frame(FRAME_PONG))
                        await writer.drain()

                    elif frame['type'] == FRAME_CONNECT:
                        # Reverse direction: server asks client to connect
                        asyncio.ensure_future(
                            self._handle_connect(frame, writer, active_writers)
                        )

                    elif frame['type'] == FRAME_CONNECT_OK:
                        reqid = frame['reqid']
                        fwd = self._forward_requests.get(reqid)
                        if fwd:
                            fwd['connected'].set()
                        else:
                            logger.warning(f'Received CONNECT_OK for unknown reqid={reqid}')

                    elif frame['type'] == FRAME_CONNECT_FAILED:
                        reqid = frame['reqid']
                        fwd = self._forward_requests.get(reqid)
                        if fwd:
                            fwd['connect_error'] = 'connect failed'
                            fwd['connected'].set()
                        else:
                            logger.warning(f'Received CONNECT_FAILED for unknown reqid={reqid}')

                    elif frame['type'] == FRAME_DATA:
                        reqid = frame['reqid']
                        # Forward direction: data from tunnel → queue → sock
                        fwd = self._forward_requests.get(reqid)
                        if fwd and 'queue' in fwd:
                            await fwd['queue'].put(frame['data'])
                            continue
                        # Reverse direction: data from tunnel → target socket
                        tw = active_writers.get(reqid)
                        if tw and not tw.is_closing():
                            task = asyncio.create_task(write_to_target(reqid, tw, frame['data']))
                            target_write_tasks.add(task)
                            task.add_done_callback(target_write_tasks.discard)

                    elif frame['type'] == FRAME_CLOSE:
                        reqid = frame['reqid']
                        # Forward direction: EOF signal
                        fwd = self._forward_requests.get(reqid)
                        if fwd and 'queue' in fwd:
                            await fwd['queue'].put(None)
                            continue
                        # Reverse direction: close target socket
                        tw = active_writers.pop(reqid, None)
                        if tw:
                            tw.close()

                except asyncio.TimeoutError:
                    logger.warning(f'Tunnel heartbeat timeout (conn {conn_index})')
                    break
                except (ConnectionResetError, BrokenPipeError, OSError) as e:
                    logger.error(f'Tunnel connection lost (conn {conn_index}): {e}')
                    break
                except asyncio.IncompleteReadError:
                    logger.error(f'Tunnel connection closed by server (conn {conn_index})')
                    break
        finally:
            # Clean up active target connections (reverse)
            for task in target_write_tasks:
                task.cancel()
            for reqid, tw in active_writers.items():
                tw.close()
            active_writers.clear()

            # Fail forward requests that were sent on THIS connection
            for reqid, fwd in list(self._forward_requests.items()):
                if fwd.get('writer') is writer:
                    fwd['connect_error'] = 'tunnel connection lost'
                    fwd['connected'].set()
                    self._forward_requests.pop(reqid, None)

            # Remove this connection's writer from the list
            if writer in self._tunnel_writers:
                self._tunnel_writers.remove(writer)
            if reader in self._tunnel_readers:
                self._tunnel_readers.remove(reader)

            # Update connected state
            if not self._tunnel_writers:
                self._connected = False
                self._connected_event.clear()
                self._on_status_change('reconnecting', '')
            else:
                logger.info(f'Tunnel: 1 connection lost, {len(self._tunnel_writers)} remaining')

            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _handle_connect(self, frame, tunnel_writer, active_writers):
        """Handle a CONNECT request: connect to target directly, relay data."""
        reqid = frame['reqid']
        addr = frame['addr']
        port = frame['port']

        logger.info(f'CONNECT {reqid}: {addr}:{port}')

        try:
            target_reader, target_writer = await asyncio.wait_for(
                asyncio.open_connection(addr, port),
                timeout=CONNECT_TIMEOUT
            )
            self._set_tcp_options(target_writer)
        except Exception as e:
            logger.error(f'CONNECT failed {reqid}: {e}')
            tunnel_writer.write(encode_frame(FRAME_CONNECT_FAILED, reqid=reqid))
            await tunnel_writer.drain()
            return

        # Send CONNECT_OK confirmation
        tunnel_writer.write(encode_frame(FRAME_CONNECT_OK, reqid=reqid))
        await tunnel_writer.drain()

        active_writers[reqid] = target_writer

        # Read from target → send as DATA frames
        try:
            while True:
                data = await target_reader.read(MAX_DATA_CHUNK)
                if not data:
                    break
                tunnel_writer.write(encode_frame(FRAME_DATA, reqid=reqid, data=data))
                await tunnel_writer.drain()
                await asyncio.sleep(0)  # Yield to other reqids
        except (ConnectionResetError, BrokenPipeError, OSError) as e:
            logger.debug(f'Target read ended {reqid}: {e}')
        finally:
            active_writers.pop(reqid, None)
            target_writer.close()
            tunnel_writer.write(encode_frame(FRAME_CLOSE, reqid=reqid))
            await tunnel_writer.drain()

    def _allocate_forward_reqid(self):
        """Allocate reqid for forward direction (0x8000-0xFFFE)."""
        reqid = self._forward_reqid_counter
        self._forward_reqid_counter += 1
        if self._forward_reqid_counter > 0xFFFE:
            self._forward_reqid_counter = FORWARD_REQID_START
        return reqid

    async def _forward_connect_async(self, host, port, sock):
        """Async forward connect handler. Runs on tunnel's event loop."""
        # Round-robin select a writer
        if not self._tunnel_writers:
            raise Exception('No tunnel connections available')
        self._rr_counter += 1
        writer_idx = self._rr_counter % len(self._tunnel_writers)
        writer = self._tunnel_writers[writer_idx]

        logger.debug(f'Forward {host}:{port} -> connection {writer_idx + 1}/{len(self._tunnel_writers)}')

        reqid = self._allocate_forward_reqid()
        loop = asyncio.get_event_loop()

        queue = asyncio.Queue(maxsize=128)
        fwd = {
            'connected': asyncio.Event(),
            'connect_error': None,
            'queue': queue,
            'writer': writer,
        }
        self._forward_requests[reqid] = fwd

        try:
            atyp = ATYP_DOMAIN
            try:
                ipaddress.ip_address(host)
                atyp = ATYP_IPV4
            except ValueError:
                pass

            writer.write(encode_frame(
                FRAME_CONNECT, reqid=reqid, atyp=atyp, addr=host, port=port
            ))
            await writer.drain()

            await asyncio.wait_for(fwd['connected'].wait(), timeout=CONNECT_TIMEOUT)

            if fwd['connect_error']:
                raise Exception(fwd['connect_error'])

            # Start relay tasks
            # Task 1: sock → tunnel
            async def sock_to_tunnel():
                try:
                    while True:
                        data = await loop.sock_recv(sock, MAX_DATA_CHUNK)
                        if not data:
                            break
                        if writer.is_closing():
                            break
                        writer.write(encode_frame(
                            FRAME_DATA, reqid=reqid, data=data
                        ))
                        await writer.drain()
                        await asyncio.sleep(0)  # Yield to other reqids
                except (ConnectionResetError, BrokenPipeError, OSError):
                    pass
                except Exception:
                    pass
                finally:
                    try:
                        if not writer.is_closing():
                            writer.write(encode_frame(FRAME_CLOSE, reqid=reqid))
                            await writer.drain()
                    except Exception:
                        pass
                    self._forward_requests.pop(reqid, None)

            # Task 2: tunnel → sock
            async def tunnel_to_sock():
                try:
                    while True:
                        data = await queue.get()
                        if data is None:  # EOF from CLOSE frame
                            break
                        await loop.sock_sendall(sock, data)
                except Exception:
                    pass
                finally:
                    try:
                        sock.close()
                    except OSError:
                        pass

            task1 = asyncio.ensure_future(sock_to_tunnel())
            task2 = asyncio.ensure_future(tunnel_to_sock())
            # Keep references to prevent GC
            self._relay_tasks.add(task1)
            self._relay_tasks.add(task2)
            task1.add_done_callback(self._relay_tasks.discard)
            task2.add_done_callback(self._relay_tasks.discard)

        except Exception:
            self._forward_requests.pop(reqid, None)
            try:
                sock.close()
            except OSError:
                pass
            raise
