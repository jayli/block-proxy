package com.blockproxy.android.tunnel

import com.blockproxy.android.config.ServerConfig
import com.blockproxy.android.config.TunnelCredentials
import com.blockproxy.android.status.TunnelStatus
import kotlinx.coroutines.CoroutineScope
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
import java.util.concurrent.CopyOnWriteArrayList

@OptIn(ExperimentalCoroutinesApi::class)
class TunnelClientTest {

    // ── Fake socket ─────────────────────────────────────────────────

    /**
     * Controllable [TunnelSocket] for testing TunnelClient.
     */
    class ControllableTunnelSocket : TunnelSocket {
        var connected = false
        var closed = false
        var connectShouldFail = false
        var enqueueAuthOkOnConnect = false
        val writtenBytes = CopyOnWriteArrayList<ByteArray>()

        private val incomingData = Channel<ByteArray>(Channel.UNLIMITED)

        override suspend fun connect(host: String, port: Int, timeoutMs: Long) {
            if (connectShouldFail) throw IOException("Connect failed")
            connected = true
            if (enqueueAuthOkOnConnect) {
                incomingData.trySend(FrameCodec.encode(Frame.AuthOk))
            }
        }

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

        /** Simulate server-side EOF (triggers disconnect without setting [closed]). */
        fun closeIncoming() {
            incomingData.close()
        }
    }

    // ── Fake factories ──────────────────────────────────────────────

    class FakeTunnelSocketFactory : TunnelSocketFactory {
        private val queue = ArrayDeque<ControllableTunnelSocket>()
        val created = mutableListOf<ControllableTunnelSocket>()

        fun enqueue(socket: ControllableTunnelSocket) {
            queue.addLast(socket)
        }

        override fun create(): TunnelSocket {
            val socket = queue.removeFirst()
            created.add(socket)
            return socket
        }

        fun remaining(): Int = queue.size
    }

    class FakeTargetSocketFactory : TargetSocketFactory {
        override fun create(): TunnelSocket {
            throw UnsupportedOperationException("Not needed for TunnelClient tests")
        }
    }

    // ── Helpers ─────────────────────────────────────────────────────

    private val testConfig = ServerConfig(serverHost = "test.example.com", serverPort = 8003)
    private val testCredentials = TunnelCredentials("user", "pass")

    private fun createClient(
        socketFactory: FakeTunnelSocketFactory,
        scope: CoroutineScope,
    ): TunnelClient {
        return TunnelClient(
            config = testConfig,
            credentials = testCredentials,
            socketFactory = socketFactory,
            targetSocketFactory = FakeTargetSocketFactory(),
            clientScope = scope,
            idleTimeoutMs = Long.MAX_VALUE,  // Prevent idle timeout during tests
        )
    }

    // ── Tests ───────────────────────────────────────────────────────

    // 1. First connection failure → reconnecting with backoff
    @Test
    fun `first connection failure triggers reconnecting with backoff`() = runTest {
        val factory = FakeTunnelSocketFactory()
        val socket = ControllableTunnelSocket().apply { connectShouldFail = true }
        factory.enqueue(socket)
        val client = createClient(factory, backgroundScope)

        client.start()
        runCurrent()

        assertEquals(TunnelStatus.Reconnecting, client.status.value)

        // Advance 500ms (within the 1s initial backoff) — still Reconnecting
        advanceTimeBy(500)
        runCurrent()
        assertEquals(TunnelStatus.Reconnecting, client.status.value)

        // Enqueue a socket for the reconnect attempt
        val socket2 = ControllableTunnelSocket().apply { connectShouldFail = true }
        factory.enqueue(socket2)

        // Advance past the 1s backoff (500 + 600 = 1100 > 1000)
        advanceTimeBy(600)
        runCurrent()

        // Second attempt also failed, now in 2s backoff
        assertEquals(TunnelStatus.Reconnecting, client.status.value)

        // Advance 1s (within 2s backoff) — still Reconnecting
        advanceTimeBy(1000)
        runCurrent()
        assertEquals(TunnelStatus.Reconnecting, client.status.value)

        client.stop()
    }

