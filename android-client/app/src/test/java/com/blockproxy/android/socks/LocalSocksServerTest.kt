package com.blockproxy.android.socks

import com.blockproxy.android.config.RoutingConfig
import com.blockproxy.android.routing.DomainRule
import com.blockproxy.android.routing.DomainType
import com.blockproxy.android.routing.GeositeMatcher
import com.blockproxy.android.routing.RoutingEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ClosedReceiveChannelException
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@OptIn(ExperimentalCoroutinesApi::class)
class LocalSocksServerTest {

    private lateinit var scope: CoroutineScope
    private lateinit var domainMappingStore: DomainMappingStore
    private lateinit var directConnector: FakeDirectConnector
    private lateinit var forwardConnector: FakeForwardConnector

    @Before
    fun setUp() {
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        domainMappingStore = DomainMappingStore()
        directConnector = FakeDirectConnector()
        forwardConnector = FakeForwardConnector()
    }

    @After
    fun tearDown() {
        scope.cancel()
    }

    // ── Helper: RoutingEngine ──────────────────────────────────────────

    private fun alwaysDirectEngine(): RoutingEngine {
        val config = RoutingConfig(enabled = true, directRules = emptyList(), proxyRules = emptyList())
        return RoutingEngine(config, GeositeMatcher(emptyMap()))
    }

    private fun alwaysProxyEngine(): RoutingEngine {
        val config = RoutingConfig(enabled = true, proxyRules = listOf("domain:example.com"))
        return RoutingEngine(config, GeositeMatcher(emptyMap()))
    }

    private fun engineWith(directRules: List<String> = emptyList(), proxyRules: List<String> = emptyList()): RoutingEngine {
        val config = RoutingConfig(enabled = true, directRules = directRules, proxyRules = proxyRules)
        return RoutingEngine(config, GeositeMatcher(emptyMap()))
    }

    private fun engineWithGeositeCnProxy(): RoutingEngine {
        val config = RoutingConfig(enabled = true, directRules = emptyList(), proxyRules = listOf("geosite:cn"))
        val matcher = GeositeMatcher(
            mapOf("cn" to listOf(DomainRule(DomainType.DOMAIN, "weibo.cn"))),
        )
        return RoutingEngine(config, matcher)
    }

    // ── Helper: Create server ──────────────────────────────────────────

    private fun createServer(routingEngine: RoutingEngine = alwaysDirectEngine()): LocalSocksServer {
        return LocalSocksServer(
            domainMappingStore = domainMappingStore,
            routingEngine = routingEngine,
            directConnector = directConnector,
            forwardConnector = forwardConnector,
            scope = scope,
        )
    }

    /**
     * Connects to the server, performs SOCKS5 greeting, and sends CONNECT for host:port.
     * Host is sent as DOMAIN type (ATYP=0x03).
     */
    private fun socksConnect(server: LocalSocksServer, host: String, port: Int): Socket {
        val socket = Socket("127.0.0.1", server.port)
        val out = socket.getOutputStream()
        val input = socket.getInputStream()

        // Greeting
        out.write(byteArrayOf(0x05, 0x01, 0x00))
        out.flush()
        val greetingResp = ByteArray(2)
        readFully(input, greetingResp)
        assertEquals(0x05.toByte(), greetingResp[0])
        assertEquals(0x00.toByte(), greetingResp[1])

        // CONNECT request
        val domainBytes = host.toByteArray(Charsets.US_ASCII)
        val request = byteArrayOf(0x05, 0x01, 0x00, 0x03, domainBytes.size.toByte()) +
            domainBytes +
            byteArrayOf((port shr 8).toByte(), (port and 0xFF).toByte())
        out.write(request)
        out.flush()

        return socket
    }

