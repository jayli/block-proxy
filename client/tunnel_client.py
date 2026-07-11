import struct
import asyncio
import ipaddress
import ssl
import threading
import socket
import logging
import random
import types
import time
from logger import crash_logger

try:
    import aiohttp
except ImportError:  # pragma: no cover - dependency is declared in requirements
    aiohttp = types.SimpleNamespace(ClientSession=None, TCPConnector=None)

try:
    import websockets
except ImportError:  # pragma: no cover - dependency is declared in requirements
    websockets = types.SimpleNamespace(connect=None)

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

    elif frame_type in (FRAME_PING, FRAME_PONG):
        payload.extend(kwargs.get('payload', b''))

    # AUTH_OK, AUTH_FAIL: just the type byte

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

    elif frame_type == FRAME_AUTH:
        username_len = payload[offset]
        offset += 1
        result['username'] = payload[offset:offset+username_len].decode('utf-8')
        offset += username_len
        password_len = payload[offset]
        offset += 1
        result['password'] = payload[offset:offset+password_len].decode('utf-8')

    elif frame_type in (FRAME_PING, FRAME_PONG):
        result['payload'] = payload[offset:]

    # AUTH_OK, AUTH_FAIL: no additional fields

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
        self._user_on_status_change = on_status_change
        self._last_status = 'disconnected'
        self._running = False
        self._thread = None
        self._loop = None
        self._ssl_ctx = None
        self._ws = None
        self._active_ws = None
        self._candidate_ws = None
        self._draining_ws = None
        self._read_task = None
        self._heartbeat_task = None
        self._rotation_task = None
        self._ws_read_tasks = {}
        self._main_task = None
        self._connected = False
        self._connected_event = threading.Event()
        self._active_writers = {}

        # Reverse direction: server-initiated connections
        self._reverse_reqid_counter = 0
        # Forward direction: client-initiated connections (reqid range 0x8000-0xFFFE)
        self._forward_reqid_counter = FORWARD_REQID_START
        self._forward_requests = {}  # reqid → {'connected': Event, 'connect_error': str|None, 'queue': Queue, 'ws': WebSocket}
        self._relay_tasks = set()  # Keep references to relay tasks to prevent GC

    def is_connected(self):
        return self._connected

    def get_status(self):
        """Return current tunnel status: 'connecting', 'connected', 'reconnecting', etc."""
        return getattr(self, '_last_status', 'disconnected')

    def is_thread_alive(self):
        """Check if the tunnel background thread is alive."""
        return self._thread is not None and self._thread.is_alive()

    def _on_status_change(self, status, detail=''):
        """Internal wrapper: track status and invoke user callback."""
        self._last_status = status
        self._user_on_status_change(status, detail)

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

        if not self._connected or not self._active_ws:
            return None

        ws = self._active_ws
        reqid = self._allocate_forward_reqid()
        fwd = {
            'connected': asyncio.Event(),
            'connect_error': None,
            'ws': ws,
        }
        self._forward_requests[reqid] = fwd

        start = time.monotonic()
        try:
            # Connect to the tunnel server itself (port 80) — lightweight, just needs CONNECT_OK
            await self._ws_send(ws, encode_frame(
                FRAME_CONNECT, reqid=reqid, atyp=ATYP_IPV4, addr='127.0.0.1', port=80
            ))

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
                if self._ws_is_open(ws):
                    await self._ws_send(ws, encode_frame(FRAME_CLOSE, reqid=reqid))
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

        def _close_tunnel_state():
            if self._read_task:
                self._read_task.cancel()
            if self._heartbeat_task:
                self._heartbeat_task.cancel()
            if self._rotation_task:
                self._rotation_task.cancel()
            for task in list(self._ws_read_tasks.values()):
                task.cancel()
            for task in list(self._relay_tasks):
                task.cancel()
            self._relay_tasks.clear()
            for fwd in self._forward_requests.values():
                fwd['connect_error'] = 'tunnel stopped'
                fwd['connected'].set()
            self._forward_requests.clear()
            for entry in list(self._active_writers.values()):
                writer = entry.get('writer') if isinstance(entry, dict) else entry
                try:
                    writer.close()
                except Exception:
                    pass
            self._active_writers.clear()
            if self._ws:
                self._loop.create_task(self._close_ws(self._ws))

        # Close TLS sockets before stopping the loop; otherwise the server may
        # keep both tunnel slots occupied until heartbeat timeout.
        if self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(_close_tunnel_state)
        else:
            _close_tunnel_state()

        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(timeout=2)
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

        self._ssl_ctx = ssl.create_default_context()
        if self._server_cfg.get('allowInsecure'):
            self._ssl_ctx.check_hostname = False
            self._ssl_ctx.verify_mode = ssl.CERT_NONE

        try:
            self._main_task = self._loop.create_task(self._run_loop())
            self._loop.run_until_complete(self._main_task)
        except (asyncio.CancelledError, RuntimeError):
            # RuntimeError: "Event loop stopped before Future completed" — expected on shutdown
            pass
        except Exception as e:
            logger.error(f'Tunnel loop error: {e}')
        finally:
            self._main_task = None
            try:
                self._loop.close()
            except Exception:
                pass

    async def _run_loop(self):
        """Main reconnection loop with exponential backoff."""
        backoff = 1
        terminal_status = None

        while self._running:
            try:
                self._on_status_change('connecting', '')
                await self._connect_and_serve()
                backoff = 1  # Reset on success
            except TunnelOccupiedError as e:
                terminal_status = 'occupied'
                self._on_status_change('occupied', str(e))
                logger.error(f'Tunnel occupied: {e}')
                break  # Don't retry
            except TunnelAuthFailedError as e:
                terminal_status = 'auth_failed'
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

        if terminal_status is None:
            self._on_status_change('disconnected', '')

    async def _connect_and_serve(self):
        """Connect, authenticate, and handle requests on one active WebSocket."""
        addr = self._tunnel_cfg.get('server_address') or self._server_cfg['address']
        port = self._tunnel_cfg.get('server_port', 8003)
        credentials = {
            'username': self._server_cfg.get('username', ''),
            'password': self._server_cfg.get('password', '')
        }

        logger.info(f'Connecting to tunnel {addr}:{port}')

        ws = await self._establish_connection(addr, port, credentials)
        self._ws = ws
        self._active_ws = ws

        self._connected = True
        self._connected_event.set()
        self._on_status_change('connected', '')

        try:
            self._read_task = asyncio.ensure_future(self._handle_requests(ws))
            self._ws_read_tasks[ws] = self._read_task
            if self._tunnel_cfg.get('client_heartbeat', False):
                self._heartbeat_task = asyncio.ensure_future(self._heartbeat_loop(ws))
            if self._tunnel_cfg.get('rotation_enabled', False):
                self._rotation_task = asyncio.ensure_future(self._rotation_loop())
            await self._read_task
        finally:
            self._connected = False
            self._connected_event.clear()
            for fwd in self._forward_requests.values():
                fwd['connect_error'] = 'tunnel disconnected'
                fwd['connected'].set()
            self._forward_requests.clear()
            for entry in list(self._active_writers.values()):
                writer = entry.get('writer') if isinstance(entry, dict) else entry
                try:
                    writer.close()
                except Exception:
                    pass
            self._active_writers.clear()
            for task in (self._heartbeat_task, self._rotation_task):
                if task:
                    task.cancel()
            self._heartbeat_task = None
            self._rotation_task = None
            self._read_task = None
            self._ws_read_tasks.pop(ws, None)
            for task in list(self._ws_read_tasks.values()):
                task.cancel()
            self._ws_read_tasks.clear()
            for extra_ws in (self._candidate_ws, self._draining_ws):
                if extra_ws:
                    await self._close_ws(extra_ws)
            self._candidate_ws = None
            self._draining_ws = None
            await self._close_ws(ws)
            if self._ws is ws:
                self._ws = None
            if self._active_ws is ws:
                self._active_ws = None

    async def _establish_connection(self, addr, port, credentials):
        """Connect and authenticate. Returns an authenticated WebSocket."""
        if websockets.connect is None:
            raise RuntimeError('websockets dependency is not installed')

        ws_path = self._tunnel_cfg.get('ws_path', '/ws')
        if not ws_path.startswith('/'):
            ws_path = '/' + ws_path

        if self._tunnel_cfg.get('http_disguise', False):
            await self._perform_http_disguise(addr, port)

        ws_url = f'wss://{addr}:{port}{ws_path}'
        headers = self._tunnel_cfg.get('headers') or None
        connect_kwargs = {
            'ssl': self._ssl_ctx,
            'ping_interval': None,
            'ping_timeout': None,
        }
        if headers:
            connect_kwargs['additional_headers'] = headers

        ws = await asyncio.wait_for(
            websockets.connect(ws_url, **connect_kwargs),
            timeout=10
        )

        await self._ws_send(ws, encode_frame(
            FRAME_AUTH,
            username=credentials['username'],
            password=credentials['password']
        ))

        response_buf = await asyncio.wait_for(ws.recv(), timeout=10)
        response = decode_frame_from_buffer(bytes(response_buf))

        if response['type'] == FRAME_AUTH_OK:
            return ws
        elif response['type'] == FRAME_ERROR:
            await self._close_ws(ws)
            raise TunnelOccupiedError(response.get('message', 'Port occupied'))
        elif response['type'] == FRAME_AUTH_FAIL:
            await self._close_ws(ws)
            raise TunnelAuthFailedError('Authentication failed')
        else:
            await self._close_ws(ws)
            raise Exception(f'Unexpected response: {response["type"]:#x}')

    async def _perform_http_disguise(self, addr, port):
        if aiohttp.ClientSession is None:
            raise RuntimeError('aiohttp dependency is not installed')

        connector = aiohttp.TCPConnector(ssl=self._ssl_ctx) if aiohttp.TCPConnector else None
        base = f'https://{addr}:{port}'
        async with aiohttp.ClientSession(connector=connector) as session:
            async with session.get(f'{base}/'):
                pass
            await asyncio.sleep(random.uniform(0.5, 2.0))
            async with session.get(f'{base}/favicon.ico'):
                pass
            await asyncio.sleep(random.uniform(0.5, 2.0))

    def _ws_is_open(self, ws):
        if ws is None:
            return False
        if getattr(ws, 'closed', False):
            return False
        state = getattr(ws, 'state', None)
        if state is not None and str(state).upper().endswith('CLOSED'):
            return False
        return True

    def _get_ws_drain_state(self, ws):
        """返回指定 WS 连接上的活跃请求数和最近活动时间。"""
        if not self._ws_is_open(ws):
            return {'active_count': 0, 'last_activity': 0}
        active_count = 0
        last_activity = 0
        for entry in self._active_writers.values():
            if entry.get('ws') is ws:
                active_count += 1
                last_activity = max(last_activity, entry.get('last_activity', time.monotonic()))
        for fwd in self._forward_requests.values():
            if fwd.get('ws') is ws:
                active_count += 1
                last_activity = max(last_activity, fwd.get('last_activity', time.monotonic()))
        return {'active_count': active_count, 'last_activity': last_activity}

    def _has_active_requests_on_ws(self, ws):
        return self._get_ws_drain_state(ws)['active_count'] > 0

    def _old_ws_is_still_draining(self, ws, idle_timeout):
        state = self._get_ws_drain_state(ws)
        if state['active_count'] <= 0:
            return False
        if idle_timeout is None or idle_timeout <= 0:
            return True
        return (time.monotonic() - state['last_activity']) < idle_timeout

    async def _ws_send(self, ws, data):
        if not self._ws_is_open(ws):
            return False
        await ws.send(data)
        return True

    async def _close_ws(self, ws):
        if not ws:
            return
        try:
            await ws.close()
        except Exception:
            pass

    async def _heartbeat_loop(self, ws):
        while self._running and self._ws_is_open(ws):
            interval = random.uniform(
                self._tunnel_cfg.get('heartbeat_min', 15),
                self._tunnel_cfg.get('heartbeat_max', 40),
            )
            await asyncio.sleep(interval)
            payload = random.randbytes(random.randint(8, 40)) if hasattr(random, 'randbytes') else bytes(
                random.getrandbits(8) for _ in range(random.randint(8, 40))
            )
            await self._ws_send(ws, encode_frame(FRAME_PING, payload=payload))

    async def _rotation_loop(self):
        while self._running and self._tunnel_cfg.get('rotation_enabled', False):
            interval = random.uniform(
                self._tunnel_cfg.get('rotation_min', 600),
                self._tunnel_cfg.get('rotation_max', 1800),
            )
            try:
                await asyncio.sleep(interval)
                await self._rotation_cycle()
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f'Tunnel rotation failed: {e}')

    async def _rotation_cycle(self):
        old_ws = self._active_ws
        if not old_ws or not self._ws_is_open(old_ws):
            return False

        addr = self._tunnel_cfg.get('server_address') or self._server_cfg['address']
        port = self._tunnel_cfg.get('server_port', 8003)
        credentials = {
            'username': self._server_cfg.get('username', ''),
            'password': self._server_cfg.get('password', '')
        }

        candidate = None
        try:
            candidate = await self._establish_connection(addr, port, credentials)
            self._candidate_ws = candidate
        except Exception as e:
            logger.warning(f'Tunnel rotation candidate failed: {e}')
            if candidate:
                await self._close_ws(candidate)
            self._candidate_ws = None
            return False

        read_task = asyncio.ensure_future(self._handle_requests(candidate))
        self._ws_read_tasks[candidate] = read_task
        self._active_ws = candidate
        self._ws = candidate
        self._candidate_ws = None
        self._draining_ws = old_ws

        drain_timeout = self._tunnel_cfg.get('rotation_drain_timeout', 10)
        try:
            # 第一步：等待最小 drain_timeout
            await asyncio.sleep(drain_timeout)
            # 第二步：轮询等待旧连接上所有活跃请求完成
            drain_idle_timeout = self._tunnel_cfg.get('rotation_drain_idle_timeout', 20)
            while True:
                if not self._old_ws_is_still_draining(old_ws, drain_idle_timeout):
                    break
                await asyncio.sleep(min(1, max(0.01, drain_idle_timeout / 2 if drain_idle_timeout else 1)))
        except asyncio.CancelledError:
            raise
        finally:
            if self._draining_ws is old_ws:
                await self._close_ws(old_ws)
                self._draining_ws = None

        return True

    async def _handle_requests(self, ws):
        """Main WebSocket frame processing loop. Handles PING/PONG, CONNECT, DATA, CLOSE."""
        target_write_tasks = set()

        async def write_to_target(reqid, target_writer, data):
            try:
                target_writer.write(data)
                await target_writer.drain()
            except (ConnectionResetError, BrokenPipeError, OSError) as e:
                logger.debug(f'Target write failed {reqid}: {e}')
                self._active_writers.pop(reqid, None)
                target_writer.close()

        try:
            while self._running:
                try:
                    msg = await asyncio.wait_for(
                        ws.recv(),
                        timeout=self._tunnel_cfg.get('heartbeat_timeout', IDLE_TIMEOUT)
                    )
                    frame = decode_frame_from_buffer(bytes(msg))

                    if frame['type'] == FRAME_PING:
                        await self._ws_send(ws, encode_frame(
                            FRAME_PONG, payload=frame.get('payload', b'')
                        ))

                    elif frame['type'] == FRAME_CONNECT:
                        # Reverse direction: server asks client to connect
                        asyncio.ensure_future(
                            self._handle_connect(frame, ws)
                        )

                    elif frame['type'] == FRAME_CONNECT_OK:
                        reqid = frame['reqid']
                        fwd = self._forward_requests.get(reqid)
                        if fwd:
                            fwd['last_activity'] = time.monotonic()
                            fwd['connected'].set()
                        else:
                            logger.warning(f'Received CONNECT_OK for unknown reqid={reqid}')

                    elif frame['type'] == FRAME_CONNECT_FAILED:
                        reqid = frame['reqid']
                        fwd = self._forward_requests.get(reqid)
                        if fwd:
                            fwd['last_activity'] = time.monotonic()
                            fwd['connect_error'] = 'connect failed'
                            fwd['connected'].set()
                        else:
                            logger.warning(f'Received CONNECT_FAILED for unknown reqid={reqid}')

                    elif frame['type'] == FRAME_DATA:
                        reqid = frame['reqid']
                        # Forward direction: data from tunnel → queue → sock
                        fwd = self._forward_requests.get(reqid)
                        if fwd and 'queue' in fwd:
                            fwd['last_activity'] = time.monotonic()
                            await fwd['queue'].put(frame['data'])
                            continue
                        # Reverse direction: data from tunnel → target socket
                        entry = self._active_writers.get(reqid)
                        tw = entry.get('writer') if entry else None
                        if tw and not tw.is_closing():
                            entry['last_activity'] = time.monotonic()
                            task = asyncio.create_task(write_to_target(reqid, tw, frame['data']))
                            target_write_tasks.add(task)
                            task.add_done_callback(target_write_tasks.discard)

                    elif frame['type'] == FRAME_CLOSE:
                        reqid = frame['reqid']
                        # Forward direction: EOF signal
                        fwd = self._forward_requests.get(reqid)
                        if fwd and 'queue' in fwd:
                            fwd['last_activity'] = time.monotonic()
                            await fwd['queue'].put(None)
                            continue
                        # Reverse direction: close target socket
                        entry = self._active_writers.pop(reqid, None)
                        tw = entry.get('writer') if entry else None
                        if tw:
                            tw.close()

                except asyncio.TimeoutError:
                    logger.warning('Tunnel heartbeat timeout')
                    break
                except (ConnectionResetError, BrokenPipeError, OSError) as e:
                    logger.error(f'Tunnel connection lost: {e}')
                    break
                except asyncio.IncompleteReadError:
                    logger.error('Tunnel connection closed by server')
                    break
        finally:
            # Clean up active target connections (reverse)
            for task in target_write_tasks:
                task.cancel()
            for reqid, entry in list(self._active_writers.items()):
                if entry.get('ws') is ws:
                    entry['writer'].close()
                    self._active_writers.pop(reqid, None)

            # Fail forward requests that were sent on THIS connection
            for reqid, fwd in list(self._forward_requests.items()):
                if fwd.get('ws') is ws:
                    fwd['connect_error'] = 'tunnel connection lost'
                    fwd['connected'].set()
                    self._forward_requests.pop(reqid, None)

            self._ws_read_tasks.pop(ws, None)

            if self._active_ws is ws:
                self._connected = False
                self._connected_event.clear()
                self._on_status_change('reconnecting', '')
                self._active_ws = None
                if self._ws is ws:
                    self._ws = None
            elif self._draining_ws is ws:
                self._draining_ws = None

            await self._close_ws(ws)

    async def _handle_connect(self, frame, ws):
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
            await self._ws_send(ws, encode_frame(FRAME_CONNECT_FAILED, reqid=reqid))
            return

        # Send CONNECT_OK confirmation
        await self._ws_send(ws, encode_frame(FRAME_CONNECT_OK, reqid=reqid))

        self._active_writers[reqid] = {'writer': target_writer, 'ws': ws, 'last_activity': time.monotonic()}

        # Read from target → send as DATA frames
        try:
            while True:
                data = await target_reader.read(MAX_DATA_CHUNK)
                if not data:
                    break
                if not self._ws_is_open(ws):
                    break
                entry = self._active_writers.get(reqid)
                if entry:
                    entry['last_activity'] = time.monotonic()
                await self._ws_send(ws, encode_frame(FRAME_DATA, reqid=reqid, data=data))
                await asyncio.sleep(0)  # Yield to other reqids
        except (ConnectionResetError, BrokenPipeError, OSError) as e:
            logger.debug(f'Target read ended {reqid}: {e}')
        finally:
            self._active_writers.pop(reqid, None)
            target_writer.close()
            await self._ws_send(ws, encode_frame(FRAME_CLOSE, reqid=reqid))

    def _allocate_forward_reqid(self):
        """Allocate reqid for forward direction (0x8000-0xFFFE)."""
        reqid = self._forward_reqid_counter
        self._forward_reqid_counter += 1
        if self._forward_reqid_counter > 0xFFFE:
            self._forward_reqid_counter = FORWARD_REQID_START
        return reqid

    async def _forward_connect_async(self, host, port, sock):
        """Async forward connect handler. Runs on tunnel's event loop."""
        ws = self._active_ws
        if not ws or not self._ws_is_open(ws):
            raise Exception('No tunnel connections available')

        reqid = self._allocate_forward_reqid()
        loop = asyncio.get_event_loop()

        queue = asyncio.Queue(maxsize=128)
        fwd = {
            'connected': asyncio.Event(),
            'connect_error': None,
            'queue': queue,
            'ws': ws,
            'last_activity': time.monotonic(),
        }
        self._forward_requests[reqid] = fwd

        try:
            atyp = ATYP_DOMAIN
            try:
                ipaddress.ip_address(host)
                atyp = ATYP_IPV4
            except ValueError:
                pass

            await self._ws_send(ws, encode_frame(
                FRAME_CONNECT, reqid=reqid, atyp=atyp, addr=host, port=port
            ))

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
                        if not self._ws_is_open(ws):
                            break
                        fwd['last_activity'] = time.monotonic()
                        await self._ws_send(ws, encode_frame(
                            FRAME_DATA, reqid=reqid, data=data
                        ))
                        await asyncio.sleep(0)  # Yield to other reqids
                except asyncio.CancelledError:
                    logger.debug(f'sock_to_tunnel cancelled for reqid {reqid}')
                except (ConnectionResetError, BrokenPipeError, OSError):
                    pass
                except Exception:
                    pass
                finally:
                    try:
                        if self._ws_is_open(ws):
                            await self._ws_send(ws, encode_frame(FRAME_CLOSE, reqid=reqid))
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
                except asyncio.CancelledError:
                    logger.debug(f'tunnel_to_sock cancelled for reqid {reqid}')
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