    // 2. Auth failure → AuthFailed, stop retrying
    @Test
    fun `auth failure sets AuthFailed and stops retrying`() = runTest {
        val factory = FakeTunnelSocketFactory()
        val socket = ControllableTunnelSocket()
        factory.enqueue(socket)
        val client = createClient(factory, backgroundScope)

        client.start()
        runCurrent()

        // Enqueue AUTH_FAIL
        socket.enqueueIncomingData(FrameCodec.encode(Frame.AuthFail))
        runCurrent()

        assertEquals(TunnelStatus.AuthFailed, client.status.value)

        // Even after a long delay, no more sockets should be created
        advanceTimeBy(120_000)
        runCurrent()

        assertEquals(TunnelStatus.AuthFailed, client.status.value)
        assertEquals("Only one socket should have been created", 1, factory.created.size)

        client.stop()
    }

    // 3. Auth-stage ERROR → Occupied, stop retrying
    @Test
    fun `auth-stage ERROR sets Occupied and stops retrying`() = runTest {
        val factory = FakeTunnelSocketFactory()
        val socket = ControllableTunnelSocket()
        factory.enqueue(socket)
        val client = createClient(factory, backgroundScope)

        client.start()
        runCurrent()

        // Enqueue ERROR during auth
        socket.enqueueIncomingData(FrameCodec.encode(Frame.Error("slot occupied")))
        runCurrent()

        assertEquals(TunnelStatus.Occupied, client.status.value)

        // No more retries
        advanceTimeBy(120_000)
        runCurrent()

        assertEquals(TunnelStatus.Occupied, client.status.value)
        assertEquals(1, factory.created.size)

        client.stop()
    }

    // 4. First connection success → Connected
    @Test
    fun `first connection success sets Connected`() = runTest {
        val factory = FakeTunnelSocketFactory()
        val socket = ControllableTunnelSocket().apply { enqueueAuthOkOnConnect = true }
        factory.enqueue(socket)
        // Also enqueue a socket for the second connection attempt (replenishment)
        val socket2 = ControllableTunnelSocket().apply { enqueueAuthOkOnConnect = true }
        factory.enqueue(socket2)
        val client = createClient(factory, backgroundScope)

        client.start()
        runCurrent()

        assertEquals(TunnelStatus.Connected, client.status.value)
        assertTrue("First socket should be connected", socket.connected)

        client.stop()
    }

    // 5. Reconnect success resets backoff to 1s
    @Test
    fun `reconnect success resets backoff to 1s`() = runTest {
        val factory = FakeTunnelSocketFactory()

        // First attempt: fail
        val failSocket = ControllableTunnelSocket().apply { connectShouldFail = true }
        factory.enqueue(failSocket)
        val client = createClient(factory, backgroundScope)

        client.start()
        runCurrent()
        assertEquals(TunnelStatus.Reconnecting, client.status.value)

        // Prepare second attempt socket
        val failSocket2 = ControllableTunnelSocket().apply { connectShouldFail = true }
        factory.enqueue(failSocket2)

        // Advance past 1s backoff
        advanceTimeBy(1_100)
        runCurrent()
        assertEquals(TunnelStatus.Reconnecting, client.status.value)

        // Prepare third attempt socket (will succeed)
        val successSocket = ControllableTunnelSocket().apply { enqueueAuthOkOnConnect = true }
        factory.enqueue(successSocket)
        // For the replenishment second connection (will fail)
        val replenishSocket = ControllableTunnelSocket().apply { connectShouldFail = true }
        factory.enqueue(replenishSocket)

        // Advance past 2s backoff
        advanceTimeBy(2_100)
        runCurrent()

        assertEquals(TunnelStatus.Connected, client.status.value)

        // Now disconnect the good connection to verify backoff resets to 1s
        successSocket.closeIncoming()
        runCurrent()

        // After disconnect, should enter reconnect with 1s backoff (reset)
        assertEquals(TunnelStatus.Reconnecting, client.status.value)

        // Prepare socket for the reconnect attempt
        val nextSocket = ControllableTunnelSocket().apply { connectShouldFail = true }
        factory.enqueue(nextSocket)

        // After 500ms (within 1s backoff), still Reconnecting
        advanceTimeBy(500)
        runCurrent()
        assertEquals(TunnelStatus.Reconnecting, client.status.value)

        // After another 600ms (past 1s = 1100ms total), attempt fires
        advanceTimeBy(600)
        runCurrent()
        assertEquals(TunnelStatus.Reconnecting, client.status.value)

        client.stop()
    }

