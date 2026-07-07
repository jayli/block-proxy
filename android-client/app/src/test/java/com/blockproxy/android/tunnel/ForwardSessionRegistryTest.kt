package com.blockproxy.android.tunnel

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ClosedReceiveChannelException
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList

@OptIn(ExperimentalCoroutinesApi::class)
class ForwardSessionRegistryTest {

    // -- Fake tunnel socket --

    class FakeTunnelSocket : TunnelSocket {
        var closed = false
        val writtenBytes = CopyOnWriteArrayList<ByteArray>()
        private val incomingData = Channel<ByteArray>(Channel.UNLIMITED)

        override suspend fun connect(host: String, port: Int, timeoutMs: Long) {}

        override suspend fun read(buffer: ByteArray): Int {
            return try {
                val data = incomingData.receive()
                if (data.isEmpty()) return -1
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

        fun enqueueIncomingData(data: ByteArray) {
            incomingData.trySend(data.copyOf())
        }
    }

    /** Result wrapper for open() that captures exceptions. */
    private data class OpenResult(val session: ForwardSession?, val error: Throwable?)

    // -- Helpers --

    private fun createConnection(
        socket: FakeTunnelSocket = FakeTunnelSocket(),
    ): Pair<TunnelConnection, FakeTunnelSocket> {
        val conn = TunnelConnection(
            id = "test-conn-${System.identityHashCode(socket)}",
            socket = socket,
            username = "user",
            password = "pass",
            scope = kotlinx.coroutines.CoroutineScope(
                kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Unconfined
            ),
            onFrame = {},
            onDisconnect = {},
        )
        return conn to socket
    }

    private fun decodeSentFrames(socket: FakeTunnelSocket): List<Frame> {
        return socket.writtenBytes.map { FrameCodec.decode(it) }
    }

    /**
     * Launches registry.open() in a separate coroutine scope and returns a CompletableDeferred
     * that captures both success and failure as [OpenResult].  This avoids
     * exception propagation to the test framework.
     */
    private fun openAsync(
        registry: ForwardSessionRegistry,
        host: String,
        port: Int,
        connections: List<TunnelConnection>,
    ): CompletableDeferred<OpenResult> {
        val deferred = CompletableDeferred<OpenResult>()
        val scope = kotlinx.coroutines.CoroutineScope(
            kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Unconfined
        )
        scope.launch {
            try {
                val session = registry.open(host, port, connections)
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
        val (conn, socket) = createConnection()
        val connections = listOf(conn)

        val deferred = openAsync(registry, "example.com", 80, connections)
        runCurrent()

        // Verify CONNECT was sent with reqid 0x8000
        val frames = decodeSentFrames(socket)
        val connects = frames.filterIsInstance<Frame.Connect>()
        assertEquals("Should have sent one CONNECT", 1, connects.size)
        assertEquals("First forward reqid should be 0x8000", 0x8000, connects[0].reqid)

        // Complete the open
        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()

        val result = deferred.await()
        assertNotNull(result.session)
        assertEquals(0x8000, result.session!!.reqid)
        assertEquals("example.com", result.session!!.host)
        assertEquals(80, result.session!!.port)

        conn.close()
    }

    @Test
    fun `reqid increments sequentially`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val (conn, _) = createConnection()
        val connections = listOf(conn)

        // Open first session
        val d1 = openAsync(registry, "a.com", 80, connections)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()
        val s1 = d1.await().session!!
        assertEquals(0x8000, s1.reqid)

        // Open second session
        val d2 = openAsync(registry, "b.com", 80, connections)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8001))
        runCurrent()
        val s2 = d2.await().session!!
        assertEquals(0x8001, s2.reqid)

        conn.close()
    }

    @Test
    fun `reqid wraps after max back to min`() = runTest {
        // Use a small range: 0x8000..0x8001 (2 reqids)
        val registry = ForwardSessionRegistry(
            this, reqidMin = 0x8000, reqidMax = 0x8001,
        )
        val (conn, socket) = createConnection()
        val connections = listOf(conn)

        // Open both sessions
        val d1 = openAsync(registry, "a.com", 80, connections)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()
        val s1 = d1.await().session!!

        val d2 = openAsync(registry, "b.com", 80, connections)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8001))
        runCurrent()
        d2.await()

        // Close the first session to free 0x8000
        s1.close()
        runCurrent()

        // Next allocation should wrap from 0x8002 -> 0x8000
        val d3 = openAsync(registry, "c.com", 80, connections)
        runCurrent()

        val frames = decodeSentFrames(socket)
        val connects = frames.filterIsInstance<Frame.Connect>()
        assertEquals(3, connects.size)
        assertEquals("Third CONNECT should wrap to 0x8000", 0x8000, connects[2].reqid)

        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()
        d3.await()

