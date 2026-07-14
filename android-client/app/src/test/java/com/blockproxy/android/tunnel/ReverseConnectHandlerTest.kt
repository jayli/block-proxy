package com.blockproxy.android.tunnel

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ClosedReceiveChannelException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

@OptIn(ExperimentalCoroutinesApi::class)
class ReverseConnectHandlerTest {

    // ── Fake target socket ──────────────────────────────────────────

    /** In-memory [TargetSocket] for target (downstream) connections. */
    class FakeTargetSocket : TargetSocket {
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

    // ── Fake FrameSender ────────────────────────────────────────────

    class FakeFrameSender : FrameSender {
        @Volatile override var isOpen: Boolean = true
        val writtenBytes = CopyOnWriteArrayList<ByteArray>()
        private val closed = AtomicBoolean(false)

        override suspend fun sendFrame(encoded: ByteArray): Boolean {
            if (!isOpen || closed.get()) return false
            writtenBytes.add(encoded.copyOf())
            return true
        }

        override fun close(code: Int, reason: String) {
            if (closed.compareAndSet(false, true)) {
                isOpen = false
            }
        }
    }

    // ── Factory ──────────────────────────────────────────────────────

    class TestTargetSocketFactory : TargetSocketFactory {
        val sockets = mutableListOf<FakeTargetSocket>()
        var nextSocket: FakeTargetSocket? = null

        override fun create(): TargetSocket {
            val socket = nextSocket ?: FakeTargetSocket()
            nextSocket = null
            sockets.add(socket)
            return socket
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────

    private fun decodeSentFrames(sender: FakeFrameSender): List<Frame> {
        return sender.writtenBytes.map { FrameCodec.decode(it) }
    }

    // ── Tests ────────────────────────────────────────────────────────

    @Test
    fun `RealTargetSocket connects despite protect returning false`() = runTest {
        var protectCalled = false
        val protectResult = false
        val targetSocket = RealTargetSocket(protect = { s: Socket ->
            protectCalled = true
            protectResult
        })

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
    fun `CONNECT success sends CONNECT_OK on same sender`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)
        val targetSocket = FakeTargetSocket()
        factory.nextSocket = targetSocket

        val sender = FakeFrameSender()

        handler.handleFrame(sender, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        assertTrue("Target socket should be connected", targetSocket.connected)

        val sentFrames = decodeSentFrames(sender)
        val connectOk = sentFrames.filterIsInstance<Frame.ConnectOk>()
        assertEquals("Should have exactly one CONNECT_OK", 1, connectOk.size)
        assertEquals("CONNECT_OK should have reqid=1", 1, connectOk[0].reqid)

        handler.closeSessionsFor(sender)
    }

    @Test
    fun `CONNECT failure sends CONNECT_FAILED`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)
        val targetSocket = FakeTargetSocket()
        targetSocket.connectShouldFail = true
        factory.nextSocket = targetSocket

        val sender = FakeFrameSender()

        handler.handleFrame(sender, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        assertFalse("Target socket should NOT be connected", targetSocket.connected)
        assertTrue("Target socket should be closed after failure", targetSocket.closeCount.get() > 0)

        val sentFrames = decodeSentFrames(sender)
        val failed = sentFrames.filterIsInstance<Frame.ConnectFailed>()
        assertEquals("Should have exactly one CONNECT_FAILED", 1, failed.size)
        assertEquals(1, failed[0].reqid)

        handler.closeSessionsFor(sender)
    }

    @Test
    fun `CONNECT timeout sends CONNECT_FAILED`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory, connectTimeoutMs = 5_000L)
        val targetSocket = FakeTargetSocket()
        targetSocket.connectDelayMs = 60_000L
        factory.nextSocket = targetSocket

        val sender = FakeFrameSender()

        handler.handleFrame(sender, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        advanceTimeBy(6_000L)
        runCurrent()

        val sentFrames = decodeSentFrames(sender)
        val failed = sentFrames.filterIsInstance<Frame.ConnectFailed>()
        assertEquals("Should have CONNECT_FAILED on timeout", 1, failed.size)
        assertEquals(1, failed[0].reqid)

        handler.closeSessionsFor(sender)
    }

    @Test
    fun `target to tunnel data is split into max 65532 byte DATA frames`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)
        val targetSocket = FakeTargetSocket()
        factory.nextSocket = targetSocket

        val sender = FakeFrameSender()

        handler.handleFrame(sender, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        val largeData = ByteArray(150_000) { (it % 256).toByte() }
        targetSocket.enqueueIncomingData(largeData)
        targetSocket.enqueueEOF()
        advanceUntilIdle()

        val sentFrames = decodeSentFrames(sender)
        val dataFrames = sentFrames.filterIsInstance<Frame.Data>().filter { it.reqid == 1 }

        assertEquals("Expected 3 DATA chunks", 3, dataFrames.size)
        assertTrue("All chunks <= 65532", dataFrames.all { it.payload.size <= 65532 })
        assertEquals(65532, dataFrames[0].payload.size)
        assertEquals(65532, dataFrames[1].payload.size)
        assertEquals(150_000 - 65532 - 65532, dataFrames[2].payload.size)

        val reconstructed = dataFrames.fold(ByteArray(0)) { acc, frame -> acc + frame.payload }
        assertArrayEquals("Reconstructed data should match original", largeData, reconstructed)

        handler.closeSessionsFor(sender)
    }