    /**
     * Connects to the server, performs SOCKS5 greeting, and sends CONNECT
     * with an IPv4 address (ATYP=0x01).
     */
    private fun socksConnectIPv4(server: LocalSocksServer, ip: String, port: Int): Socket {
        val socket = Socket("127.0.0.1", server.port)
        val out = socket.getOutputStream()
        val input = socket.getInputStream()

        // Greeting
        out.write(byteArrayOf(0x05, 0x01, 0x00))
        out.flush()
        val greetingResp = ByteArray(2)
        readFully(input, greetingResp)
        assertEquals(0x05.toByte(), greetingResp[0])
        assertEquals(0x00.toByte(), greetingResp[1])

        // CONNECT request with IPv4 address
        val parts = ip.split(".").map { it.toInt() }
        val request = byteArrayOf(
            0x05, 0x01, 0x00, 0x01,  // VER, CMD=CONNECT, RSV, ATYP=IPv4
            parts[0].toByte(), parts[1].toByte(), parts[2].toByte(), parts[3].toByte(),
            (port shr 8).toByte(), (port and 0xFF).toByte(),
        )
        out.write(request)
        out.flush()

        return socket
    }

    private fun socksConnectIPv4ExpectEarlySuccess(server: LocalSocksServer, ip: String, port: Int): Socket {
        val socket = socksConnectIPv4(server, ip, port)
        val replyCode = readSocksResponse(socket.getInputStream())
        assertEquals(0x00.toByte(), replyCode)
        return socket
    }

    private fun readSocksResponse(input: InputStream): Byte {
        val response = ByteArray(10)
        readFully(input, response)
        assertEquals(0x05.toByte(), response[0])
        return response[1]
    }