        conn.close()
    }

    @Test
    fun `wrap skips active reqids`() = runTest {
        // Range: 0x8000..0x8002 (3 reqids)
        val registry = ForwardSessionRegistry(
            this, reqidMin = 0x8000, reqidMax = 0x8002,
        )
        val (conn, socket) = createConnection()
        val connections = listOf(conn)

        // Fill all 3 slots
        val d1 = openAsync(registry, "a.com", 80, connections)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()
        d1.await()

        val d2 = openAsync(registry, "b.com", 80, connections)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8001))
        runCurrent()
        val s2 = d2.await().session!!

        val d3 = openAsync(registry, "c.com", 80, connections)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8002))
        runCurrent()
        d3.await()

        // Free slot 0x8001 only
        s2.close()
        runCurrent()

        // Next allocation wraps: 0x8003->0x8000 (active), 0x8001 (free!)
        val d4 = openAsync(registry, "d.com", 80, connections)
        runCurrent()

        val frames = decodeSentFrames(socket)
        val connects = frames.filterIsInstance<Frame.Connect>()
        assertEquals(4, connects.size)
        assertEquals("Should skip active 0x8000 and find free 0x8001",
            0x8001, connects[3].reqid)

        registry.handleFrame(Frame.ConnectOk(0x8001))
        runCurrent()
        d4.await()

        conn.close()
    }

    @Test
    fun `open sends CONNECT on selected connection`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val (conn, socket) = createConnection()
        val connections = listOf(conn)

        val deferred = openAsync(registry, "example.com", 443, connections)
        runCurrent()

        val frames = decodeSentFrames(socket)
        val connects = frames.filterIsInstance<Frame.Connect>()
        assertEquals(1, connects.size)
        val connect = connects[0]
        assertEquals(0x8000, connect.reqid)
        assertTrue("Address should be Domain", connect.address is FrameAddress.Domain)
        assertEquals("example.com", (connect.address as FrameAddress.Domain).domain)
        assertEquals(443, connect.port)

        // Complete
        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()
        deferred.await()

        conn.close()
    }

    @Test
    fun `open sends IPv4 address for IP host`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val (conn, socket) = createConnection()

        val deferred = openAsync(registry, "1.2.3.4", 80, listOf(conn))
        runCurrent()

        val frames = decodeSentFrames(socket)
        val connect = frames.filterIsInstance<Frame.Connect>().first()
        assertTrue("Address should be IPv4", connect.address is FrameAddress.IPv4)
        assertEquals("1.2.3.4", (connect.address as FrameAddress.IPv4).address)

        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()
        deferred.await()

        conn.close()
    }

    @Test
    fun `CONNECT_OK completes open`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val (conn, _) = createConnection()

        val deferred = openAsync(registry, "example.com", 80, listOf(conn))
        runCurrent()

        assertFalse("open should not be completed yet", deferred.isCompleted)

        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()

        assertTrue("open should be completed", deferred.isCompleted)
        assertNotNull(deferred.await().session)

        conn.close()
    }

    @Test
    fun `CONNECT_FAILED fails open with IOException`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val (conn, _) = createConnection()

        val deferred = openAsync(registry, "example.com", 80, listOf(conn))
        runCurrent()

        registry.handleFrame(Frame.ConnectFailed(0x8000))
        runCurrent()

        val result = deferred.await()
        assertNull("Session should be null on failure", result.session)
        assertNotNull("Error should be present", result.error)
        assertTrue("Error should be IOException", result.error is IOException)
        assertTrue("Message should mention failure",
            result.error!!.message?.contains("failed", ignoreCase = true) == true ||
            result.error!!.message?.contains("CONNECT", ignoreCase = true) == true)

        conn.close()
    }

    @Test
    fun `inbound DATA is queued for the right session`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val (conn, _) = createConnection()
        val connections = listOf(conn)

        // Open two sessions
        val d1 = openAsync(registry, "a.com", 80, connections)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()
        val s1 = d1.await().session!!

        val d2 = openAsync(registry, "b.com", 80, connections)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8001))
        runCurrent()
        val s2 = d2.await().session!!

        // Send DATA to session 1
        registry.handleFrame(Frame.Data(0x8000, byteArrayOf(0x01, 0x02)))
        // Send DATA to session 2
        registry.handleFrame(Frame.Data(0x8001, byteArrayOf(0x03, 0x04)))
        runCurrent()

        // Verify session 1 got its data
        val data1 = s1.inboundData.tryReceive().getOrNull()
        assertNotNull("Session 1 should have data", data1)
        assertArrayEquals(byteArrayOf(0x01, 0x02), data1)

        // Verify session 2 got its data
        val data2 = s2.inboundData.tryReceive().getOrNull()
        assertNotNull("Session 2 should have data", data2)
        assertArrayEquals(byteArrayOf(0x03, 0x04), data2)

        // No cross-contamination
        assertNull("Session 1 should have no more data", s1.inboundData.tryReceive().getOrNull())
        assertNull("Session 2 should have no more data", s2.inboundData.tryReceive().getOrNull())

        conn.close()
    }

    @Test
    fun `inbound CLOSE ends the right session`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val (conn, _) = createConnection()
        val connections = listOf(conn)

        // Open two sessions
        val d1 = openAsync(registry, "a.com", 80, connections)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()
        val s1 = d1.await().session!!

        val d2 = openAsync(registry, "b.com", 80, connections)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8001))
        runCurrent()
        val s2 = d2.await().session!!

        // Close session 1
        registry.handleFrame(Frame.Close(0x8000))
        runCurrent()

        assertTrue("Session 1 should be closed", s1.isClosed)
        assertFalse("Session 2 should still be open", s2.isClosed)

        // DATA for session 1 should be discarded
        registry.handleFrame(Frame.Data(0x8000, byteArrayOf(0x42)))
        runCurrent()
        assertNull("Closed session should not receive data",
            s1.inboundData.tryReceive().getOrNull())

        conn.close()
    }

    @Test
    fun `disconnect of one connection cleans only sessions bound to that connection`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val (connA, _) = createConnection()
        val (connB, _) = createConnection()

        // Open session on connA
        val d1 = openAsync(registry, "a.com", 80, listOf(connA))
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()
        val s1 = d1.await().session!!

        // Open session on connB
        val d2 = openAsync(registry, "b.com", 80, listOf(connB))
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8001))
        runCurrent()
        val s2 = d2.await().session!!

        // Disconnect connA
        registry.closeSessionsFor(connA)
        runCurrent()

        assertTrue("Session on connA should be closed", s1.isClosed)
        assertFalse("Session on connB should still be open", s2.isClosed)

        connA.close()
        connB.close()
    }

    @Test
    fun `disconnect fails pending open on that connection`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val (conn, _) = createConnection()
        val connections = listOf(conn)

        val deferred = openAsync(registry, "example.com", 80, connections)
        runCurrent()

        // Disconnect the connection before CONNECT_OK arrives
        registry.closeSessionsFor(conn)
        runCurrent()

        val result = deferred.await()
        assertNull("Session should be null", result.session)
        assertNotNull("Error should be present", result.error)
        assertTrue("Error should be IOException", result.error is IOException)

        conn.close()
    }

    @Test
    fun `stop closes all sessions`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val (conn, _) = createConnection()
        val connections = listOf(conn)

        // Open two sessions
        val d1 = openAsync(registry, "a.com", 80, connections)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()
        val s1 = d1.await().session!!

        val d2 = openAsync(registry, "b.com", 80, connections)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8001))
        runCurrent()
        val s2 = d2.await().session!!

        // Stop the registry
        registry.stop()
        runCurrent()

        assertTrue("Session 1 should be closed", s1.isClosed)
        assertTrue("Session 2 should be closed", s2.isClosed)

        conn.close()
    }

    @Test
    fun `stop fails pending open`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val (conn, _) = createConnection()

        val deferred = openAsync(registry, "example.com", 80, listOf(conn))
        runCurrent()

        registry.stop()
        runCurrent()

        val result = deferred.await()
        assertNull("Session should be null", result.session)
        assertNotNull("Error should be present", result.error)
        assertTrue("Error should be IOException", result.error is IOException)

        conn.close()
    }

    @Test
    fun `connect timeout fails open`() = runTest {
        val registry = ForwardSessionRegistry(this, connectTimeoutMs = 5_000L)
        val (conn, _) = createConnection()

        val deferred = openAsync(registry, "example.com", 80, listOf(conn))
        runCurrent()

        assertFalse("Should not be completed yet", deferred.isCompleted)

        // Advance past the timeout
        advanceTimeBy(5_001)
        runCurrent()

        val result = deferred.await()
        assertNull("Session should be null on timeout", result.session)
        assertNotNull("Error should be present", result.error)
        assertTrue("Error should be IOException", result.error is IOException)
        assertTrue("Message should mention timeout",
            result.error!!.message?.contains("timed out", ignoreCase = true) == true ||
            result.error!!.message?.contains("timeout", ignoreCase = true) == true)

        conn.close()
    }

    @Test
    fun `round-robin connection selection alternates connections`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val (connA, socketA) = createConnection()
        val (connB, socketB) = createConnection()
        val connections = listOf(connA, connB)

        // Open first session -> should use connA (index 0)
        val d1 = openAsync(registry, "a.com", 80, connections)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()
        d1.await()

        // Open second session -> should use connB (index 1)
        val d2 = openAsync(registry, "b.com", 80, connections)
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8001))
        runCurrent()
        d2.await()

        // Verify CONNECT was sent on the right connections
        val framesA = decodeSentFrames(socketA)
        val framesB = decodeSentFrames(socketB)

        val connectsA = framesA.filterIsInstance<Frame.Connect>()
        val connectsB = framesB.filterIsInstance<Frame.Connect>()

        assertEquals("connA should have 1 CONNECT", 1, connectsA.size)
        assertEquals("connB should have 1 CONNECT", 1, connectsB.size)
        assertEquals(0x8000, connectsA[0].reqid)
        assertEquals(0x8001, connectsB[0].reqid)

        connA.close()
        connB.close()
    }

    @Test
    fun `open with no connections throws IOException`() = runTest {
        val registry = ForwardSessionRegistry(this)

        try {
            registry.open("example.com", 80, emptyList())
            fail("Expected IOException")
        } catch (e: IOException) {
            assertTrue(e.message?.contains("connection", ignoreCase = true) == true)
        }
    }

    @Test
    fun `session sendData sends DATA frame via connection`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val (conn, socket) = createConnection()

        val deferred = openAsync(registry, "example.com", 80, listOf(conn))
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()
        val session = deferred.await().session!!

        // Send data through the session
        session.sendData(byteArrayOf(0x01, 0x02, 0x03))
        runCurrent()

        val frames = decodeSentFrames(socket)
        val dataFrames = frames.filterIsInstance<Frame.Data>()
        assertEquals("Should have sent one DATA frame", 1, dataFrames.size)
        assertEquals(0x8000, dataFrames[0].reqid)
        assertArrayEquals(byteArrayOf(0x01, 0x02, 0x03), dataFrames[0].payload)

        conn.close()
    }

    @Test
    fun `session sendClose sends CLOSE frame via connection`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val (conn, socket) = createConnection()

        val deferred = openAsync(registry, "example.com", 80, listOf(conn))
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()
        val session = deferred.await().session!!

        // Close the session
        session.sendClose()
        runCurrent()

        val frames = decodeSentFrames(socket)
        val closeFrames = frames.filterIsInstance<Frame.Close>()
        assertEquals("Should have sent one CLOSE frame", 1, closeFrames.size)
        assertEquals(0x8000, closeFrames[0].reqid)
        assertTrue("Session should be closed", session.isClosed)

        conn.close()
    }

    @Test
    fun `hasSession returns true for active forward sessions`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val (conn, _) = createConnection()

        assertFalse(registry.hasSession(0x8000))

        val deferred = openAsync(registry, "example.com", 80, listOf(conn))
        runCurrent()

        assertTrue("Should have session while waiting for CONNECT_OK",
            registry.hasSession(0x8000))

        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()
        val session = deferred.await().session!!

        assertTrue("Should have session after open", registry.hasSession(0x8000))

        session.close()
        runCurrent()

        assertFalse("Should not have session after close", registry.hasSession(0x8000))

        conn.close()
    }

    @Test
    fun `isForwardReqid correctly identifies forward range`() = runTest {
        val registry = ForwardSessionRegistry(this)

        assertFalse("0x0001 is reverse", registry.isForwardReqid(0x0001))
        assertFalse("0x7FFF is reverse", registry.isForwardReqid(0x7FFF))
        assertTrue("0x8000 is forward", registry.isForwardReqid(0x8000))
        assertTrue("0xFFFE is forward", registry.isForwardReqid(0xFFFE))
        assertFalse("0xFFFF is out of range", registry.isForwardReqid(0xFFFF))
        assertFalse("0x0000 is out of range", registry.isForwardReqid(0x0000))
    }

    @Test
    fun `late DATA after session close is discarded`() = runTest {
        val registry = ForwardSessionRegistry(this)
        val (conn, _) = createConnection()

        val deferred = openAsync(registry, "example.com", 80, listOf(conn))
        runCurrent()
        registry.handleFrame(Frame.ConnectOk(0x8000))
        runCurrent()
        val session = deferred.await().session!!

        // Close the session via remote CLOSE
        registry.handleFrame(Frame.Close(0x8000))
        runCurrent()

        // Late DATA should be discarded
        registry.handleFrame(Frame.Data(0x8000, byteArrayOf(0x42)))
        runCurrent()

        assertNull("Late DATA should be discarded",
            session.inboundData.tryReceive().getOrNull())

        conn.close()
    }

    @Test
    fun `CONNECT_OK for unknown reqid is ignored`() = runTest {
        val registry = ForwardSessionRegistry(this)
        // Should not throw
        registry.handleFrame(Frame.ConnectOk(0x9999))
    }

    @Test
    fun `CLOSE for unknown reqid is ignored`() = runTest {
        val registry = ForwardSessionRegistry(this)
        // Should not throw
        registry.handleFrame(Frame.Close(0x9999))
    }
}
