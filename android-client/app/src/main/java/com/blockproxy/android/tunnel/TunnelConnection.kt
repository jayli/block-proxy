package com.blockproxy.android.tunnel

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Abstraction over a network socket for the tunnel connection.
 *
 * Production code uses [RealTunnelSocket] which wraps a Java [Socket] or [SSLSocket].
 * Tests use a fake implementation to avoid real networking.
 */
interface TunnelSocket {
    suspend fun connect(host: String, port: Int, timeoutMs: Long)
    suspend fun read(buffer: ByteArray): Int
    suspend fun write(bytes: ByteArray)
    fun close()
}

/** Thrown when the server responds with AUTH_FAIL. */
class TunnelAuthFailedException(message: String) : Exception(message)

/** Thrown when the server responds with ERROR during the authentication phase. */
class TunnelOccupiedException(message: String) : Exception(message)

/** Thrown when an unexpected or malformed frame is received during authentication. */
class TunnelProtocolException(message: String) : Exception(message)

/**
 * Manages a single authenticated tunnel connection.
 *
 * Lifecycle:
 * 1. [connect] establishes the socket, sends AUTH, and starts the receive loop.
 * 2. The receive loop waits for AUTH_OK / AUTH_FAIL / ERROR to complete authentication.
 * 3. After authentication, inbound frames are dispatched via [onFrame] and the caller
 *    can send outbound frames via [send].
 * 4. An idle timeout (default 60 s) fires if no **complete** frame is assembled within
 *    the window; partial reads do not reset the timer. On timeout the socket is closed
 *    to interrupt any blocking read.
 * 5. When the connection ends (EOF, timeout, protocol error, or explicit [close]),
 *    [onDisconnect] is invoked exactly once (unless the scope was cancelled).
 *
 * @param id           Human-readable identifier for logging.
 * @param socket       Transport abstraction (real TLS socket or test fake).
 * @param username     Authentication username.
 * @param password     Authentication password.
 * @param scope        Coroutine scope that owns the receive loop and send queue.
 * @param idleTimeoutMs  Full-frame idle timeout in milliseconds (default 60 000).
 * @param onFrame      Called for every valid inbound frame after authentication
 *                     (and for AUTH_OK during authentication).
 * @param onDisconnect Called once when the connection ends; null for a clean EOF,
 *                     non-null for errors.  Not called when the parent scope is cancelled.
 */