    private fun readFully(input: InputStream, buffer: ByteArray) {
        var offset = 0
        while (offset < buffer.size) {
            val n = input.read(buffer, offset, buffer.size - offset)
            if (n < 0) throw IOException("Unexpected EOF")
            offset += n
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // Server lifecycle tests
    // ══════════════════════════════════════════════════════════════════

    @Test
    fun `server binds to loopback and exposes port`() {
        val server = createServer()
        val port = server.start()
        try {
            assertTrue("Port should be positive", port > 0)
            assertTrue("Server should be running", server.isRunning)
            assertEquals(port, server.port)
        } finally {
            server.stop()
        }
        assertFalse("Server should be stopped", server.isRunning)
    }

    @Test
    fun `server start twice throws`() {
        val server = createServer()
        server.start()
        try {
            server.start()
            fail("Expected IllegalStateException")
        } catch (e: IllegalStateException) {
            assertTrue(e.message?.contains("already started") == true)
        } finally {
            server.stop()
        }
    }

    @Test
    fun `server stop is idempotent`() {
        val server = createServer()
        server.start()
        server.stop()
        server.stop()
        assertFalse(server.isRunning)
    }

    @Test
    fun `port is negative one before start`() {
        val server = createServer()
        assertEquals(-1, server.port)
        assertFalse(server.isRunning)
    }

    // ══════════════════════════════════════════════════════════════════
    // Greeting tests
    // ══════════════════════════════════════════════════════════════════

    @Test
    fun `greeting accepts NO_AUTH method`() = runTest {
        val server = createServer()
        server.start()
        try {
            val socket = Socket("127.0.0.1", server.port)
            val out = socket.getOutputStream()
            val input = socket.getInputStream()
            out.write(byteArrayOf(0x05, 0x01, 0x00))
            out.flush()
            val response = ByteArray(2)
            readFully(input, response)
            assertEquals(0x05.toByte(), response[0])
            assertEquals(0x00.toByte(), response[1])
            socket.close()
        } finally {
            server.stop()
        }
    }

    @Test
    fun `greeting rejects when NO_AUTH not offered`() = runTest {
        val server = createServer()
        server.start()
        try {
            val socket = Socket("127.0.0.1", server.port)
            val out = socket.getOutputStream()
            val input = socket.getInputStream()
            out.write(byteArrayOf(0x05, 0x01, 0x02))
            out.flush()
            val response = ByteArray(2)
            readFully(input, response)
            assertEquals(0x05.toByte(), response[0])
            assertEquals(0xFF.toByte(), response[1])
            socket.close()
        } finally {
            server.stop()
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // CONNECT routing tests
    // ══════════════════════════════════════════════════════════════════

    @Test
    fun `CONNECT domain routes DIRECT with correct host`() = runTest {
        val server = createServer(engineWith(directRules = listOf("domain:example.com")))
        server.start()
        try {
            val socket = socksConnect(server, "example.com", 80)
            val replyCode = readSocksResponse(socket.getInputStream())
            assertEquals(0x00.toByte(), replyCode)

            withTimeout(2000) {
                while (directConnector.connectCalls.isEmpty()) delay(10)
            }
            assertEquals("example.com", directConnector.connectCalls.first().first)
            assertEquals(80, directConnector.connectCalls.first().second)
            socket.close()
        } finally {
            server.stop()
        }
    }

    @Test
    fun `CONNECT IP without mapping routes by IP DIRECT`() = runTest {
        val server = createServer(alwaysDirectEngine())
        server.start()
        try {
            val socket = socksConnectIPv4(server, "1.2.3.4", 22)
            val replyCode = readSocksResponse(socket.getInputStream())
            assertEquals(0x00.toByte(), replyCode)

            withTimeout(2000) {
                while (directConnector.connectCalls.isEmpty()) delay(10)
            }
            assertEquals("1.2.3.4", directConnector.connectCalls.first().first)
            assertEquals(22, directConnector.connectCalls.first().second)
            socket.close()
        } finally {
            server.stop()
        }
    }

    @Test
    fun `CONNECT fake IP uses mapped domain as connectHost`() = runTest {
        domainMappingStore.put("198.18.0.5", "real.example.com")
        val server = createServer(engineWith(directRules = listOf("domain:example.com")))
        server.start()
        try {
            val socket = socksConnectIPv4(server, "198.18.0.5", 443)
            val replyCode = readSocksResponse(socket.getInputStream())
            assertEquals(0x00.toByte(), replyCode)

            withTimeout(2000) {
                while (directConnector.connectCalls.isEmpty()) delay(10)
            }
            assertEquals("real.example.com", directConnector.connectCalls.first().first)
            assertEquals(443, directConnector.connectCalls.first().second)
            socket.close()
        } finally {
            server.stop()
        }
    }

    @Test
    fun `routing DIRECT uses direct connector`() = runTest {
        val server = createServer(alwaysDirectEngine())
        server.start()
        try {
            val socket = socksConnect(server, "direct.example.com", 80)
            readSocksResponse(socket.getInputStream())

            withTimeout(2000) {
                while (directConnector.connectCalls.isEmpty()) delay(10)
            }
            assertEquals(1, directConnector.connectCalls.size)
            assertEquals(0, forwardConnector.openCalls.size)
            socket.close()
        } finally {
            server.stop()
        }
    }

    @Test
    fun `routing PROXY opens forward session`() = runTest {
        val server = createServer(alwaysProxyEngine())
        server.start()
        try {
            val socket = socksConnect(server, "proxy.example.com", 443)
            readSocksResponse(socket.getInputStream())

            withTimeout(2000) {
                while (forwardConnector.openCalls.isEmpty()) delay(10)
            }
            assertEquals(1, forwardConnector.openCalls.size)
            assertEquals(0, directConnector.connectCalls.size)
            assertEquals("proxy.example.com", forwardConnector.openCalls.first().first)
            assertEquals(443, forwardConnector.openCalls.first().second)
            socket.close()
        } finally {
            server.stop()
        }
    }

    @Test
    fun `IP-only HTTP CONNECT uses sniffed Host for proxy routing and replays first bytes`() = runTest {
        val server = createServer(engineWith(proxyRules = listOf("domain:ip.cn")))
        server.start()
        try {
            val socket = socksConnectIPv4ExpectEarlySuccess(server, "1.2.3.4", 80)
            val payload = "GET / HTTP/1.1\r\nHost: ip.cn\r\n\r\n".toByteArray()
            socket.getOutputStream().write(payload)
            socket.getOutputStream().flush()

            withTimeout(2000) {
                while (forwardConnector.lastSession == null) delay(10)
            }

            assertEquals(0, directConnector.connectCalls.size)
            assertEquals("ip.cn", forwardConnector.openCalls.first().first)
            assertEquals(80, forwardConnector.openCalls.first().second)

            val session = forwardConnector.lastSession!!
            withTimeout(2000) {
                while (session.sentData.isEmpty()) delay(10)
            }
            assertArrayEquals(payload, session.sentData.first())
            socket.close()
        } finally {
            server.stop()
        }
    }

    @Test
    fun `IP-only HTTPS CONNECT uses sniffed SNI for geosite proxy routing and replays ClientHello`() = runTest {
        val server = createServer(engineWithGeositeCnProxy())
        server.start()
        try {
            val socket = socksConnectIPv4ExpectEarlySuccess(server, "1.2.3.4", 443)
            val payload = tlsClientHello("www.weibo.cn")
            socket.getOutputStream().write(payload)
            socket.getOutputStream().flush()

            withTimeout(2000) {
                while (forwardConnector.lastSession == null) delay(10)
            }

            assertEquals(0, directConnector.connectCalls.size)
            assertEquals("www.weibo.cn", forwardConnector.openCalls.first().first)
            assertEquals(443, forwardConnector.openCalls.first().second)

            val session = forwardConnector.lastSession!!
            withTimeout(2000) {
                while (session.sentData.isEmpty()) delay(10)
            }
            assertArrayEquals(payload, session.sentData.first())
            socket.close()
        } finally {
            server.stop()
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // Relay tests
    // ══════════════════════════════════════════════════════════════════

    @Test
    fun `relay copies bytes client to target DIRECT`() = runTest {
        val server = createServer(alwaysDirectEngine())
        server.start()
        try {
            val socket = socksConnect(server, "relay.example.com", 80)
            val clientOut = socket.getOutputStream()
            val clientIn = socket.getInputStream()
            val replyCode = readSocksResponse(clientIn)
            assertEquals(0x00.toByte(), replyCode)

            withTimeout(2000) {
                while (directConnector.lastSocket == null) delay(10)
            }

            val targetSocket = directConnector.lastSocket!!
            val testData = "Hello from client".toByteArray()
            clientOut.write(testData)
            clientOut.flush()

            withTimeout(2000) {
                while (targetSocket.receivedFromClient.size() < testData.size) delay(10)
            }
            assertArrayEquals(testData, targetSocket.receivedFromClient.toByteArray())
            socket.close()
        } finally {
            server.stop()
        }
    }

    @Test
    fun `relay copies bytes target to client DIRECT`() = runTest {
        val server = createServer(alwaysDirectEngine())
        server.start()
        try {
            val socket = socksConnect(server, "relay2.example.com", 80)
            val clientOut = socket.getOutputStream()
            val clientIn = socket.getInputStream()
            val replyCode = readSocksResponse(clientIn)
            assertEquals(0x00.toByte(), replyCode)

            withTimeout(2000) {
                while (directConnector.lastSocket == null) delay(10)
            }

            val targetSocket = directConnector.lastSocket!!
            val testData = "Hello from server".toByteArray()
            targetSocket.sendToClient(testData)

            val buffer = ByteArray(testData.size)
            withTimeout(2000) {
                readFully(clientIn, buffer)
            }
            assertArrayEquals(testData, buffer)
            socket.close()
        } finally {
            server.stop()
        }
    }

    @Test
    fun `relay copies bytes client to tunnel PROXY`() = runTest {
        val server = createServer(alwaysProxyEngine())
        server.start()
        try {
            val socket = socksConnect(server, "tunnel.example.com", 443)
            val clientOut = socket.getOutputStream()
            val clientIn = socket.getInputStream()
            val replyCode = readSocksResponse(clientIn)
            assertEquals(0x00.toByte(), replyCode)

            withTimeout(2000) {
                while (forwardConnector.lastSession == null) delay(10)
            }

            val session = forwardConnector.lastSession!!
            val testData = "Hello to tunnel".toByteArray()
            clientOut.write(testData)
            clientOut.flush()

            withTimeout(2000) {
                while (session.sentData.isEmpty()) delay(10)
            }
            assertArrayEquals(testData, session.sentData.first())
            socket.close()
        } finally {
            server.stop()
        }
    }

    @Test
    fun `relay copies bytes tunnel to client PROXY`() = runTest {
        val server = createServer(alwaysProxyEngine())
        server.start()
        try {
            val socket = socksConnect(server, "tunnel2.example.com", 443)
            val clientOut = socket.getOutputStream()
            val clientIn = socket.getInputStream()
            val replyCode = readSocksResponse(clientIn)
            assertEquals(0x00.toByte(), replyCode)

            withTimeout(2000) {
                while (forwardConnector.lastSession == null) delay(10)
            }

            val session = forwardConnector.lastSession!!
            val testData = "Hello from tunnel".toByteArray()
            session.deliverToClient(testData)

            val buffer = ByteArray(testData.size)
            withTimeout(2000) {
                readFully(clientIn, buffer)
            }
            assertArrayEquals(testData, buffer)
            socket.close()
        } finally {
            server.stop()
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // Error handling tests
    // ══════════════════════════════════════════════════════════════════

    @Test
    fun `unsupported command returns COMMAND_NOT_SUPPORTED`() = runTest {
        val server = createServer()
        server.start()
        try {
            val socket = Socket("127.0.0.1", server.port)
            val out = socket.getOutputStream()
            val input = socket.getInputStream()

            out.write(byteArrayOf(0x05, 0x01, 0x00))
            out.flush()
            val greetingResp = ByteArray(2)
            readFully(input, greetingResp)

            // BIND command (not supported)
            out.write(byteArrayOf(0x05, 0x02, 0x00, 0x03, 0x03, 0x66, 0x6F, 0x6F, 0x00, 0x50))
            out.flush()

            val replyCode = readSocksResponse(input)
            assertEquals(0x07.toByte(), replyCode)
            socket.close()
        } finally {
            server.stop()
        }
    }

    @Test
    fun `UDP ASSOCIATE returns COMMAND_NOT_SUPPORTED`() = runTest {
        val server = createServer()
        server.start()
        try {
            val socket = Socket("127.0.0.1", server.port)
            val out = socket.getOutputStream()
            val input = socket.getInputStream()

            out.write(byteArrayOf(0x05, 0x01, 0x00))
            out.flush()
            readFully(input, ByteArray(2))

            // UDP ASSOCIATE
            out.write(byteArrayOf(0x05, 0x03, 0x00, 0x03, 0x03, 0x66, 0x6F, 0x6F, 0x00, 0x50))
            out.flush()

            val replyCode = readSocksResponse(input)
            assertEquals(0x07.toByte(), replyCode)
            socket.close()
        } finally {
            server.stop()
        }
    }

    @Test
    fun `direct connection failure returns HOST_UNREACHABLE`() = runTest {
        directConnector.shouldFail = true
        val server = createServer(alwaysDirectEngine())
        server.start()
        try {
            val socket = socksConnect(server, "fail.example.com", 80)
            val replyCode = readSocksResponse(socket.getInputStream())
            assertEquals(0x04.toByte(), replyCode)
            socket.close()
        } finally {
            server.stop()
        }
    }

    @Test
    fun `forward session failure returns GENERAL_FAILURE`() = runTest {
        forwardConnector.shouldFail = true
        val server = createServer(alwaysProxyEngine())
        server.start()
        try {
            val socket = socksConnect(server, "fail.example.com", 443)
            val replyCode = readSocksResponse(socket.getInputStream())
            assertEquals(0x01.toByte(), replyCode)
            socket.close()
        } finally {
            server.stop()
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // Cleanup tests
    // ══════════════════════════════════════════════════════════════════

    @Test
    fun `server stop closes active forward sessions`() = runTest {
        val server = createServer(alwaysProxyEngine())
        server.start()

        val socket = socksConnect(server, "cleanup.example.com", 443)
        readSocksResponse(socket.getInputStream())

        withTimeout(2000) {
            while (forwardConnector.lastSession == null) delay(10)
        }

        val session = forwardConnector.lastSession!!
        assertFalse(session.isClosed)

        server.stop()
        delay(200)

        assertTrue("Session should be closed after server stop", session.isClosed)
        socket.close()
    }

    @Test
    fun `client disconnect cleans up session`() = runTest {
        val server = createServer(alwaysProxyEngine())
        server.start()

        val socket = socksConnect(server, "disconnect.example.com", 443)
        readSocksResponse(socket.getInputStream())

        withTimeout(2000) {
            while (forwardConnector.lastSession == null) delay(10)
        }

        val session = forwardConnector.lastSession!!

        // Close client socket abruptly
        socket.close()

        // Poll for cleanup with real-time timeout (IO threads need real time)
        withTimeout(3000) {
            while (!session.isClosed) delay(10)
        }
        assertTrue("Session should be closed after client disconnect", session.isClosed)

        server.stop()
    }

    // ══════════════════════════════════════════════════════════════════
    // Multiple connections test
    // ══════════════════════════════════════════════════════════════════

    @Test
    fun `server handles multiple concurrent connections`() = runTest {
        val server = createServer(alwaysDirectEngine())
        server.start()
        try {
            val sockets = (1..3).map { i ->
                socksConnect(server, "host$i.example.com", 80 + i)
            }

            // All should get success responses
            for (socket in sockets) {
                val replyCode = readSocksResponse(socket.getInputStream())
                assertEquals(0x00.toByte(), replyCode)
            }

            // Wait for all direct connections
            withTimeout(3000) {
                while (directConnector.connectCalls.size < 3) delay(10)
            }

            assertEquals(3, directConnector.connectCalls.size)
            sockets.forEach { it.close() }
        } finally {
            server.stop()
        }
    }

    // ══════════════════════════════════════════════════════════════════
    // Fake implementations
    // ══════════════════════════════════════════════════════════════════

    class FakeDirectConnector : DirectConnector {
        val connectCalls = CopyOnWriteArrayList<Pair<String, Int>>()

        @Volatile
        var lastSocket: FakeTargetSocket? = null

        @Volatile
        var shouldFail = false

        override suspend fun connect(host: String, port: Int): Socket {
            connectCalls.add(host to port)
            if (shouldFail) throw IOException("Simulated connection failure")
            val socket = FakeTargetSocket()
            lastSocket = socket
            return socket
        }
    }

    class FakeForwardConnector : ForwardConnector {
        val openCalls = CopyOnWriteArrayList<Pair<String, Int>>()

        @Volatile
        var lastSession: FakeForwardSessionHandle? = null

        @Volatile
        var shouldFail = false

        override suspend fun openForwardSession(host: String, port: Int): ForwardSessionHandle {
            openCalls.add(host to port)
            if (shouldFail) throw IOException("Simulated tunnel failure")
            val session = FakeForwardSessionHandle()
            lastSession = session
            return session
        }
    }

    /**
     * Fake Socket backed by piped streams for in-process testing.
     * Data written to getOutputStream() goes to receivedFromClient.
     * Data sent via sendToClient() can be read from getInputStream().
     */
    class FakeTargetSocket : Socket() {
        private val clientToTargetOut = java.io.PipedOutputStream()
        private val targetReadsFromClient = java.io.PipedInputStream(clientToTargetOut)

        private val targetToClientOut = java.io.PipedOutputStream()
        private val clientReadsFromTarget = java.io.PipedInputStream(targetToClientOut)

        val receivedFromClient = java.io.ByteArrayOutputStream()

        // Background thread to drain targetReadsFromClient into receivedFromClient
        private val drainThread = Thread {
            try {
                val buf = ByteArray(1024)
                while (true) {
                    val n = targetReadsFromClient.read(buf)
                    if (n <= 0) break
                    synchronized(receivedFromClient) {
                        receivedFromClient.write(buf, 0, n)
                    }
                }
            } catch (_: Exception) {}
        }.apply { isDaemon = true; start() }

        override fun getInputStream(): InputStream = clientReadsFromTarget
        override fun getOutputStream(): OutputStream = clientToTargetOut
        override fun close() {
            try { clientToTargetOut.close() } catch (_: Exception) {}
            try { targetToClientOut.close() } catch (_: Exception) {}
        }
        override fun isConnected() = true
        override fun isClosed() = false

        fun sendToClient(data: ByteArray) {
            targetToClientOut.write(data)
            targetToClientOut.flush()
        }
    }

    /**
     * Fake ForwardSessionHandle for testing the PROXY relay path.
     */
    class FakeForwardSessionHandle : ForwardSessionHandle {
        val sentData = CopyOnWriteArrayList<ByteArray>()
        override val inboundData = Channel<ByteArray>(Channel.UNLIMITED)

        @Volatile
        override var isClosed = false
            private set

        override suspend fun sendData(data: ByteArray) {
            if (isClosed) return
            sentData.add(data.copyOf())
        }

        override suspend fun sendClose() {
            isClosed = true
            inboundData.close()
        }

        override fun close() {
            isClosed = true
            inboundData.close()
        }

        fun deliverToClient(data: ByteArray) {
            inboundData.trySend(data.copyOf())
        }
    }

    companion object {
        private fun tlsClientHello(hostname: String): ByteArray {
            val body = java.io.ByteArrayOutputStream()
            body.write(byteArrayOf(0x03, 0x03))
            body.write(ByteArray(32) { 0x11 })
            body.write(0x00)
            body.write(byteArrayOf(0x00, 0x02, 0x13, 0x01))
            body.write(byteArrayOf(0x01, 0x00))

            val hostBytes = hostname.toByteArray(Charsets.US_ASCII)
            val serverName = java.io.ByteArrayOutputStream()
            serverName.write(0x00)
            serverName.write(shortBytes(hostBytes.size))
            serverName.write(hostBytes)

            val sniData = java.io.ByteArrayOutputStream()
            sniData.write(shortBytes(serverName.size()))
            sniData.write(serverName.toByteArray())

            val extensions = java.io.ByteArrayOutputStream()
            extensions.write(byteArrayOf(0x00, 0x00))
            extensions.write(shortBytes(sniData.size()))
            extensions.write(sniData.toByteArray())

            body.write(shortBytes(extensions.size()))
            body.write(extensions.toByteArray())

            val handshakeBody = body.toByteArray()
            val handshake = java.io.ByteArrayOutputStream()
            handshake.write(0x01)
            handshake.write(byteArrayOf(
                ((handshakeBody.size shr 16) and 0xFF).toByte(),
                ((handshakeBody.size shr 8) and 0xFF).toByte(),
                (handshakeBody.size and 0xFF).toByte(),
            ))
            handshake.write(handshakeBody)

            val recordBody = handshake.toByteArray()
            val record = java.io.ByteArrayOutputStream()
            record.write(0x16)
            record.write(byteArrayOf(0x03, 0x03))
            record.write(shortBytes(recordBody.size))
            record.write(recordBody)
            return record.toByteArray()
        }

        private fun shortBytes(value: Int): ByteArray =
            byteArrayOf(((value shr 8) and 0xFF).toByte(), (value and 0xFF).toByte())
    }
}