    @Test
    fun `target to tunnel DATA triggers padding after successful send`() = runTest {
        val factory = TestTargetSocketFactory()
        val paddingInjector = PaddingInjector(
            scope = this,
            config = PaddingConfig(enabled = true, probability = 1.0f, minBytes = 2, maxBytes = 2),
        )
        val handler = ReverseConnectHandler(this, factory, paddingInjector = paddingInjector)
        val targetSocket = FakeTargetSocket()
        factory.nextSocket = targetSocket
        val sender = FakeFrameSender()

        handler.handleFrame(sender, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        targetSocket.enqueueIncomingData(byteArrayOf(0x01, 0x02, 0x03))
        targetSocket.enqueueEOF()
        advanceUntilIdle()

        val sentFrames = decodeSentFrames(sender)
        assertEquals(1, sentFrames.filterIsInstance<Frame.Data>().size)
        val padding = sentFrames.filterIsInstance<Frame.Padding>().single()
        assertEquals(2, padding.data.size)
    }

    @Test
    fun `tunnel to target DATA writes in order`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)
        val targetSocket = FakeTargetSocket()
        factory.nextSocket = targetSocket

        val sender = FakeFrameSender()

        handler.handleFrame(sender, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        for (i in 1..10) {
            handler.handleFrame(sender, Frame.Data(1, byteArrayOf(i.toByte())))
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

        handler.closeSessionsFor(sender)
    }

    @Test
    fun `CLOSE is idempotent`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)
        val targetSocket = FakeTargetSocket()
        factory.nextSocket = targetSocket

        val sender = FakeFrameSender()

        handler.handleFrame(sender, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        handler.handleFrame(sender, Frame.Close(1))
        advanceUntilIdle()
        handler.handleFrame(sender, Frame.Close(1))
        advanceUntilIdle()

        assertEquals("Target socket close count should be 1", 1, targetSocket.closeCount.get())

        handler.closeSessionsFor(sender)
    }

    @Test
    fun `repeated CLOSE does not close target socket more than once`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)
        val targetSocket = FakeTargetSocket()
        factory.nextSocket = targetSocket

        val sender = FakeFrameSender()

        handler.handleFrame(sender, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        repeat(5) {
            handler.handleFrame(sender, Frame.Close(1))
        }
        advanceUntilIdle()

        assertEquals("Target socket closed exactly once", 1, targetSocket.closeCount.get())

        handler.closeSessionsFor(sender)
    }

    @Test
    fun `late DATA after close is discarded`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)
        val targetSocket = FakeTargetSocket()
        factory.nextSocket = targetSocket

        val sender = FakeFrameSender()

        handler.handleFrame(sender, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        handler.handleFrame(sender, Frame.Close(1))
        advanceUntilIdle()

        val writesBefore = targetSocket.writtenBytes.size

        handler.handleFrame(sender, Frame.Data(1, byteArrayOf(0x42, 0x43)))
        advanceUntilIdle()

        assertEquals("No new writes after close", writesBefore, targetSocket.writtenBytes.size)

        handler.closeSessionsFor(sender)
    }

    @Test
    fun `closeSessionsFor only closes sessions owned by that sender`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)

        val senderA = FakeFrameSender()
        val senderB = FakeFrameSender()

        val targetA = FakeTargetSocket()
        factory.nextSocket = targetA
        handler.handleFrame(senderA, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        val targetB = FakeTargetSocket()
        factory.nextSocket = targetB
        handler.handleFrame(senderB, Frame.Connect(2, FrameAddress.IPv4("5.6.7.8"), 80))
        runCurrent()

        assertTrue("Target A connected", targetA.connected)
        assertTrue("Target B connected", targetB.connected)

        handler.closeSessionsFor(senderA)
        advanceUntilIdle()

        assertEquals("Target A should be closed", 1, targetA.closeCount.get())
        assertEquals("Target B should NOT be closed", 0, targetB.closeCount.get())

        handler.closeSessionsFor(senderB)
    }

    @Test
    fun `large relay yields between chunks allowing other reqid to proceed`() = runTest {
        val factory = TestTargetSocketFactory()
        val handler = ReverseConnectHandler(this, factory)

        val sender = FakeFrameSender()

        val targetSocket1 = FakeTargetSocket()
        factory.nextSocket = targetSocket1
        handler.handleFrame(sender, Frame.Connect(1, FrameAddress.IPv4("1.2.3.4"), 80))
        runCurrent()

        val targetSocket2 = FakeTargetSocket()
        factory.nextSocket = targetSocket2
        handler.handleFrame(sender, Frame.Connect(2, FrameAddress.IPv4("5.6.7.8"), 80))
        runCurrent()

        val largeData = ByteArray(200_000) { (it % 256).toByte() }
        targetSocket1.enqueueIncomingData(largeData)

        handler.handleFrame(sender, Frame.Data(2, byteArrayOf(0x42)))
        advanceUntilIdle()

        targetSocket1.enqueueEOF()
        advanceUntilIdle()

        assertTrue(
            "Reqid 2 data should have been written to target 2",
            targetSocket2.writtenBytes.any { it.contentEquals(byteArrayOf(0x42)) },
        )

        val sentFrames = decodeSentFrames(sender)
        val dataFrames1 = sentFrames.filterIsInstance<Frame.Data>().filter { it.reqid == 1 }
        val totalBytes = dataFrames1.sumOf { it.payload.size }
        assertEquals("All 200_000 bytes should be relayed", 200_000, totalBytes)
        assertTrue("All chunks <= 65532", dataFrames1.all { it.payload.size <= 65532 })

        handler.closeSessionsFor(sender)
    }
}
