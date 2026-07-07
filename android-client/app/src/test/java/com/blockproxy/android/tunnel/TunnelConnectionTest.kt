package com.blockproxy.android.tunnel

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ClosedReceiveChannelException
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

@OptIn(ExperimentalCoroutinesApi::class)
class TunnelConnectionTest {

    // ── Fake socket for testing ──────────────────────────────────────

    /**
     * In-memory [TunnelSocket] backed by a [Channel].
     *
     * - [enqueueIncomingData] simulates bytes arriving from the server.
     * - [writtenBytes] captures every byte array passed to [write].
     * - [close] sets [closed] = true and closes the incoming-data channel
     *   so that any suspended [read] returns -1.
     */
    class FakeTunnelSocket : TunnelSocket {
        var connected = false
        var closed = false
        val writtenBytes = CopyOnWriteArrayList<ByteArray>()

        private val incomingData = Channel<ByteArray>(Channel.UNLIMITED)

        override suspend fun connect(host: String, port: Int, timeoutMs: Long) {
            connected = true
        }

        override suspend fun read(buffer: ByteArray): Int {
            return try {
                val data = incomingData.receive()
                val len = minOf(data.size, buffer.size)
                System.arraycopy(data, 0, buffer, 0, len)
                len
            } catch (_: ClosedReceiveChannelException) {
                -1
            }
        }

        override suspend fun write(bytes: ByteArray) {
            writtenBytes.add(bytes.copyOf())
        }

        override fun close() {
            closed = true
            incomingData.close()
        }

