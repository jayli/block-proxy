package com.blockproxy.android.cdn

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.atomic.AtomicInteger

interface SocketConnector {
    fun connect(
        ip: String,
        port: Int,
        timeoutMs: Int,
        protect: ((Socket) -> Boolean)?,
    ): Long?
}

class RealSocketConnector : SocketConnector {
    override fun connect(
        ip: String,
        port: Int,
        timeoutMs: Int,
        protect: ((Socket) -> Boolean)?,
    ): Long? {
        val socket = Socket()
        return try {
            protect?.invoke(socket)
            val start = System.currentTimeMillis()
            socket.connect(InetSocketAddress(ip, port), timeoutMs)
            System.currentTimeMillis() - start
        } catch (_: Exception) {
            null
        } finally {
            try {
                socket.close()
            } catch (_: Exception) {
                // best effort
            }
        }
    }
}

class CfIpSpeedTester(
    private val ipPool: CfIpPool,
    private val testPort: Int,
    private val protect: ((Socket) -> Boolean)? = null,
    private val socketConnector: SocketConnector = RealSocketConnector(),
) {
    companion object {
        const val TOP_N = 50
        const val CONNECT_TIMEOUT_MS = 3_000
        const val CONCURRENCY = 20
        const val TEST_ROUNDS = 2
    }

    suspend fun runTest(onProgress: (tested: Int, total: Int) -> Unit = { _, _ -> }): List<String> {
        val allIps = ipPool.loadAllIps()
        if (allIps.isEmpty()) return emptyList()

        val tested = AtomicInteger(0)
        val semaphore = Semaphore(CONCURRENCY)
        val results = coroutineScope {
            allIps.map { ip ->
                async(Dispatchers.IO) {
                    semaphore.withPermit {
                        val latency = medianLatency(ip)
                        onProgress(tested.incrementAndGet(), allIps.size)
                        ip to latency
                    }
                }
            }.awaitAll()
        }

        val selected = results
            .mapNotNull { (ip, latency) -> latency?.let { ip to it } }
            .sortedBy { it.second }
            .take(TOP_N)
            .map { it.first }

        if (selected.isNotEmpty()) {
            ipPool.saveGoodIps(selected)
        }
        return selected
    }

    private fun medianLatency(ip: String): Long? {
        val latencies = mutableListOf<Long>()
        repeat(TEST_ROUNDS) {
            val latency = socketConnector.connect(ip, testPort, CONNECT_TIMEOUT_MS, protect)
            if (latency == null) return null
            latencies += latency
        }
        return latencies.sorted()[latencies.size / 2]
    }
}