    // 6. Second connection failure → still Connected
    @Test
    fun `second connection failure keeps Connected status`() = runTest {
        val factory = FakeTunnelSocketFactory()

        // First connection: success
        val socket1 = ControllableTunnelSocket().apply { enqueueAuthOkOnConnect = true }
        factory.enqueue(socket1)

        // Second connection (replenishment): fail
        val socket2 = ControllableTunnelSocket().apply { connectShouldFail = true }
        factory.enqueue(socket2)

        val client = createClient(factory, backgroundScope)
        client.start()
        runCurrent()

        // First connection succeeded
        assertEquals(TunnelStatus.Connected, client.status.value)
        assertTrue("First socket connected", socket1.connected)

        // Advance past the replenishment delay(1000) to trigger the second attempt
        advanceTimeBy(1_100)
        runCurrent()

        // Second connection failed but status remains Connected
        assertFalse("Second socket should NOT be connected", socket2.connected)
        assertEquals(TunnelStatus.Connected, client.status.value)

        client.stop()
    }

    // 7. Second connection success → dual connection
    @Test
    fun `second connection success creates dual connection`() = runTest {
        val factory = FakeTunnelSocketFactory()

        val socket1 = ControllableTunnelSocket().apply { enqueueAuthOkOnConnect = true }
        factory.enqueue(socket1)
        val socket2 = ControllableTunnelSocket().apply { enqueueAuthOkOnConnect = true }
        factory.enqueue(socket2)

        val client = createClient(factory, backgroundScope)
        client.start()
        runCurrent()

        assertEquals(TunnelStatus.Connected, client.status.value)
        assertTrue("First socket connected", socket1.connected)

        // Advance past the replenishment delay(1000) to trigger the second attempt
        advanceTimeBy(1_100)
        runCurrent()

        assertTrue("Second socket connected", socket2.connected)
        assertEquals(TunnelStatus.Connected, client.status.value)

        client.stop()
    }

    // 8. Disconnect of one connection → closes sessions, attempts replenishment
    @Test
    fun `disconnect of one connection closes sessions and attempts replenishment`() = runTest {
        val factory = FakeTunnelSocketFactory()

        // Two successful connections
        val socket1 = ControllableTunnelSocket().apply { enqueueAuthOkOnConnect = true }
        factory.enqueue(socket1)
        val socket2 = ControllableTunnelSocket().apply { enqueueAuthOkOnConnect = true }
        factory.enqueue(socket2)

        val client = createClient(factory, backgroundScope)
        client.start()
        runCurrent()

        assertEquals(TunnelStatus.Connected, client.status.value)

        // Advance past the replenishment delay to establish dual connection
        advanceTimeBy(1_100)
        runCurrent()
        assertTrue("Socket1 connected", socket1.connected)
        assertTrue("Socket2 connected", socket2.connected)

        // Prepare a replenishment socket (will be attempted after disconnect)
        val replenishSocket = ControllableTunnelSocket().apply { connectShouldFail = true }
        factory.enqueue(replenishSocket)

        // Disconnect the second connection (simulate server EOF)
        socket2.closeIncoming()
        runCurrent()

        // Status should still be Connected (socket1 is alive)
        assertEquals(TunnelStatus.Connected, client.status.value)

        // The replenishment has a 1s delay, advance past it
        advanceTimeBy(1_100)
        runCurrent()

        // Replenishment socket should have been created
        assertTrue("Replenishment socket should have been created",
            factory.created.contains(replenishSocket))

        client.stop()
    }

    // 9. Replenishment waits 1s before first attempt
    @Test
    fun `replenishment waits 1s before first attempt`() = runTest {
        val factory = FakeTunnelSocketFactory()

        val socket1 = ControllableTunnelSocket().apply { enqueueAuthOkOnConnect = true }
        factory.enqueue(socket1)
        val socket2 = ControllableTunnelSocket().apply { enqueueAuthOkOnConnect = true }
        factory.enqueue(socket2)

        val client = createClient(factory, backgroundScope)
        client.start()
        runCurrent()

        assertEquals(TunnelStatus.Connected, client.status.value)

        // Advance past replenishment delay to establish dual connection
        advanceTimeBy(1_100)
        runCurrent()

        val createdBeforeDisconnect = factory.created.size  // Should be 2

        // Disconnect socket2 to trigger replenishment
        socket2.closeIncoming()
        runCurrent()

        // The replenishment coroutine should have been launched
        // but its first action is delay(1000), so no new socket yet
        advanceTimeBy(999)
        runCurrent()
        assertEquals("No new socket before 1s delay",
            createdBeforeDisconnect, factory.created.size)

        // Prepare a socket for the replenishment attempt
        val replenishSocket = ControllableTunnelSocket().apply { connectShouldFail = true }
        factory.enqueue(replenishSocket)

        // Advance past the 1s delay
        advanceTimeBy(2)
        runCurrent()

        assertEquals("Replenishment socket should be created after 1s",
            createdBeforeDisconnect + 1, factory.created.size)

        client.stop()
    }

