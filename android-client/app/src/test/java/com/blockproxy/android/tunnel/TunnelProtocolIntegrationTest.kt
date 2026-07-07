package com.blockproxy.android.tunnel

import com.blockproxy.android.config.ServerConfig
import com.blockproxy.android.config.TunnelCredentials
import com.blockproxy.android.status.TunnelStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * End-to-end integration test for the tunnel protocol.
 *
 * Uses a fake tunnel server (plain TCP [ServerSocket]) and a fake target
 * server to exercise the real [TunnelClient] with production socket
 * implementations ([RealTunnelSocket] without TLS, [RealTargetSocket]).
 *
 * The fake servers do NOT use TLS; the client is configured with
 * `useTls = false` so that [RealTunnelSocket] creates plain TCP sockets.
 *
 * Uses [runBlocking] with real dispatchers because the production socket
 * implementations rely on `Dispatchers.IO` for blocking socket operations,
 * which require real threads and real wall-clock time.
 *
 * Each test must complete within 30 seconds (JUnit timeout).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class TunnelProtocolIntegrationTest {

    companion object {
        private const val TEST_USERNAME = "testuser"
        private const val TEST_PASSWORD = "testpass"
        private const val READ_TIMEOUT_MS = 10_000
    }

    // ── Tests ───────────────────────────────────────────────────────

    /**
     * Complete lifecycle: AUTH → PING/PONG → CONNECT → CONNECT_OK →
     * bidirectional DATA relay → CLOSE → session cleanup.
     */
    @Test(timeout = 30_000)
    fun fullLifecycle_auth_ping_connect_data_close() {
        val serverSocket = ServerSocket(0, 2)
        val serverPort = serverSocket.localPort

        // Target server (fake echo)
        val targetServerSocket = ServerSocket(0)
        val targetPort = targetServerSocket.localPort
        val targetReceived = mutableListOf<Byte>()
        val targetDataReady = CountDownLatch(1)
        val targetHandlerDone = CountDownLatch(1)

        val targetHandlerThread = Thread({
            try {
                val target = targetServerSocket.accept()
                target.soTimeout = READ_TIMEOUT_MS
                val tIn = target.getInputStream()
                val tOut = target.getOutputStream()

                // Read DATA from the relay and echo it back
                val buf = ByteArray(1024)
                val n = tIn.read(buf)
                if (n > 0) {
                    targetReceived.addAll(buf.slice(0 until n).toList())
                    targetDataReady.countDown()
                    tOut.write(buf, 0, n)
                    tOut.flush()
                }

                // Wait for the relay to close the target socket
                try { while (tIn.read(buf) != -1) {} } catch (_: Exception) {}
                target.close()
            } catch (_: Exception) {
                // Server socket closed during cleanup
            } finally {
                targetDataReady.countDown()
                targetHandlerDone.countDown()
            }
        }, "target-handler").apply { isDaemon = true; start() }

        // Background thread: accept the second (replenishment) connection
        val secondConnReady = CountDownLatch(1)
        val secondConnThread = Thread({
            try {
                val conn2 = serverSocket.accept()
                conn2.soTimeout = READ_TIMEOUT_MS
                handleAuthOk(conn2.getInputStream(), conn2.getOutputStream())
                secondConnReady.countDown()
                // Keep the connection alive until the server socket is closed
                try { conn2.getInputStream().read() } catch (_: Exception) {}
                conn2.close()
            } catch (_: Exception) {
                secondConnReady.countDown()
            }
        }, "second-conn-handler").apply { isDaemon = true; start() }

        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val config = ServerConfig(
            serverHost = "127.0.0.1",
            serverPort = serverPort,
            useTls = false,
            allowInsecure = true,
        )
        val client = createClient(config, scope)

        try {
            client.start()

            // ── Accept the first (main) tunnel connection ───────────
            val conn = serverSocket.accept()
            conn.soTimeout = READ_TIMEOUT_MS
            val sIn = conn.getInputStream()
            val sOut = conn.getOutputStream()

            // 1. AUTH
            val authFrame = readFrame(sIn)
            assertTrue("Expected Auth frame, got ${authFrame::class.simpleName}", authFrame is Frame.Auth)
            val auth = authFrame as Frame.Auth
            assertEquals(TEST_USERNAME, auth.username)
            assertEquals(TEST_PASSWORD, auth.password)
            writeFrame(sOut, Frame.AuthOk)

            // Wait for the second connection to be accepted and authenticated
            // before sending PING, to avoid the client replying PONG on the
            // wrong connection.
            assertTrue("Second connection not accepted in time",
                secondConnReady.await(10, TimeUnit.SECONDS))

            // 2. PING → PONG
            writeFrame(sOut, Frame.Ping)
            val pongFrame = readFrame(sIn)
            assertTrue("Expected Pong frame, got ${pongFrame::class.simpleName}", pongFrame is Frame.Pong)

            // 3. CONNECT to the fake target
            val reqid = 1
            writeFrame(sOut, Frame.Connect(reqid, FrameAddress.IPv4("127.0.0.1"), targetPort))

            // 4. Expect CONNECT_OK (client connects to the target and sends it)
            val connectOkFrame = readFrame(sIn)
            assertTrue(
                "Expected ConnectOk frame, got ${connectOkFrame::class.simpleName}",
                connectOkFrame is Frame.ConnectOk,
            )
            assertEquals(reqid, (connectOkFrame as Frame.ConnectOk).reqid)

            // Give the relay loop a moment to start
            Thread.sleep(300)

            // 5. Send DATA through the tunnel → should arrive at the target
            val testData = "Hello from tunnel server!".toByteArray()
            writeFrame(sOut, Frame.Data(reqid, testData))

            // Wait for the target to receive and echo the data
            assertTrue("Target did not receive data in time",
                targetDataReady.await(10, TimeUnit.SECONDS))
            assertArrayEquals("Target received wrong data", testData, targetReceived.toByteArray())

            // 6. The target echoed the data back → relay sends DATA to the server
            val echoFrame = readFrame(sIn)
            assertTrue("Expected Data frame from relay, got ${echoFrame::class.simpleName}",
                echoFrame is Frame.Data)
            val echo = echoFrame as Frame.Data
            assertEquals(reqid, echo.reqid)
            assertArrayEquals("Echoed data mismatch", testData, echo.payload)

            // 7. Send CLOSE → session cleanup
            writeFrame(sOut, Frame.Close(reqid))
            Thread.sleep(500)

            // 8. Stop the client
            runBlocking { client.stop() }
            waitForStatus(client.status, TunnelStatus.Disconnected, 5_000)

            // Verify target handler finished (socket was closed by the client)
            assertTrue("Target handler did not finish",
                targetHandlerDone.await(5, TimeUnit.SECONDS))
        } finally {
            runBlocking { try { client.stop() } catch (_: Exception) {} }
            scope.cancel()
            try { serverSocket.close() } catch (_: Exception) {}
            try { targetServerSocket.close() } catch (_: Exception) {}
            secondConnThread.join(3_000)
            targetHandlerThread.join(3_000)
        }
    }

    /**
     * Two tunnel connections are established and both complete authentication
     * and PING/PONG exchange.
     */
    @Test(timeout = 30_000)
    fun dualConnection_bothConnectionsEstablished() {
        val serverSocket = ServerSocket(0, 2)
        val serverPort = serverSocket.localPort

        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val config = ServerConfig(
            serverHost = "127.0.0.1",
            serverPort = serverPort,
            useTls = false,
            allowInsecure = true,
        )
        val client = createClient(config, scope)

        val conn1Ready = CountDownLatch(1)
        val conn2Ready = CountDownLatch(1)

        // Background thread: accept and handle one of the two connections
        val backgroundThread = Thread({
            try {
                val conn = serverSocket.accept()
                conn.soTimeout = READ_TIMEOUT_MS
                val cIn = conn.getInputStream()
                val cOut = conn.getOutputStream()

                handleAuthOk(cIn, cOut)
                conn1Ready.countDown()

                writeFrame(cOut, Frame.Ping)
                val pong = readFrame(cIn)
                assertTrue("Background conn: expected Pong, got ${pong::class.simpleName}",
                    pong is Frame.Pong)

                // Keep alive until cleanup
                try { while (cIn.read() != -1) {} } catch (_: Exception) {}
                conn.close()
            } catch (_: Exception) {
                conn1Ready.countDown()
            }
        }, "dual-conn-background").apply { isDaemon = true; start() }

        try {
            client.start()

            // Accept the other connection on the main test thread
            val conn2 = serverSocket.accept()
            conn2.soTimeout = READ_TIMEOUT_MS
            val s2In = conn2.getInputStream()
            val s2Out = conn2.getOutputStream()

            handleAuthOk(s2In, s2Out)
            conn2Ready.countDown()

            // Wait for the background thread to finish PING/PONG
            assertTrue("Background connection not ready in time",
                conn1Ready.await(10, TimeUnit.SECONDS))

            // Also do PING/PONG on the main-thread connection
            writeFrame(s2Out, Frame.Ping)
            val pong2 = readFrame(s2In)
            assertTrue("Main conn: expected Pong, got ${pong2::class.simpleName}",
                pong2 is Frame.Pong)

            // Both connections should be alive
            waitForStatus(client.status, TunnelStatus.Connected, 5_000)

            runBlocking { client.stop() }
            waitForStatus(client.status, TunnelStatus.Disconnected, 5_000)
        } finally {
            runBlocking { try { client.stop() } catch (_: Exception) {} }
            scope.cancel()
            try { serverSocket.close() } catch (_: Exception) {}
            backgroundThread.join(3_000)
        }
    }

    /**
     * Server responds with ERROR during auth → client transitions to Occupied
     * and stops retrying.
     */
    @Test(timeout = 30_000)
    fun authError_clientStopsWithOccupiedStatus() {
        val serverSocket = ServerSocket(0)
        val serverPort = serverSocket.localPort

        val serverThread = Thread({
            try {
                val conn = serverSocket.accept()
                conn.soTimeout = READ_TIMEOUT_MS
                val sIn = conn.getInputStream()
                val sOut = conn.getOutputStream()

                // Read the AUTH frame
                val authFrame = readFrame(sIn)
                assertTrue("Expected Auth frame", authFrame is Frame.Auth)

                // Send ERROR (slot occupied)
                writeFrame(sOut, Frame.Error("slot occupied"))
                Thread.sleep(200)
                conn.close()
            } catch (_: Exception) {
                // Server socket closed during cleanup
            }
        }, "auth-error-server").apply { isDaemon = true; start() }

        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val config = ServerConfig(
            serverHost = "127.0.0.1",
            serverPort = serverPort,
            useTls = false,
            allowInsecure = true,
        )
        val client = createClient(config, scope)

        try {
            client.start()

            waitForStatus(client.status, TunnelStatus.Occupied, 10_000)
            assertEquals(TunnelStatus.Occupied, client.status.value)

            // Verify client doesn't retry after permanent occupied error
            Thread.sleep(3_000)
            assertEquals(TunnelStatus.Occupied, client.status.value)

            runBlocking { client.stop() }
            waitForStatus(client.status, TunnelStatus.Disconnected, 5_000)
        } finally {
            runBlocking { try { client.stop() } catch (_: Exception) {} }
            scope.cancel()
            try { serverSocket.close() } catch (_: Exception) {}
            serverThread.join(3_000)
        }
    }

    /**
     * Server responds with AUTH_FAIL → client transitions to AuthFailed
     * and stops retrying.
     */
    @Test(timeout = 30_000)
    fun authFail_clientStopsWithAuthFailedStatus() {
        val serverSocket = ServerSocket(0)
        val serverPort = serverSocket.localPort

        val serverThread = Thread({
            try {
                val conn = serverSocket.accept()
                conn.soTimeout = READ_TIMEOUT_MS
                val sIn = conn.getInputStream()
                val sOut = conn.getOutputStream()

                // Read the AUTH frame (verify it is well-formed)
                val authFrame = readFrame(sIn)
                assertTrue("Expected Auth frame", authFrame is Frame.Auth)

                // Reject authentication
                writeFrame(sOut, Frame.AuthFail)
                Thread.sleep(200) // Let client process AUTH_FAIL
                conn.close()
            } catch (_: Exception) {
                // Server socket closed during cleanup
            }
        }, "auth-fail-server").apply { isDaemon = true; start() }

        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val config = ServerConfig(
            serverHost = "127.0.0.1",
            serverPort = serverPort,
            useTls = false,
            allowInsecure = true,
        )
        val credentials = TunnelCredentials("wrong_user", "wrong_pass")
        val client = createClient(config, scope, credentials)

        try {
            client.start()

            waitForStatus(client.status, TunnelStatus.AuthFailed, 10_000)
            assertEquals(TunnelStatus.AuthFailed, client.status.value)

            runBlocking { client.stop() }
            waitForStatus(client.status, TunnelStatus.Disconnected, 5_000)
        } finally {
            runBlocking { try { client.stop() } catch (_: Exception) {} }
            scope.cancel()
            try { serverSocket.close() } catch (_: Exception) {}
            serverThread.join(3_000)
        }
    }

    // ── Socket factories ────────────────────────────────────────────

    /**
     * Creates plain-TCP [RealTunnelSocket] instances (no TLS) that connect
     * to the fake tunnel server on localhost.
     */
    class PlainTunnelSocketFactory : TunnelSocketFactory {
        override fun create(): TunnelSocket = RealTunnelSocket(
            useTls = false,
            allowInsecure = true,
        )
    }

    /**
     * Creates plain-TCP [RealTargetSocket] instances for the fake target server.
     */
    class PlainTargetSocketFactory : TargetSocketFactory {
        override fun create(): TunnelSocket = RealTargetSocket()
    }

    // ── Helpers ─────────────────────────────────────────────────────

    private fun createClient(
        config: ServerConfig,
        scope: CoroutineScope,
        credentials: TunnelCredentials = TunnelCredentials(TEST_USERNAME, TEST_PASSWORD),
    ): TunnelClient {
        return TunnelClient(
            config = config,
            credentials = credentials,
            socketFactory = PlainTunnelSocketFactory(),
            targetSocketFactory = PlainTargetSocketFactory(),
            clientScope = scope,
            idleTimeoutMs = Long.MAX_VALUE, // Prevent idle timeout during tests
        )
    }

    /**
     * Polls [statusFlow] until the expected value appears or [timeoutMs] elapses.
     * Fails the test on timeout.
     */
    private fun waitForStatus(
        statusFlow: StateFlow<TunnelStatus>,
        expected: TunnelStatus,
        timeoutMs: Long,
    ) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (statusFlow.value == expected) return
            Thread.sleep(50)
        }
        fail(
            "Expected status $expected but was ${statusFlow.value} " +
            "after ${timeoutMs}ms"
        )
    }

    // ── Fake server helpers ─────────────────────────────────────────

    /**
     * Reads a single length-prefixed frame from [input] and decodes it.
     *
     * Frame format: [2-byte big-endian length][payload ...]
     */
    private fun readFrame(input: InputStream): Frame {
        val lenHi = input.read()
        if (lenHi == -1) throw AssertionError("Server: unexpected EOF reading frame length (high byte)")
        val lenLo = input.read()
        if (lenLo == -1) throw AssertionError("Server: unexpected EOF reading frame length (low byte)")

        val length = (lenHi shl 8) or lenLo
        val frameBytes = ByteArray(2 + length)
        frameBytes[0] = lenHi.toByte()
        frameBytes[1] = lenLo.toByte()

        var offset = 0
        while (offset < length) {
            val n = input.read(frameBytes, 2 + offset, length - offset)
            if (n == -1) throw AssertionError("Server: unexpected EOF reading frame payload at offset $offset")
            offset += n
        }

        return FrameCodec.decode(frameBytes)
    }

    /** Encodes [frame] with [FrameCodec] and writes the bytes to [output]. */
    private fun writeFrame(output: OutputStream, frame: Frame) {
        val bytes = FrameCodec.encode(frame)
        output.write(bytes)
        output.flush()
    }

    /**
     * Reads an AUTH frame from [input], verifies the credentials, and
     * sends AUTH_OK to [output].  Fails the test if the AUTH frame is
     * malformed or carries unexpected credentials.
     */
    private fun handleAuthOk(input: InputStream, output: OutputStream) {
        val authFrame = readFrame(input)
        assertTrue("Expected Auth frame, got ${authFrame::class.simpleName}", authFrame is Frame.Auth)
        val auth = authFrame as Frame.Auth
        assertEquals("Username mismatch", TEST_USERNAME, auth.username)
        assertEquals("Password mismatch", TEST_PASSWORD, auth.password)
        writeFrame(output, Frame.AuthOk)
    }
}