class TunnelConnection(
    val id: String,
    private val socket: TunnelSocket,
    private val username: String,
    private val password: String,
    private val scope: CoroutineScope,
    private val idleTimeoutMs: Long = DEFAULT_IDLE_TIMEOUT_MS,
    private val onFrame: (Frame) -> Unit,
    private val onDisconnect: (Throwable?) -> Unit,
) {
    companion object {
        const val DEFAULT_IDLE_TIMEOUT_MS = 60_000L
        private const val READ_BUFFER_SIZE = 8192
    }

    private val frameExtractor = FrameExtractor()
    private val sendQueue = SendQueue(scope) { bytes -> socket.write(bytes) }

    @Volatile
    private var authenticated = false

    private val closedFlag = AtomicBoolean(false)

    private var receiveJob: Job? = null

    /** Whether the connection has completed authentication. */
    val isAuthenticated: Boolean get() = authenticated

    // ── Public API ────────────────────────────────────────────────────

    /**
     * Connects the socket, sends AUTH immediately, and starts the receive loop.
     */
    suspend fun connect(host: String, port: Int, timeoutMs: Long = 10_000L) {
        socket.connect(host, port, timeoutMs)
        // Send AUTH frame immediately via the send queue
        val authBytes = FrameCodec.encode(Frame.Auth(username, password))
        sendQueue.enqueue(authBytes)
        // Start the receive loop in the provided scope
        receiveJob = scope.launch { receiveLoop() }
    }

    /**
     * Encodes [frame] with [FrameCodec] and enqueues it for serial writing.
     *
     * All outbound frames (PONG, CONNECT_OK, CONNECT_FAILED, DATA, CLOSE, etc.)
     * go through this method.
     */
    suspend fun send(frame: Frame) {
        val encoded = FrameCodec.encode(frame)
        sendQueue.enqueue(encoded)
    }

    /**
     * Cancels the receive loop, closes the socket, and drains the send queue.
     *
     * Safe to call multiple times; only the first call has effect.
     * Does NOT trigger [onDisconnect] — the caller already knows the connection
     * is being closed.
     */
    suspend fun close() {
        if (!closedFlag.compareAndSet(false, true)) return
        receiveJob?.cancel()
        // Close socket BEFORE send queue to unblock any pending writes
        try { socket.close() } catch (_: Exception) { /* best effort */ }
        try { sendQueue.close() } catch (_: Exception) { /* best effort */ }
    }

    // ── Internal ──────────────────────────────────────────────────────

    /**
     * Main receive loop.  Reads bytes from the socket, reassembles frames via
     * [FrameExtractor], and dispatches them through [handleFrame].
     *
     * The idle timeout wraps the entire "read until a complete frame is available"
     * cycle so that only a **complete** frame resets the timer — partial length
     * prefixes or partial payloads do NOT extend the deadline.
     */
    private suspend fun receiveLoop() {
        val buffer = ByteArray(READ_BUFFER_SIZE)
        var error: Throwable? = null
        try {
            while (true) {
                // withTimeoutOrNull returns null when the timeout fires.
                // A non-null result of null from the *inner* lambda means EOF.
                // We use a sentinel to distinguish the two cases.
                val result = withTimeoutOrNull(idleTimeoutMs) {
                    // Read until we get a complete frame or hit EOF
                    while (true) {
                        val n = socket.read(buffer)
                        if (n <= 0) return@withTimeoutOrNull ReadResult.Eof
                        frameExtractor.append(buffer.copyOfRange(0, n))
                        frameExtractor.nextFrame()?.let { return@withTimeoutOrNull ReadResult.FrameRead(it) }
                        // Partial data — keep reading; the timer does NOT reset.
                    }
                    @Suppress("UNREACHABLE_CODE")
                    ReadResult.Eof // unreachable, satisfies type inference
                }

                when {
                    result == null -> {
                        // Timeout — close the socket to interrupt any blocking read
                        try { socket.close() } catch (_: Exception) {}
                        break
                    }
                    result is ReadResult.Eof -> {
                        // Clean EOF from the server — close socket for defense in depth
                        try { socket.close() } catch (_: Exception) {}
                        break
                    }
                    result is ReadResult.FrameRead -> {
                        handleFrame(result.frame)
                    }
                }
            }
        } catch (e: CancellationException) {
            // Scope cancelled — propagate, do NOT call onDisconnect
            throw e
        } catch (e: Exception) {
            error = e
        }
        onDisconnect(error)
    }

    /**
     * Dispatches a decoded frame according to the current authentication state.
     *
     * **During authentication:**
     * - AUTH_OK  → mark authenticated, notify via [onFrame]
     * - AUTH_FAIL → throw [TunnelAuthFailedException]
     * - ERROR    → throw [TunnelOccupiedException]
     * - PING     → respond with PONG (allowed at any stage)
     * - Unknown  → throw [TunnelProtocolException]
     * - Anything else → throw [TunnelProtocolException]
     *
     * **After authentication:**
     * - PING     → respond with PONG
     * - Unknown  → silently ignored (logged in production)
     * - Anything else → notify via [onFrame]
     */
    private suspend fun handleFrame(frame: Frame) {
        if (!authenticated) {
            when (frame) {
                is Frame.AuthOk -> {
                    authenticated = true
                    onFrame(frame)
                }
                is Frame.AuthFail -> {
                    throw TunnelAuthFailedException("Authentication failed")
                }
                is Frame.Error -> {
                    throw TunnelOccupiedException(frame.message)
                }
                is Frame.Ping -> {
                    send(Frame.Pong)
                }
                is Frame.Unknown -> {
                    throw TunnelProtocolException(
                        "Unknown frame type 0x${frame.type.toString(16)} during authentication"
                    )
                }
                else -> {
                    throw TunnelProtocolException(
                        "Unexpected frame ${frame::class.simpleName} during authentication"
                    )
                }
            }
        } else {
            when (frame) {
                is Frame.Ping -> {
                    send(Frame.Pong)
                }
                is Frame.Unknown -> {
                    // Post-auth: log and ignore — do NOT disconnect
                    // In production this would use android.util.Log
                }
                else -> {
                    onFrame(frame)
                }
            }
        }
    }

    /** Internal sealed result for the read-with-timeout helper. */
    private sealed class ReadResult {
        data class FrameRead(val frame: Frame) : ReadResult()
        data object Eof : ReadResult()
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Production socket adapter
// ═══════════════════════════════════════════════════════════════════════

/**
 * Production [TunnelSocket] that wraps a Java [Socket] or [SSLSocket].
 *
 * Key behaviours:
 * - Calls [protect] on the raw socket **before** connecting (required by
 *   Android VpnService to prevent routing loops).
 * - Enables TCP_NODELAY and SO_KEEPALIVE.
 * - When [useTls] is true, negotiates TLS 1.2+ after the TCP handshake.
 * - Trust-all certificate validation is only active when [allowInsecure] is true.
 * - [close] shuts down the underlying Java socket, which interrupts any thread
 *   blocked in [InputStream.read] — this is essential because coroutine
 *   cancellation alone cannot interrupt a blocking JVM I/O call.
 *
 * @param useTls        Wrap the connection in TLS.
 * @param allowInsecure Accept self-signed / untrusted certificates (only when [useTls] is true).
 * @param protect       Called with the raw [Socket] before [Socket.connect];
 *                      typically `vpnService::protect`.
 */
class RealTunnelSocket(
    private val useTls: Boolean,
    private val allowInsecure: Boolean,
    private val protect: (Socket) -> Boolean = { true },
) : TunnelSocket {

    private var socket: Socket? = null
    private var inputStream: InputStream? = null
    private var outputStream: OutputStream? = null

    override suspend fun connect(host: String, port: Int, timeoutMs: Long) {
        val sock = if (useTls) createSslSocket() else Socket()

        // Protect before connect to avoid routing through our own VPN
        // Primary loop prevention is addDisallowedApplication(); protect() is defense-in-depth.
        // On some emulators protect() always returns false — log warning but continue.
        val protected = protect(sock)
        if (!protected) {
            android.util.Log.w("RealTunnelSocket", "VpnService.protect() returned false for $host:$port; continuing with kernel-level exclusion only")
        }

        sock.tcpNoDelay = true
        sock.keepAlive = true

        withContext(Dispatchers.IO) {
            sock.connect(InetSocketAddress(host, port), timeoutMs.toInt())
        }

        if (useTls && sock is SSLSocket) {
            withContext(Dispatchers.IO) {
                sock.startHandshake()
            }
        }

        socket = sock
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

    /**
     * Closes the underlying Java socket.
     *
     * This also interrupts any thread/coroutine blocked in [InputStream.read],
     * which is necessary because coroutine cancellation alone cannot break out
     * of a blocking JVM socket read.
     */
    override fun close() {
        try { socket?.close() } catch (_: Exception) {}
        socket = null
        inputStream = null
        outputStream = null
    }

    private fun createSslSocket(): SSLSocket {
        val sslContext = if (allowInsecure) {
            SSLContext.getInstance("TLS").apply {
                init(
                    null,
                    arrayOf<TrustManager>(object : X509TrustManager {
                        override fun checkClientTrusted(
                            chain: Array<out X509Certificate>?,
                            authType: String?,
                        ) { /* trust all */ }

                        override fun checkServerTrusted(
                            chain: Array<out X509Certificate>?,
                            authType: String?,
                        ) { /* trust all */ }

                        override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
                    }),
                    SecureRandom(),
                )
            }
        } else {
            SSLContext.getDefault()
        }

        val sock = sslContext.socketFactory.createSocket() as SSLSocket
        // Restrict to TLS 1.2+
        sock.enabledProtocols = sock.supportedProtocols
            .filter { it.startsWith("TLSv1.2") || it.startsWith("TLSv1.3") }
            .toTypedArray()
        return sock
    }
}
