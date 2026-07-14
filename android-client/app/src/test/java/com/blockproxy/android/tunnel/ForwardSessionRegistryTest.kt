package com.blockproxy.android.tunnel

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

@OptIn(ExperimentalCoroutinesApi::class)
class ForwardSessionRegistryTest {

    /** Fake FrameSender that records encoded frames and simulates send. */
    class FakeFrameSender : FrameSender {
        val writtenBytes = CopyOnWriteArrayList<ByteArray>()
        @Volatile override var isOpen: Boolean = true
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

    /** Result wrapper for open() that captures exceptions. */
    private data class OpenResult(val session: ForwardSession?, val error: Throwable?)

    private fun decodeSentFrames(sender: FakeFrameSender): List<Frame> {
        return sender.writtenBytes.map { FrameCodec.decode(it) }
    }

    /**
     * Launches registry.open() in a scope with Unconfined dispatcher and returns
     * a CompletableDeferred that captures both success and failure as [OpenResult].
     */
    private fun openAsync(
        registry: ForwardSessionRegistry,
        host: String,
        port: Int,
        sender: FrameSender,
    ): CompletableDeferred<OpenResult> {
        val deferred = CompletableDeferred<OpenResult>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        scope.launch {
            try {
                val session = registry.open(host, port, sender)
                deferred.complete(OpenResult(session, null))
            } catch (e: Throwable) {
                deferred.complete(OpenResult(null, e))
            }
        }
        return deferred
    }

    // -- Tests --

    @Test
    fun `first forward reqid is 0x8000`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val sender = FakeFrameSender()

        val deferred = openAsync(registry, "example.com", 80, sender)
        runCurrent()

        val frames = decodeSentFrames(sender)
        val connects = frames.filterIsInstance<Frame.Connect>()
        assertEquals("Should have sent one CONNECT", 1, connects.size)
        assertEquals("First forward reqid should be 0x8000", 0x8000, connects[0].reqid)

        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()

        val result = deferred.await()
        assertNotNull(result.session)
        assertEquals(0x8000, result.session!!.reqid)
        assertEquals("example.com", result.session!!.host)
        assertEquals(80, result.session!!.port)
    }

    @Test
    fun `reqid increments sequentially`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val sender = FakeFrameSender()

        val d1 = openAsync(registry, "a.com", 80, sender)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()
        val s1 = d1.await().session!!
        assertEquals(0x8000, s1.reqid)

