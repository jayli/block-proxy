package com.blockproxy.android.tunnel

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Abstraction over a target (downstream) TCP socket for reverse CONNECT.
 *
 * Production code uses [RealTargetSocket]; tests inject fake implementations.
 */
interface TargetSocket {
    suspend fun connect(host: String, port: Int, timeoutMs: Long)
    suspend fun read(buffer: ByteArray): Int
    suspend fun write(bytes: ByteArray)
    fun close()
}

/**
 * Factory for creating target (downstream) TCP sockets.
 *
 * Production code uses [RealTargetSocketFactory] which creates plain TCP sockets.
 * Tests inject a fake factory to avoid real networking.
 */
interface TargetSocketFactory {
    fun create(): TargetSocket
}

/**
 * Production [TargetSocketFactory] that creates plain TCP [RealTargetSocket] instances.
 *
 * @param protect Optional callback to protect sockets from VPN routing (e.g., `VpnService.protect`).
 *                Should be called before connecting the socket to prevent routing loops.
 */
class RealTargetSocketFactory(
    private val protect: ((Socket) -> Boolean)? = null,
) : TargetSocketFactory {
    override fun create(): TargetSocket = RealTargetSocket(protect)
}

/**
 * Plain TCP socket for target (downstream) connections.
 *
 * Unlike the tunnel WebSocket, this does not use TLS — it connects directly
 * to the target server.
 *
 * @param protect Optional callback to protect sockets from VPN routing (e.g., `VpnService.protect`).
 *                Called before connecting to prevent routing loops.
 */
class RealTargetSocket(
    private val protect: ((Socket) -> Boolean)? = null,
) : TargetSocket {
    private var socket: Socket? = null
    private var inputStream: InputStream? = null
    private var outputStream: OutputStream? = null

    override suspend fun connect(host: String, port: Int, timeoutMs: Long) {
        val sock = Socket()
        socket = sock  // Set before connect so close() can interrupt it
        sock.tcpNoDelay = true
        sock.keepAlive = true
        // Protect socket from VPN routing to prevent routing loops
        // Primary loop prevention is addDisallowedApplication(); protect() is defense-in-depth.
        val protected = protect?.invoke(sock) ?: true
        if (!protected) {
            android.util.Log.w("RealTargetSocket", "VpnService.protect() returned false for $host:$port; continuing with kernel-level exclusion only")
        }
        withContext(Dispatchers.IO) {
            sock.connect(InetSocketAddress(host, port), timeoutMs.toInt())
        }
        inputStream = sock.getInputStream()
        outputStream = sock.getOutputStream()
    }

    override suspend fun read(buffer: ByteArray): Int {
        val stream = inputStream ?: throw IOException("Not connected")
        return withContext(Dispatchers.IO) {
            stream.read(buffer)
        }
    }

    override suspend fun write(bytes: ByteArray) {
        val stream = outputStream ?: throw IOException("Not connected")
        withContext(Dispatchers.IO) {
            stream.write(bytes)
            stream.flush()
        }
    }

    override fun close() {
        try { socket?.close() } catch (_: Exception) {}
        socket = null
        inputStream = null
        outputStream = null
    }
}

/**
 * Manages reverse-connect sessions for tunnel proxy connections.
 *
 * When the server sends a CONNECT frame, this handler:
 * 1. Creates a [RequestSession] with a target TCP socket
 * 2. Connects to the target (with timeout)
 * 3. Sends CONNECT_OK back on the same tunnel connection
 * 4. Relays data bidirectionally between target and tunnel
 *
 * Each session is bound to the specific [FrameSender] that received the
 * CONNECT frame. When a tunnel disconnects, [closeSessionsFor] cleans up only
 * the sessions owned by that sender.
 *
 * @param scope Coroutine scope for launching relay and write tasks.
 * @param socketFactory Factory for creating target TCP sockets.
 * @param connectTimeoutMs Timeout for target TCP connections (default 30s).
 */