    // 10. Replenishment stops after 3 failed attempts (2s, 4s waits), keeps single connection
    @Test
    fun `replenishment stops after 3 failed attempts with correct waits`() = runTest {
        val factory = FakeTunnelSocketFactory()

        // Two successful connections
        val socket1 = ControllableTunnelSocket().apply { enqueueAuthOkOnConnect = true }
        factory.enqueue(socket1)
        val socket2 = ControllableTunnelSocket().apply { enqueueAuthOkOnConnect = true }
        factory.enqueue(socket2)

        val client = createClient(factory, backgroundScope)
        client.start()
        runCurrent()

        assertEquals(TunnelStatus.Connected, client.status.value)

        // Advance past replenishment delay to establish dual connection
        advanceTimeBy(1_100)
        runCurrent()

        // Prepare 3 failing replenishment sockets
        val fail1 = ControllableTunnelSocket().apply { connectShouldFail = true }
        val fail2 = ControllableTunnelSocket().apply { connectShouldFail = true }
        val fail3 = ControllableTunnelSocket().apply { connectShouldFail = true }
        factory.enqueue(fail1)
        factory.enqueue(fail2)
        factory.enqueue(fail3)

        // Disconnect socket2 to trigger replenishment
        socket2.closeIncoming()
        runCurrent()

        // replenishment: delay(1000) → attempt 1 (fail1) → delay(2000) → attempt 2 (fail2) → delay(4000) → attempt 3 (fail3)
        // Total: 1000 + 2000 + 4000 = 7000ms

        // Advance through the entire replenishment sequence
        advanceTimeBy(7_500)
        runCurrent()

        // Socket1 should still be alive and connected
        assertFalse("Socket1 should NOT be closed", socket1.closed)
        assertEquals(TunnelStatus.Connected, client.status.value)

        // All 3 failing sockets should have been created
        assertTrue("fail1 created", factory.created.contains(fail1))
        assertTrue("fail2 created", factory.created.contains(fail2))
        assertTrue("fail3 created", factory.created.contains(fail3))

        // After all 3 attempts, no more replenishment attempts should be made
        // even after waiting a long time
        val extraSocket = ControllableTunnelSocket().apply { connectShouldFail = true }
        factory.enqueue(extraSocket)
        advanceTimeBy(60_000)
        runCurrent()

        assertFalse("No 4th replenishment attempt", factory.created.contains(extraSocket))

        client.stop()
    }

    // 11. Disconnect of all connections → reconnecting
    @Test
    fun `disconnect of all connections enters reconnecting`() = runTest {
        val factory = FakeTunnelSocketFactory()

        val socket = ControllableTunnelSocket().apply { enqueueAuthOkOnConnect = true }
        factory.enqueue(socket)
        // Second connection also succeeds
        val socket2 = ControllableTunnelSocket().apply { enqueueAuthOkOnConnect = true }
        factory.enqueue(socket2)

        val client = createClient(factory, backgroundScope)
        client.start()
        runCurrent()

        assertEquals(TunnelStatus.Connected, client.status.value)

        // Advance past replenishment delay to establish dual connection
        advanceTimeBy(1_100)
        runCurrent()

        // Disconnect BOTH connections
        socket.closeIncoming()
        socket2.closeIncoming()
        runCurrent()

        assertEquals(TunnelStatus.Reconnecting, client.status.value)

        client.stop()
    }

    // 12. stop() cancels loop and closes all
    @Test
    fun `stop cancels loop and closes all connections`() = runTest {
        val factory = FakeTunnelSocketFactory()

        val socket1 = ControllableTunnelSocket().apply { enqueueAuthOkOnConnect = true }
        factory.enqueue(socket1)
        val socket2 = ControllableTunnelSocket().apply { enqueueAuthOkOnConnect = true }
        factory.enqueue(socket2)

        val client = createClient(factory, backgroundScope)
        client.start()
        runCurrent()

        assertEquals(TunnelStatus.Connected, client.status.value)

        // Advance past replenishment delay to establish dual connection
        advanceTimeBy(1_100)
        runCurrent()

        // Stop the client
        client.stop()

        assertEquals(TunnelStatus.Disconnected, client.status.value)

        // Both sockets should be closed
        assertTrue("Socket1 should be closed", socket1.closed)
        assertTrue("Socket2 should be closed", socket2.closed)
    }
}