        val d2 = openAsync(registry, "b.com", 80, sender)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8001))
        runCurrent()
        val s2 = d2.await().session!!
        assertEquals(0x8001, s2.reqid)
    }

    @Test
    fun `reqid wraps after max back to min`() = runTest {
        val registry = ForwardSessionRegistry(
            this, reqidMin = 0x8000, reqidMax = 0x8001,
        )
        val sender = FakeFrameSender()

        val d1 = openAsync(registry, "a.com", 80, sender)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()
        val s1 = d1.await().session!!

        val d2 = openAsync(registry, "b.com", 80, sender)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8001))
        runCurrent()
        d2.await()

        s1.close()
        runCurrent()

        val d3 = openAsync(registry, "c.com", 80, sender)
        runCurrent()

        val frames = decodeSentFrames(sender)
        val connects = frames.filterIsInstance<Frame.Connect>()
        assertEquals(3, connects.size)
        assertEquals("Third CONNECT should wrap to 0x8000", 0x8000, connects[2].reqid)

        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()
        d3.await()
    }

    @Test
    fun `wrap skips active reqids`() = runTest {
        val registry = ForwardSessionRegistry(
            this, reqidMin = 0x8000, reqidMax = 0x8002,
        )
        val sender = FakeFrameSender()

        val d1 = openAsync(registry, "a.com", 80, sender); runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000)); runCurrent(); d1.await()
        val d2 = openAsync(registry, "b.com", 80, sender); runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8001)); runCurrent()
        val s2 = d2.await().session!!
        val d3 = openAsync(registry, "c.com", 80, sender); runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8002)); runCurrent(); d3.await()

        s2.close()
        runCurrent()

        val d4 = openAsync(registry, "d.com", 80, sender)
        runCurrent()

        val frames = decodeSentFrames(sender)
        val connects = frames.filterIsInstance<Frame.Connect>()
        assertEquals(4, connects.size)
        assertEquals("Should skip active 0x8000 and find free 0x8001",
            0x8001, connects[3].reqid)

        registry.handleFrame(Frame.ConnectOk(0x8001)); runCurrent()
        d4.await()
    }

    @Test
    fun `open sends CONNECT with Domain for hostname`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val sender = FakeFrameSender()

        val deferred = openAsync(registry, "example.com", 443, sender)
        runCurrent()

        val frames = decodeSentFrames(sender)
        val connects = frames.filterIsInstance<Frame.Connect>()
        assertEquals(1, connects.size)
        val connect = connects[0]
        assertEquals(0x8000, connect.reqid)
        assertTrue("Address should be Domain", connect.address is FrameAddress.Domain)
        assertEquals("example.com", (connect.address as FrameAddress.Domain).domain)
        assertEquals(443, connect.port)

        registry.handleFrame(Frame.ConnectOk(0x8000)); runCurrent()
        deferred.await()
    }

    @Test
    fun `open sends IPv4 address for IP host`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val sender = FakeFrameSender()

        val deferred = openAsync(registry, "1.2.3.4", 80, sender)
        runCurrent()

        val frames = decodeSentFrames(sender)
        val connect = frames.filterIsInstance<Frame.Connect>().first()
        assertTrue("Address should be IPv4", connect.address is FrameAddress.IPv4)
        assertEquals("1.2.3.4", (connect.address as FrameAddress.IPv4).address)

        registry.handleFrame(Frame.ConnectOk(0x8000)); runCurrent()
        deferred.await()
    }

    @Test
    fun `CONNECT_OK completes open`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val sender = FakeFrameSender()

        val deferred = openAsync(registry, "example.com", 80, sender)
        runCurrent()

        assertFalse("open should not be completed yet", deferred.isCompleted)

        registry.handleFrame(Frame.ConnectOk(0x8000)); runCurrent()

        assertTrue("open should be completed", deferred.isCompleted)
        assertNotNull(deferred.await().session)
    }

    @Test
    fun `CONNECT_FAILED fails open with IOException`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val sender = FakeFrameSender()

        val deferred = openAsync(registry, "example.com", 80, sender)
        runCurrent()

        registry.handleFrame(Frame.ConnectFailed(0x8000)); runCurrent()

        val result = deferred.await()
        assertNull("Session should be null on failure", result.session)
        assertNotNull("Error should be present", result.error)
        assertTrue("Error should be IOException", result.error is IOException)
    }

    @Test
    fun `inbound DATA is queued for the right session`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val sender = FakeFrameSender()

        val d1 = openAsync(registry, "a.com", 80, sender); runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000)); runCurrent()
        val s1 = d1.await().session!!

        val d2 = openAsync(registry, "b.com", 80, sender); runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8001)); runCurrent()
        val s2 = d2.await().session!!

        registry.handleFrame(Frame.Data(0x8000, byteArrayOf(0x01, 0x02)))
        registry.handleFrame(Frame.Data(0x8001, byteArrayOf(0x03, 0x04)))
        runCurrent()

        val data1 = s1.inboundData.tryReceive().getOrNull()
        assertNotNull("Session 1 should have data", data1)
        assertArrayEquals(byteArrayOf(0x01, 0x02), data1)

        val data2 = s2.inboundData.tryReceive().getOrNull()
        assertNotNull("Session 2 should have data", data2)
        assertArrayEquals(byteArrayOf(0x03, 0x04), data2)

        assertNull("Session 1 should have no more data", s1.inboundData.tryReceive().getOrNull())
        assertNull("Session 2 should have no more data", s2.inboundData.tryReceive().getOrNull())
    }

    @Test
    fun `inbound CLOSE ends the right session`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val sender = FakeFrameSender()

        val d1 = openAsync(registry, "a.com", 80, sender); runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000)); runCurrent()
        val s1 = d1.await().session!!

        val d2 = openAsync(registry, "b.com", 80, sender); runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8001)); runCurrent()
        val s2 = d2.await().session!!

        registry.handleFrame(Frame.Close(0x8000)); runCurrent()

        assertTrue("Session 1 should be closed", s1.isClosed)
        assertFalse("Session 2 should still be open", s2.isClosed)

        registry.handleFrame(Frame.Data(0x8000, byteArrayOf(0x42))); runCurrent()
        assertNull("Closed session should not receive data",
            s1.inboundData.tryReceive().getOrNull())
    }

    @Test
    fun `closeSessionsFor cleans only sessions bound to that sender`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val senderA = FakeFrameSender()
        val senderB = FakeFrameSender()

        val d1 = openAsync(registry, "a.com", 80, senderA); runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000)); runCurrent()
        val s1 = d1.await().session!!

        val d2 = openAsync(registry, "b.com", 80, senderA); runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8001)); runCurrent()
        val s2 = d2.await().session!!

        val d3 = openAsync(registry, "c.com", 80, senderB); runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8002)); runCurrent()
        val s3 = d3.await().session!!

        registry.closeSessionsFor(senderA); runCurrent()

        assertTrue("Session on senderA should be closed", s1.isClosed)
        assertTrue("Session on senderA should be closed", s2.isClosed)
        assertFalse("Session on senderB should still be open", s3.isClosed)
    }

    @Test
    fun `disconnect fails pending open on that sender`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val sender = FakeFrameSender()

        val deferred = openAsync(registry, "example.com", 80, sender)
        runCurrent()

        registry.closeSessionsFor(sender); runCurrent()

        val result = deferred.await()
        assertNull("Session should be null", result.session)
        assertNotNull("Error should be present", result.error)
        assertTrue("Error should be IOException", result.error is IOException)
    }

    @Test
    fun `stop closes all sessions`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val sender = FakeFrameSender()

        val d1 = openAsync(registry, "a.com", 80, sender); runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000)); runCurrent()
        val s1 = d1.await().session!!

        val d2 = openAsync(registry, "b.com", 80, sender); runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8001)); runCurrent()
        val s2 = d2.await().session!!

        registry.stop(); runCurrent()

        assertTrue("Session 1 should be closed", s1.isClosed)
        assertTrue("Session 2 should be closed", s2.isClosed)
    }

    @Test
    fun `stop fails pending open`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val sender = FakeFrameSender()

        val deferred = openAsync(registry, "example.com", 80, sender)
        runCurrent()

        registry.stop(); runCurrent()

        val result = deferred.await()
        assertNull("Session should be null", result.session)
        assertNotNull("Error should be present", result.error)
        assertTrue("Error should be IOException", result.error is IOException)
    }

    @Test
    fun `connect timeout fails open`() = runTest {
        val registry = ForwardSessionRegistry(this, connectTimeoutMs = 5_000L)
        val sender = FakeFrameSender()

        val deferred = openAsync(registry, "example.com", 80, sender)
        runCurrent()

        assertFalse("Should not be completed yet", deferred.isCompleted)

        advanceTimeBy(5_001); runCurrent()

        val result = deferred.await()
        assertNull("Session should be null on timeout", result.session)
        assertNotNull("Error should be present", result.error)
        assertTrue("Error should be IOException", result.error is IOException)
    }

    @Test
    fun `session sendData sends DATA frame via sender`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val sender = FakeFrameSender()

        val deferred = openAsync(registry, "example.com", 80, sender); runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000)); runCurrent()
        val session = deferred.await().session!!

        session.sendData(byteArrayOf(0x01, 0x02, 0x03)); runCurrent()

        val frames = decodeSentFrames(sender)
        val dataFrames = frames.filterIsInstance<Frame.Data>()
        assertEquals("Should have sent one DATA frame", 1, dataFrames.size)
        assertEquals(0x8000, dataFrames[0].reqid)
        assertArrayEquals(byteArrayOf(0x01, 0x02, 0x03), dataFrames[0].payload)
    }

    @Test
    fun `session sendData triggers padding after successful DATA send`() = runTest {
        val paddingInjector = PaddingInjector(
            scope = this,
            config = PaddingConfig(enabled = true, probability = 1.0f, minBytes = 2, maxBytes = 2),
        )
        val registry = ForwardSessionRegistry(this, paddingInjector = paddingInjector)
        val sender = FakeFrameSender()

        val deferred = openAsync(registry, "example.com", 80, sender); runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000)); runCurrent()
        val session = deferred.await().session!!

        session.sendData(byteArrayOf(0x01, 0x02, 0x03)); runCurrent()

        val frames = decodeSentFrames(sender)
        assertEquals(1, frames.filterIsInstance<Frame.Data>().size)
        val padding = frames.filterIsInstance<Frame.Padding>().single()
        assertEquals(2, padding.data.size)
    }

    @Test
    fun `session sendClose sends CLOSE frame via sender`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val sender = FakeFrameSender()

        val deferred = openAsync(registry, "example.com", 80, sender); runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000)); runCurrent()
        val session = deferred.await().session!!

        session.sendClose(); runCurrent()

        val frames = decodeSentFrames(sender)
        val closeFrames = frames.filterIsInstance<Frame.Close>()
        assertEquals("Should have sent one CLOSE frame", 1, closeFrames.size)
        assertEquals(0x8000, closeFrames[0].reqid)
        assertTrue("Session should be closed", session.isClosed)
    }

    @Test
    fun `hasSession returns true for active forward sessions`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val sender = FakeFrameSender()

        assertFalse(registry.hasSession(0x8000))

        val deferred = openAsync(registry, "example.com", 80, sender); runCurrent()
        assertTrue("Should have session while waiting for CONNECT_OK",
            registry.hasSession(0x8000))

        registry.handleFrame(Frame.ConnectOk(0x8000)); runCurrent()
        val session = deferred.await().session!!
        assertTrue("Should have session after open", registry.hasSession(0x8000))

        session.close(); runCurrent()
        assertFalse("Should not have session after close", registry.hasSession(0x8000))
    }

    @Test
    fun `isForwardReqid correctly identifies forward range`() = runTest {
        val registry = ForwardSessionRegistry(this)
        assertFalse("0x0001 is reverse", registry.isForwardReqid(0x0001))
        assertFalse("0x7FFF is reverse", registry.isForwardReqid(0x7FFF))
        assertTrue("0x8000 is forward", registry.isForwardReqid(0x8000))
        assertTrue("0xFFFE is forward", registry.isForwardReqid(0xFFFE))
        assertFalse("0xFFFF is out of range", registry.isForwardReqid(0xFFFF))
    }

    @Test
    fun `late DATA after session close is discarded`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val sender = FakeFrameSender()

        val deferred = openAsync(registry, "example.com", 80, sender); runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000)); runCurrent()
        val session = deferred.await().session!!

        registry.handleFrame(Frame.Close(0x8000)); runCurrent()

        registry.handleFrame(Frame.Data(0x8000, byteArrayOf(0x42))); runCurrent()
        assertNull("Late DATA should be discarded",
            session.inboundData.tryReceive().getOrNull())
    }

    @Test
    fun `CONNECT_OK for unknown reqid is ignored`() = runTest {
        val registry = ForwardSessionRegistry(this)
        registry.handleFrame(Frame.ConnectOk(0x9999))
    }

    @Test
    fun `CLOSE for unknown reqid is ignored`() = runTest {
        val registry = ForwardSessionRegistry(this)
        registry.handleFrame(Frame.Close(0x9999))
    }
}
