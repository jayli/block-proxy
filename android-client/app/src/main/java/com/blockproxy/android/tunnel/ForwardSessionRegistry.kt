package com.blockproxy.android.tunnel

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

/**
 * Manages forward CONNECT sessions over tunnel connections.
 *
 * Forward CONNECT is initiated by the Android client: the client sends a
 * CONNECT frame to the server, which opens a TCP connection to the target
 * and replies with CONNECT_OK or CONNECT_FAILED.  Data then flows
 * bidirectionally until one side sends CLOSE.
 *
 * Responsibilities:
 * - Allocate forward reqids (`0x8000..0xFFFE` by default), wrapping and
 *   skipping active reqids to avoid collisions.
 * - Bind each session to a specific [TunnelConnection] using round-robin.
 * - Wait for CONNECT_OK / CONNECT_FAILED with a configurable timeout.
 * - Queue inbound DATA per-session with bounded back-pressure.
 * - Clean up sessions when a tunnel connection disconnects.
 * - Close all sessions on [stop].
 *
 * @param scope            Coroutine scope for the registry (unused directly,
 *                         but available for future background tasks).
 * @param connectTimeoutMs How long to wait for CONNECT_OK / CONNECT_FAILED
 *                         before giving up (default 10 s).
 * @param reqidMin         Minimum forward reqid (inclusive, default 0x8000).
 * @param reqidMax         Maximum forward reqid (inclusive, default 0xFFFE).
 * @param inboundCapacity  Bounded capacity of each session's inbound DATA channel.
 */
