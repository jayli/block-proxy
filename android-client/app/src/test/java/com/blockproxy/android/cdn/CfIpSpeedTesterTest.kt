package com.blockproxy.android.cdn

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.Socket

private class FakeSocketConnector(
    private val latencies: Map<String, ArrayDeque<Long?>>,
) : SocketConnector {
    data class Call(val ip: String, val port: Int, val timeoutMs: Int, val protected: Boolean)

    val calls = mutableListOf<Call>()

    override fun connect(
        ip: String,
        port: Int,
        timeoutMs: Int,
        protect: ((Socket) -> Boolean)?,
    ): Long? {
        val socket = Socket()
        var protected = false
        if (protect != null) {
            protected = protect(socket)
        }
        calls += Call(ip, port, timeoutMs, protected)
        return latencies[ip]?.removeFirstOrNull()
    }
}

class CfIpSpeedTesterTest {

    @Test
    fun `runTest uses configured port and protect callback`() = runTest {
        val pool = CfIpPool(
            FakeCfIpStorage(assets = mutableMapOf("cf-ips.txt" to "1.1.1.1\n")),
            FakeCursorStore(),
        )
        val connector = FakeSocketConnector(
            mapOf("1.1.1.1" to ArrayDeque(listOf(20L, 30L)))
        )
        val tester = CfIpSpeedTester(
            ipPool = pool,
            testPort = 8443,
            protect = { true },
            socketConnector = connector,
        )

        assertEquals(listOf("1.1.1.1"), tester.runTest())
        assertEquals(listOf(8443, 8443), connector.calls.map { it.port })
        assertEquals(listOf(true, true), connector.calls.map { it.protected })
    }

    @Test
    fun `runTest selects reachable ips by median latency`() = runTest {
        val storage = FakeCfIpStorage(
            assets = mutableMapOf("cf-ips.txt" to "1.1.1.1\n2.2.2.2\n3.3.3.3\n")
        )
        val pool = CfIpPool(storage, FakeCursorStore())
        val connector = FakeSocketConnector(
            mapOf(
                "1.1.1.1" to ArrayDeque(listOf(100L, 110L)),
                "2.2.2.2" to ArrayDeque(listOf(40L, 50L)),
                "3.3.3.3" to ArrayDeque(listOf(null, null)),
            )
        )

        val result = CfIpSpeedTester(pool, testPort = 443, socketConnector = connector).runTest()

        assertEquals(listOf("2.2.2.2", "1.1.1.1"), result)
        assertEquals(listOf("2.2.2.2\n1.1.1.1"), storage.writes)
    }

    @Test
    fun `runTest reports progress once per ip`() = runTest {
        val pool = CfIpPool(
            FakeCfIpStorage(assets = mutableMapOf("cf-ips.txt" to "1.1.1.1\n2.2.2.2\n")),
            FakeCursorStore(),
        )
        val connector = FakeSocketConnector(
            mapOf(
                "1.1.1.1" to ArrayDeque(listOf(10L, 10L)),
                "2.2.2.2" to ArrayDeque(listOf(20L, 20L)),
            )
        )
        val progress = mutableListOf<Pair<Int, Int>>()

        CfIpSpeedTester(pool, testPort = 443, socketConnector = connector)
            .runTest { tested, total -> progress += tested to total }

        assertEquals(listOf(1 to 2, 2 to 2), progress.sortedBy { it.first })
    }

    @Test
    fun `runTest does not overwrite good ips when none are reachable`() = runTest {
        val storage = FakeCfIpStorage(
            assets = mutableMapOf("cf-ips.txt" to "1.1.1.1\n2.2.2.2\n"),
            internalGoodIps = "9.9.9.9\n",
        )
        val pool = CfIpPool(storage, FakeCursorStore())
        val connector = FakeSocketConnector(
            mapOf(
                "1.1.1.1" to ArrayDeque(listOf(null, null)),
                "2.2.2.2" to ArrayDeque(listOf(null, null)),
            )
        )

        val result = CfIpSpeedTester(pool, testPort = 443, socketConnector = connector).runTest()

        assertEquals(emptyList<String>(), result)
        assertEquals(emptyList<String>(), storage.writes)
    }
}
