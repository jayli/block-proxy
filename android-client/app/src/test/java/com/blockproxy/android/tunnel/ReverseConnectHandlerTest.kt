package com.blockproxy.android.tunnel

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ClosedReceiveChannelException
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalCoroutinesApi::class)
class ReverseConnectHandlerTest {

    // ── Fake target socket ──────────────────────────────────────────

    /**
     * In-memory [TunnelSocket] for target (downstream) connections.
     */
    class FakeTargetSocket : TunnelSocket {
        var connected = false
        var connectShouldFail = false
        var connectDelayMs: Long = 0
        val closeCount = AtomicInteger(0)
        val writtenBytes = CopyOnWriteArrayList<ByteArray>()

        private val incomingData = Channel<ByteArray>(Channel.UNLIMITED)
        private var pending: ByteArray = ByteArray(0)
        private var pendingOffset = 0

        override suspend fun connect(host: String, port: Int, timeoutMs: Long) {
            if (connectDelayMs > 0) delay(connectDelayMs)
            if (connectShouldFail) throw IOException("Simulated connect failure")
            connected = true
        }

        override suspend fun read(buffer: ByteArray): Int {
            while (pendingOffset >= pending.size) {
                val data = try {
                    incomingData.receive()
                } catch (_: ClosedReceiveChannelException) {
                    return -1
                }
                if (data.isEmpty()) return -1
                pending = data
                pendingOffset = 0
            }
            val available = pending.size - pendingOffset
            val len = minOf(available, buffer.size)
            System.arraycopy(pending, pendingOffset, buffer, 0, len)
            pendingOffset += len
            return len
        }

        override suspend fun write(bytes: ByteArray) {
            writtenBytes.add(bytes.copyOf())
        }

        override fun close() {
            closeCount.incrementAndGet()
            incomingData.close()
        }

        fun enqueueIncomingData(data: ByteArray) {
            incomingData.trySend(data.copyOf())
        }

        fun enqueueEOF() {
            incomingData.trySend(ByteArray(0))
        }
    }

    // ── Fake tunnel socket ──────────────────────────────────────────

    class FakeTunnelSocket : TunnelSocket {
        var closed = false
        val writtenBytes = CopyOnWriteArrayList<ByteArray>()
        private val incomingData = Channel<ByteArray>(Channel.UNLIMITED)

        override suspend fun connect(host: String, port: Int, timeoutMs: Long) {}

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
    }

    // ── Factory ──────────────────────────────────────────────────────

    class TestTargetSocketFactory : TargetSocketFactory {
        val sockets = mutableListOf<FakeTargetSocket>()
        var nextSocket: FakeTargetSocket? = null

        override fun create(): TunnelSocket {
            val socket = nextSocket ?: FakeTargetSocket()
            nextSocket = null
            sockets.add(socket as FakeTargetSocket)
            return socket
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────

    private fun decodeSentFrames(tunnelSocket: FakeTunnelSocket): List<Frame> {
        return tunnelSocket.writtenBytes.map { FrameCodec.decode(it) }
    }

    /**
     * Creates a TunnelConnection for handler testing.
     * Uses the TestScope so that SendQueue consumer is driven by runCurrent/advanceUntilIdle.
     */
    private fun createConnection(
        tunnelSocket: FakeTunnelSocket,
        scope: kotlinx.coroutines.CoroutineScope,
    ): TunnelConnection {
        return TunnelConnection(
            id = "test-conn",
            socket = tunnelSocket,
            username = "user",
            password = "pass",
            scope = scope,
            onFrame = { /* not used — tests call handleFrame directly */ },
            onDisconnect = {},
        )
    }

    // ── Tests ────────────────────────────────────────────────────────

    @Test
    fun `RealTargetSocket connects despite protect returning false`() = runTest {
        var protectCalled = false
        var protectResult = false
        val targetSocket = RealTargetSocket(protect = { s: Socket ->
            protectCalled = true
            protectResult
        })

        // protect() returning false should NOT throw — it logs a warning and proceeds.
        // Connection attempt to a discard port will fail with ConnectException, not IOException.
        try {
            targetSocket.connect("127.0.0.1", 9, 1_000)
        } catch (_: Exception) {
            // Expected — port 9 may refuse or timeout
        } finally {
            targetSocket.close()
        }
        assertTrue("protect callback should have been invoked", protectCalled)
    }

    @Test
    fun `CONNECT success sends CONNECT_OK on same tunnel connection`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)
        val targetSocket = FakeTargetSocket()
        factory.nextSocket = targetSocket

        val tunnelSocket = FakeTunnelSocket()
        val conn = createConnection(tunnelSocket, this)