        /** Enqueue bytes that the next [read] call will return. */
        fun enqueueIncomingData(data: ByteArray) {
            incomingData.trySend(data.copyOf())
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────

    private fun createConnection(
        socket: FakeTunnelSocket,
        scope: CoroutineScope,
        idleTimeoutMs: Long = 60_000L,
        username: String = "testuser",
        password: String = "testpass",
        onFrame: (Frame) -> Unit = {},
        onDisconnect: (Throwable?) -> Unit = {},
    ): TunnelConnection = TunnelConnection(
        id = "test-conn",
        socket = socket,
        username = username,
        password = password,
        scope = scope,
        idleTimeoutMs = idleTimeoutMs,
        onFrame = onFrame,
        onDisconnect = onDisconnect,
    )

    /** Build raw frame bytes for a type that FrameCodec.encode cannot handle (e.g. Unknown). */
    private fun rawFrameBytes(type: Int, payloadAfterType: ByteArray = byteArrayOf()): ByteArray {
        val payload = ByteArray(1 + payloadAfterType.size)
        payload[0] = type.toByte()
        payloadAfterType.copyInto(payload, 1)
        val result = ByteArray(2 + payload.size)
        result[0] = (payload.size shr 8).toByte()
        result[1] = (payload.size and 0xFF).toByte()
        payload.copyInto(result, 2)
        return result
    }

    // ── Tests ────────────────────────────────────────────────────────

    @Test
    fun `sends AUTH immediately after connect`() = runTest {
        val socket = FakeTunnelSocket()
        val conn = createConnection(socket, backgroundScope)

        conn.connect("localhost", 8003)
        runCurrent()

        // AUTH should be the first (and only) write
        assertEquals(1, socket.writtenBytes.size)
        val sentFrame = FrameCodec.decode(socket.writtenBytes[0])
        assertTrue("Expected Frame.Auth, got $sentFrame", sentFrame is Frame.Auth)
        val auth = sentFrame as Frame.Auth
        assertEquals("testuser", auth.username)
        assertEquals("testpass", auth.password)
    }

    @Test
    fun `AUTH_OK marks authenticated`() = runTest {
        val socket = FakeTunnelSocket()
        val frames = mutableListOf<Frame>()
        val conn = createConnection(socket, backgroundScope, onFrame = { frames.add(it) })

        conn.connect("localhost", 8003)
        runCurrent()

        // Server responds with AUTH_OK
        socket.enqueueIncomingData(FrameCodec.encode(Frame.AuthOk))
        runCurrent()

        assertTrue("Connection should be authenticated", conn.isAuthenticated)
        assertTrue("onFrame should have received AuthOk", frames.any { it is Frame.AuthOk })
    }

    @Test
    fun `AUTH_FAIL throws auth failed`() = runTest {
        val socket = FakeTunnelSocket()
        var disconnectError: Throwable? = null
        val conn = createConnection(socket, backgroundScope, onDisconnect = { disconnectError = it })

        conn.connect("localhost", 8003)
        runCurrent()

        // Server responds with AUTH_FAIL
        socket.enqueueIncomingData(FrameCodec.encode(Frame.AuthFail))
        runCurrent()

        assertNotNull("onDisconnect should have been called", disconnectError)
        assertTrue(
            "Expected TunnelAuthFailedException, got ${disconnectError!!::class.simpleName}",
            disconnectError is TunnelAuthFailedException,
        )
    }

    @Test
    fun `AUTH-stage ERROR throws occupied`() = runTest {
        val socket = FakeTunnelSocket()
        var disconnectError: Throwable? = null
        val conn = createConnection(socket, backgroundScope, onDisconnect = { disconnectError = it })

        conn.connect("localhost", 8003)
        runCurrent()

        // Server responds with ERROR during auth
        socket.enqueueIncomingData(FrameCodec.encode(Frame.Error("slot occupied")))
        runCurrent()

        assertNotNull("onDisconnect should have been called", disconnectError)
        assertTrue(
            "Expected TunnelOccupiedException, got ${disconnectError!!::class.simpleName}",
            disconnectError is TunnelOccupiedException,
        )
        assertEquals("slot occupied", disconnectError?.message)
    }

    @Test
    fun `PING gets PONG on same connection`() = runTest {
        val socket = FakeTunnelSocket()
        val conn = createConnection(socket, backgroundScope)

        conn.connect("localhost", 8003)
        runCurrent()

        // Authenticate first
        socket.enqueueIncomingData(FrameCodec.encode(Frame.AuthOk))
        runCurrent()

        // Server sends PING
        socket.enqueueIncomingData(FrameCodec.encode(Frame.Ping))
        runCurrent()

        // Connection should have written PONG
        val expectedPong = FrameCodec.encode(Frame.Pong)
        assertTrue(
            "Expected PONG in written bytes",
            socket.writtenBytes.any { it.contentEquals(expectedPong) },
        )
    }

    @Test
    fun `fixed-frame idle timeout closes connection`() = runTest {
        val socket = FakeTunnelSocket()
        val conn = createConnection(socket, backgroundScope, idleTimeoutMs = 1_000L)

        conn.connect("localhost", 8003)
        runCurrent()

        // Authenticate
        socket.enqueueIncomingData(FrameCodec.encode(Frame.AuthOk))
        runCurrent()

        assertFalse("Socket should not be closed yet", socket.closed)

        // Advance virtual time past the idle timeout
        advanceTimeBy(1_500L)
        runCurrent()

        assertTrue("Socket should be closed after idle timeout", socket.closed)
    }

    @Test
    fun `send(frame) uses FrameCodec encode and SendQueue`() = runTest {
        val socket = FakeTunnelSocket()
        val conn = createConnection(socket, backgroundScope)

        conn.connect("localhost", 8003)
        runCurrent()

        // Authenticate
        socket.enqueueIncomingData(FrameCodec.encode(Frame.AuthOk))
        runCurrent()

        // Send a DATA frame through the public send() method
        val dataFrame = Frame.Data(1, byteArrayOf(0x01, 0x02, 0x03))
        conn.send(dataFrame)
        runCurrent()

        // The encoded bytes should appear in the socket's written list
        val expectedBytes = FrameCodec.encode(dataFrame)
        assertTrue(
            "Expected FrameCodec-encoded Data frame in written bytes",
            socket.writtenBytes.any { it.contentEquals(expectedBytes) },
        )
    }

    @Test
    fun `post-auth Frame Unknown is logged and ignored`() = runTest {
        val socket = FakeTunnelSocket()
        var disconnected = false
        val conn = createConnection(socket, backgroundScope, onDisconnect = { disconnected = true })

        conn.connect("localhost", 8003)
        runCurrent()

        // Authenticate
        socket.enqueueIncomingData(FrameCodec.encode(Frame.AuthOk))
        runCurrent()

        // Send an unknown frame type (0xFF) after authentication
        socket.enqueueIncomingData(rawFrameBytes(0xFF, byteArrayOf(0x01, 0x02)))
        runCurrent()

        // Connection should remain alive — unknown frames are ignored post-auth
        assertFalse("Connection should stay alive after post-auth Unknown frame", disconnected)
        assertFalse("Socket should not be closed", socket.closed)
    }

    @Test
    fun `authentication-stage unknown frame is protocol error`() = runTest {
        val socket = FakeTunnelSocket()
        var disconnectError: Throwable? = null
        val conn = createConnection(socket, backgroundScope, onDisconnect = { disconnectError = it })

        conn.connect("localhost", 8003)
        runCurrent()

        // Send an unknown frame BEFORE AUTH_OK arrives
        socket.enqueueIncomingData(rawFrameBytes(0xFF, byteArrayOf(0x01, 0x02)))
        runCurrent()

        assertNotNull("onDisconnect should have been called", disconnectError)
        assertTrue(
            "Expected TunnelProtocolException, got ${disconnectError!!::class.simpleName}",
            disconnectError is TunnelProtocolException,
        )
    }

    @Test
    fun `idle timeout closes socket to interrupt blocking read`() = runTest {
        val socket = FakeTunnelSocket()
        var disconnectCalled = false
        val conn = createConnection(
            socket,
            backgroundScope,
            idleTimeoutMs = 500L,
            onDisconnect = { disconnectCalled = true },
        )

        conn.connect("localhost", 8003)
        runCurrent()

        // Authenticate
        socket.enqueueIncomingData(FrameCodec.encode(Frame.AuthOk))
        runCurrent()

        // No more data — the receive loop is blocked on socket.read()
        // Advance virtual time past the idle timeout
        advanceTimeBy(600L)
        runCurrent()

        // The socket must be closed so that any blocking InputStream.read()
        // in the production adapter is interrupted.
        assertTrue("Socket should be closed to interrupt blocking read", socket.closed)
        assertTrue("onDisconnect should have been called", disconnectCalled)
    }
}