class ReverseConnectHandler(
    private val scope: CoroutineScope,
    private val socketFactory: TargetSocketFactory,
    private val connectTimeoutMs: Long = 30_000L,
    private val paddingInjector: PaddingInjector? = null,
) {
    private val sessions = ConcurrentHashMap<Int, RequestSession>()

    /**
     * Handles an inbound frame from a tunnel connection.
     *
     * Dispatches CONNECT, DATA, and CLOSE frames to the appropriate session.
     * Other frame types are silently ignored.
     */
    suspend fun handleFrame(sender: FrameSender, frame: Frame) {
        when (frame) {
            is Frame.Connect -> handleConnect(sender, frame)
            is Frame.Data -> handleData(frame)
            is Frame.Close -> handleClose(frame)
            else -> { /* ignore other frame types */ }
        }
    }

    /**
     * Closes all sessions owned by the given tunnel connection.
     *
     * Called when a tunnel connection disconnects. Only sessions bound to
     * this specific connection are closed; sessions on other connections
     * are unaffected. Safe to call multiple times (idempotent).
     */
    fun closeSessionsFor(sender: FrameSender) {
        // Snapshot matching sessions, then remove-and-close each.
        // Using remove(key, value) ensures we don't remove a new session
        // that reused the same reqid after the old one was closed.
        val toClose = sessions.entries
            .filter { it.value.sender === sender }
            .map { it.key to it.value }

        for ((reqid, session) in toClose) {
            sessions.remove(reqid, session)
            session.close()
        }
    }

    /**
     * Returns the drain state for the given [sender]: number of active requests
     * and the most recent activity timestamp.
     */
    fun getDrainState(sender: FrameSender): DrainState {
        var activeCount = 0
        var lastActivityAt = 0L
        for (session in sessions.values) {
            if (session.sender === sender) {
                activeCount++
                lastActivityAt = maxOf(lastActivityAt, session.lastActivityAt)
            }
        }
        return DrainState(activeCount, lastActivityAt)
    }

    // ── Internal ──────────────────────────────────────────────────────

    private suspend fun handleConnect(sender: FrameSender, frame: Frame.Connect) {
        val reqid = frame.reqid
        val targetSocket = socketFactory.create()

        val session = RequestSession(
            reqid = reqid,
            sender = sender,
            targetSocket = targetSocket,
            scope = scope,
            paddingInjector = paddingInjector,
            onEnd = { s -> sessions.remove(s.reqid, s) },
        )
        // Use putIfAbsent to avoid orphaning an existing session with the same reqid
        val existing = sessions.putIfAbsent(reqid, session)
        if (existing != null) {
            try { targetSocket.close() } catch (_: Exception) {}
            try { sender.sendFrame(FrameCodec.encode(Frame.ConnectFailed(reqid))) } catch (_: Exception) {}
            return
        }

        val host = when (val addr = frame.address) {
            is FrameAddress.IPv4 -> addr.address
            is FrameAddress.Domain -> addr.domain
            is FrameAddress.IPv6 -> {
                try { sender.sendFrame(FrameCodec.encode(Frame.ConnectFailed(reqid))) } catch (_: Exception) {}
                sessions.remove(reqid, session)
                try { targetSocket.close() } catch (_: Exception) {}
                return
            }
        }
        try {
            withTimeout(connectTimeoutMs) {
                targetSocket.connect(host, frame.port, connectTimeoutMs)
            }
            // Check if session was closed during connect (e.g., by closeSessionsFor)
            if (session.closed.get()) {
                sessions.remove(reqid, session)
                try { targetSocket.close() } catch (_: Exception) {}
                return
            }
            sender.sendFrame(FrameCodec.encode(Frame.ConnectOk(reqid)))
            session.startRelay()
        } catch (e: TimeoutCancellationException) {
            // Connect timed out - send CONNECT_FAILED
            sessions.remove(reqid, session)
            try { targetSocket.close() } catch (_: Exception) {}
            try { sender.sendFrame(FrameCodec.encode(Frame.ConnectFailed(reqid))) } catch (_: Exception) {}
        } catch (e: CancellationException) {
            // Scope cancelled — propagate
            sessions.remove(reqid, session)
            try { targetSocket.close() } catch (_: Exception) {}
            throw e
        } catch (_: Exception) {
            // Connect failed
            sessions.remove(reqid, session)
            try { targetSocket.close() } catch (_: Exception) {}
            try { sender.sendFrame(FrameCodec.encode(Frame.ConnectFailed(reqid))) } catch (_: Exception) {}
        }
    }

    private suspend fun handleData(frame: Frame.Data) {
        val session = sessions[frame.reqid] ?: return // Late DATA after close — discard
        session.enqueueWrite(frame.payload)
    }

    private suspend fun handleClose(frame: Frame.Close) {
        val session = sessions.remove(frame.reqid) ?: return // Already closed
        session.close()
    }
}