class ForwardSessionRegistry(
    @Suppress("unused") private val scope: kotlinx.coroutines.CoroutineScope,
    private val connectTimeoutMs: Long = 10_000L,
    private val reqidMin: Int = FORWARD_REQID_MIN,
    private val reqidMax: Int = FORWARD_REQID_MAX,
    private val inboundCapacity: Int = DEFAULT_INBOUND_CAPACITY,
    private val paddingInjector: PaddingInjector? = null,
) {
    companion object {
        /** First reqid in the forward range. */
        const val FORWARD_REQID_MIN = 0x8000
        /** Last reqid in the forward range. */
        const val FORWARD_REQID_MAX = 0xFFFE
        /** Default bounded capacity for inbound DATA per session. */
        const val DEFAULT_INBOUND_CAPACITY = 256
    }

    private val sessions = ConcurrentHashMap<Int, ForwardSession>()
    private val allocMutex = Mutex()
    private var nextReqid = reqidMin

    // ── Public query API ─────────────────────────────────────────────

    /** Returns true if [reqid] falls in the forward reqid range. */
    fun isForwardReqid(reqid: Int): Boolean = reqid in reqidMin..reqidMax

    /** Returns true if there is an active session with the given [reqid]. */
    fun hasSession(reqid: Int): Boolean = sessions.containsKey(reqid)

    // ── Open ─────────────────────────────────────────────────────────

    /**
     * Opens a new forward session to [host]:[port] over the given [sender].
     *
     * 1. Allocates a forward reqid.
     * 2. Sends a CONNECT frame.
     * 3. Waits for CONNECT_OK / CONNECT_FAILED (with timeout).
     * 4. Returns the [ForwardSession] on success, throws [IOException] on
     *    failure or timeout.
     *
     * @throws IOException if CONNECT fails or the timeout fires.
     */
    suspend fun open(
        host: String,
        port: Int,
        sender: FrameSender,
    ): ForwardSession {
        val reqid = allocateReqid()

        val openResult = CompletableDeferred<Unit>()
        val session = ForwardSession(
            reqid = reqid,
            host = host,
            port = port,
            sender = sender,
            openResult = openResult,
            inboundCapacity = inboundCapacity,
            paddingInjector = paddingInjector,
            onEnd = { s -> sessions.remove(s.reqid, s) },
        )
        sessions[reqid] = session

        // Send CONNECT frame
        try {
            sender.sendFrame(
                FrameCodec.encode(Frame.Connect(reqid, hostToAddress(host), port))
            )
        } catch (e: Exception) {
            sessions.remove(reqid, session)
            throw e
        }

        // Wait for CONNECT_OK / CONNECT_FAILED with timeout
        try {
            withTimeout(connectTimeoutMs) {
                openResult.await()
            }
        } catch (_: TimeoutCancellationException) {
            sessions.remove(reqid, session)
            session.close()
            throw IOException("Forward CONNECT timed out after ${connectTimeoutMs}ms")
        } catch (e: kotlinx.coroutines.CancellationException) {
            sessions.remove(reqid, session)
            session.close()
            throw e
        } catch (e: Exception) {
            sessions.remove(reqid, session)
            throw e
        }

        return session
    }

    // ── Inbound frame dispatch ───────────────────────────────────────

    /**
     * Dispatches an inbound frame from the tunnel server.
     *
     * Called by TunnelClient's onFrame callback for ConnectOk, ConnectFailed,
     * and Data/Close frames that belong to a known forward session.
     */
    suspend fun handleFrame(frame: Frame) {
        when (frame) {
            is Frame.ConnectOk -> {
                val session = sessions[frame.reqid] ?: return
                session.openResult.complete(Unit)
            }
            is Frame.ConnectFailed -> {
                val session = sessions.remove(frame.reqid) ?: return
                session.openResult.completeExceptionally(
                    IOException("Forward CONNECT failed for reqid ${frame.reqid}")
                )
                session.close()
            }
            is Frame.Data -> {
                val session = sessions[frame.reqid] ?: return
                session.deliverData(frame.payload)
            }
            is Frame.Close -> {
                val session = sessions.remove(frame.reqid) ?: return
                session.close()
            }
            else -> { /* ignore other frame types */ }
        }
    }

    // ── Connection cleanup ───────────────────────────────────────────

    /**
     * Closes all forward sessions bound to the given [sender].
     *
     * Called when a transport session disconnects. Pending opens are failed
     * with an IOException so the caller can retry on another connection.
     */
    fun closeSessionsFor(sender: FrameSender) {
        val toClose = sessions.entries
            .filter { it.value.sender === sender }
            .map { it.key to it.value }

        for ((reqid, session) in toClose) {
            sessions.remove(reqid, session)
            session.openResult.completeExceptionally(
                IOException("Tunnel connection disconnected")
            )
            session.close()
        }
    }

    /**
     * Closes all forward sessions and fails any pending opens.
     * Called when the TunnelClient stops.
     *
     * Contract: This is a best-effort shutdown. Consumers reading from
     * [ForwardSession.inboundData] must handle channel closure (ClosedReceiveChannelException
     * or null returns). In-flight sendData() calls may fail silently.
     */
    fun stop() {
        val all = sessions.entries.toList()
        sessions.clear()
        for ((_, session) in all) {
            session.openResult.completeExceptionally(
                IOException("Forward session registry stopped")
            )
            session.close()
        }
    }

    // ── Drain state ──────────────────────────────────────────────────

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

    // ── Internal ─────────────────────────────────────────────────────

    /**
     * Allocates the next available forward reqid.
     *
     * Starts from [nextReqid], wraps at [reqidMax] back to [reqidMin],
     * and skips any reqid that is currently in use.
     *
     * @throws IOException if all reqids in the range are occupied.
     */
    private suspend fun allocateReqid(): Int {
        allocMutex.withLock {
            val start = nextReqid
            var candidate = start
            do {
                if (!sessions.containsKey(candidate)) {
                    // Advance for next time
                    nextReqid = candidate + 1
                    if (nextReqid > reqidMax) nextReqid = reqidMin
                    return candidate
                }
                candidate++
                if (candidate > reqidMax) candidate = reqidMin
            } while (candidate != start)
            throw IOException("No available forward reqids (all ${reqidMax - reqidMin + 1} occupied)")
        }
    }

    /**
     * Converts a host string to the appropriate [FrameAddress].
     * IPv4 addresses (dotted decimal) become [FrameAddress.IPv4];
     * everything else becomes [FrameAddress.Domain].
     */
    private fun hostToAddress(host: String): FrameAddress {
        return if (IPV4_REGEX.matches(host)) {
            FrameAddress.IPv4(host)
        } else {
            FrameAddress.Domain(host)
        }
    }

    private val IPV4_REGEX = Regex("^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$")
}

/** Drain state for a transport session: number of active requests and last activity timestamp. */
data class DrainState(val activeCount: Int, val lastActivityAt: Long)