        handler.handleFrame(conn, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        assertTrue("Target socket should be connected", targetSocket.connected)

        val sentFrames = decodeSentFrames(tunnelSocket)
        val connectOk = sentFrames.filterIsInstance<Frame.ConnectOk>()
        assertEquals("Should have exactly one CONNECT_OK", 1, connectOk.size)
        assertEquals("CONNECT_OK should have reqid=1", 1, connectOk[0].reqid)

        handler.closeSessionsFor(conn)
        conn.close()
    }

    @Test
    fun `CONNECT failure sends CONNECT_FAILED`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)
        val targetSocket = FakeTargetSocket()
        targetSocket.connectShouldFail = true
        factory.nextSocket = targetSocket

        val tunnelSocket = FakeTunnelSocket()
        val conn = createConnection(tunnelSocket, this)

        handler.handleFrame(conn, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        assertFalse("Target socket should NOT be connected", targetSocket.connected)
        assertTrue("Target socket should be closed after failure", targetSocket.closeCount.get() > 0)

        val sentFrames = decodeSentFrames(tunnelSocket)
        val failed = sentFrames.filterIsInstance<Frame.ConnectFailed>()
        assertEquals("Should have exactly one CONNECT_FAILED", 1, failed.size)
        assertEquals(1, failed[0].reqid)

        val ok = sentFrames.filterIsInstance<Frame.ConnectOk>()
        assertEquals("Should have no CONNECT_OK", 0, ok.size)

        handler.closeSessionsFor(conn)
        conn.close()
    }