/**
 * A single reverse-connect session binding a target TCP socket to a tunnel connection.
 *
 * Lifecycle:
 * 1. Created by [ReverseConnectHandler.handleConnect] after target socket connects.
 * 2. [startRelay] launches the read-relay and write-loop coroutines.
 * 3. Data flows bidirectionally: tunnel→target via [enqueueWrite], target→tunnel via relay.
 * 4. When either side closes (target EOF, tunnel CLOSE, or explicit [close]), the session
 *    cleans up: cancel jobs, close target socket, close write channel.
 *
 * [close] is idempotent — safe to call multiple times from any thread.
 */
internal class RequestSession(
    val reqid: Int,
    val sender: FrameSender,
    private val targetSocket: TargetSocket,
    private val scope: CoroutineScope,
    private val paddingInjector: PaddingInjector? = null,
    private val onEnd: (RequestSession) -> Unit,
) {
    internal val closed = AtomicBoolean(false)
    private val writeChannel = Channel<ByteArray>(WRITE_CHANNEL_CAPACITY)
    private var writeJob: Job? = null
    private var relayJob: Job? = null

    /** Timestamp of last activity (DATA sent/received), used for drain tracking. */
    @Volatile
    internal var lastActivityAt: Long = System.currentTimeMillis()

    /**
     * Launches the relay and write-loop coroutines.
     */
    fun startRelay() {
        writeJob = scope.launch { writeLoop() }
        relayJob = scope.launch { relayLoop() }
    }

    /**
     * Enqueues data from the tunnel to be written to the target socket.
     * Silently discards data if the session is already closed.
     */
    suspend fun enqueueWrite(data: ByteArray) {
        if (closed.get()) return
        writeChannel.send(data)
    }

    /**
     * Closes the session: cancels jobs, closes target socket, closes write channel.
     * Idempotent — only the first call has effect.
     */
    fun close() {
        if (!closed.compareAndSet(false, true)) return
        writeJob?.cancel()
        relayJob?.cancel()
        try { targetSocket.close() } catch (_: Exception) {}
        writeChannel.close()
        onEnd(this)
    }

    // ── Internal coroutines ──────────────────────────────────────────

    /**
     * Reads from the write channel and writes to the target socket.
     */
    private suspend fun writeLoop() {
        try {
            for (data in writeChannel) {
                targetSocket.write(data)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Target write failed — close the target socket so the relay
            // detects the failure and triggers cleanup.
            try { targetSocket.close() } catch (_: Exception) {}
        }
    }

    /**
     * Reads from the target socket and sends DATA frames through the tunnel.
     * Each read is sent as a single DATA frame (buffer sized to MAX_DATA_CHUNK).
     * Yields between chunks so other sessions can make progress.
     *
     * On target EOF or error, sends CLOSE to the tunnel and cleans up.
     */
    private suspend fun relayLoop() {
        val buffer = ByteArray(FrameCodec.MAX_DATA_CHUNK)
        try {
            while (true) {
                val n = targetSocket.read(buffer)
                if (n <= 0) break
                val chunk = if (n == buffer.size) buffer.copyOf() else buffer.copyOfRange(0, n)
                lastActivityAt = System.currentTimeMillis()
                val sent = sender.sendFrame(FrameCodec.encode(Frame.Data(reqid, chunk)))
                if (sent) paddingInjector?.onDataSent(sender)
                yield() // Allow other sessions to enqueue frames
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Target read failed — fall through to cleanup
        } finally {
            // Only send CLOSE and clean up if we weren't already closed
            // (e.g., by the server sending CLOSE which cancelled our relay job).
            if (closed.compareAndSet(false, true)) {
                try { sender.sendFrame(FrameCodec.encode(Frame.Close(reqid))) } catch (_: Exception) {}
                try { targetSocket.close() } catch (_: Exception) {}
                writeChannel.close()
                writeJob?.cancel()
                onEnd(this)
            }
        }
    }

    companion object {
        private const val WRITE_CHANNEL_CAPACITY = 256
    }
}