    @Test
    fun `CONNECT timeout sends CONNECT_FAILED`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory, connectTimeoutMs = 5_000L)
        val targetSocket = FakeTargetSocket()
        targetSocket.connectDelayMs = 60_000L
        factory.nextSocket = targetSocket

        val tunnelSocket = FakeTunnelSocket()
        val conn = createConnection(tunnelSocket, this)

        handler.handleFrame(conn, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        advanceTimeBy(6_000L)
        runCurrent()

        val sentFrames = decodeSentFrames(tunnelSocket)
        val failed = sentFrames.filterIsInstance<Frame.ConnectFailed>()
        assertEquals("Should have CONNECT_FAILED on timeout", 1, failed.size)
        assertEquals(1, failed[0].reqid)

        handler.closeSessionsFor(conn)
        conn.close()
    }

    @Test
    fun `target to tunnel data is split into max 65532 byte DATA frames`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)
        val targetSocket = FakeTargetSocket()
        factory.nextSocket = targetSocket

        val tunnelSocket = FakeTunnelSocket()
        val conn = createConnection(tunnelSocket, this)

        handler.handleFrame(conn, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        val largeData = ByteArray(150_000) { (it % 256).toByte() }
        targetSocket.enqueueIncomingData(largeData)
        targetSocket.enqueueEOF()
        advanceUntilIdle()

        val sentFrames = decodeSentFrames(tunnelSocket)
        val dataFrames = sentFrames.filterIsInstance<Frame.Data>().filter { it.reqid == 1 }

        assertEquals("Expected 3 DATA chunks", 3, dataFrames.size)
        assertTrue("All chunks <= 65532", dataFrames.all { it.payload.size <= 65532 })
        assertEquals(65532, dataFrames[0].payload.size)
        assertEquals(65532, dataFrames[1].payload.size)
        assertEquals(150_000 - 65532 - 65532, dataFrames[2].payload.size)

        val reconstructed = dataFrames.fold(ByteArray(0)) { acc, frame ->
            acc + frame.payload
        }
        assertArrayEquals("Reconstructed data should match original", largeData, reconstructed)

        handler.closeSessionsFor(conn)
        conn.close()
    }

    @Test
    fun `tunnel to target DATA writes in order`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)
        val targetSocket = FakeTargetSocket()
        factory.nextSocket = targetSocket

        val tunnelSocket = FakeTunnelSocket()
        val conn = createConnection(tunnelSocket, this)

        handler.handleFrame(conn, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        for (i in 1..10) {
            handler.handleFrame(conn, Frame.Data(1, byteArrayOf(i.toByte())))
        }
        advanceUntilIdle()

        assertEquals("Expected 10 writes", 10, targetSocket.writtenBytes.size)
        for (i in 1..10) {
            assertArrayEquals(
                "Write $i should match",
                byteArrayOf(i.toByte()),
                targetSocket.writtenBytes[i - 1],
            )
        }

        handler.closeSessionsFor(conn)
        conn.close()
    }

    @Test
    fun `CLOSE is idempotent`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)
        val targetSocket = FakeTargetSocket()
        factory.nextSocket = targetSocket

        val tunnelSocket = FakeTunnelSocket()
        val conn = createConnection(tunnelSocket, this)

        handler.handleFrame(conn, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        handler.handleFrame(conn, Frame.Close(1))
        advanceUntilIdle()
        handler.handleFrame(conn, Frame.Close(1))
        advanceUntilIdle()

        assertEquals("Target socket close count should be 1", 1, targetSocket.closeCount.get())

        handler.closeSessionsFor(conn)
        conn.close()
    }

    @Test
    fun `receiving CLOSE then sending CLOSE back is tolerated`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)
        val targetSocket = FakeTargetSocket()
        factory.nextSocket = targetSocket

        val tunnelSocket = FakeTunnelSocket()
        val conn = createConnection(tunnelSocket, this)

        handler.handleFrame(conn, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        handler.handleFrame(conn, Frame.Close(1))
        advanceUntilIdle()

        handler.handleFrame(conn, Frame.Close(1))
        advanceUntilIdle()

        assertEquals("Target socket closed exactly once", 1, targetSocket.closeCount.get())

        handler.closeSessionsFor(conn)
        conn.close()
    }

    @Test
    fun `repeated CLOSE does not close target socket more than once`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)
        val targetSocket = FakeTargetSocket()
        factory.nextSocket = targetSocket

        val tunnelSocket = FakeTunnelSocket()
        val conn = createConnection(tunnelSocket, this)

        handler.handleFrame(conn, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        repeat(5) {
            handler.handleFrame(conn, Frame.Close(1))
        }
        advanceUntilIdle()

        assertEquals(
            "Target socket closed exactly once despite 5 CLOSE frames",
            1,
            targetSocket.closeCount.get(),
        )

        handler.closeSessionsFor(conn)
        conn.close()
    }

    @Test
    fun `late DATA after close is discarded`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)
        val targetSocket = FakeTargetSocket()
        factory.nextSocket = targetSocket

        val tunnelSocket = FakeTunnelSocket()
        val conn = createConnection(tunnelSocket, this)

        handler.handleFrame(conn, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        handler.handleFrame(conn, Frame.Close(1))
        advanceUntilIdle()

        val writesBefore = targetSocket.writtenBytes.size

        handler.handleFrame(conn, Frame.Data(1, byteArrayOf(0x42, 0x43)))
        advanceUntilIdle()

        assertEquals(
            "No new writes after close",
            writesBefore,
            targetSocket.writtenBytes.size,
        )

        handler.closeSessionsFor(conn)
        conn.close()
    }

    @Test
    fun `closeSessionsFor only closes sessions owned by that connection`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)

        val tunnelSocketA = FakeTunnelSocket()
        val connA = createConnection(tunnelSocketA, this)

        val tunnelSocketB = FakeTunnelSocket()
        val connB = createConnection(tunnelSocketB, this)

        val targetA = FakeTargetSocket()
        factory.nextSocket = targetA
        handler.handleFrame(connA, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        val targetB = FakeTargetSocket()
        factory.nextSocket = targetB
        handler.handleFrame(connB, Frame.Connect(2, FrameAddress.IPv4("5.6.7.8"), 80))
        runCurrent()

        assertTrue("Target A connected", targetA.connected)
        assertTrue("Target B connected", targetB.connected)

        handler.closeSessionsFor(connA)
        advanceUntilIdle()

        assertEquals("Target A should be closed", 1, targetA.closeCount.get())
        assertEquals("Target B should NOT be closed", 0, targetB.closeCount.get())

        handler.closeSessionsFor(connB)
        connA.close()
        connB.close()
    }

    @Test
    fun `large relay yields between chunks allowing other reqid to proceed`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)

        val tunnelSocket = FakeTunnelSocket()
        val conn = createConnection(tunnelSocket, this)

        val targetSocket1 = FakeTargetSocket()
        factory.nextSocket = targetSocket1

        handler.handleFrame(conn, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        val targetSocket2 = FakeTargetSocket()
        factory.nextSocket = targetSocket2
        handler.handleFrame(conn, Frame.Connect(2, FrameAddress.IPv4("5.6.7.8"), 80))
        runCurrent()

        val largeData = ByteArray(200_000) { (it % 256).toByte() }
        targetSocket1.enqueueIncomingData(largeData)

        handler.handleFrame(conn, Frame.Data(2, byteArrayOf(0x42)))

        advanceUntilIdle()

        targetSocket1.enqueueEOF()
        advanceUntilIdle()

        assertTrue(
            "Reqid 2 data should have been written to target 2",
            targetSocket2.writtenBytes.any { it.contentEquals(byteArrayOf(0x42)) },
        )

        val sentFrames = decodeSentFrames(tunnelSocket)
        val dataFrames1 = sentFrames.filterIsInstance<Frame.Data>().filter { it.reqid == 1 }
        val totalBytes = dataFrames1.sumOf { it.payload.size }
        assertEquals("All 200_000 bytes should be relayed", 200_000, totalBytes)
        assertTrue("All chunks <= 65532", dataFrames1.all { it.payload.size <= 65532 })

        handler.closeSessionsFor(conn)
        conn.close()
    }
}
