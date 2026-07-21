package com.blockproxy.android.cdn

import com.blockproxy.android.tunnel.XhttpTransport
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import okhttp3.Dns
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.InetSocketAddress
import java.net.InetAddress
import java.net.Socket
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.TimeUnit

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

data class CfIpRouteProbeConfig(
    val host: String,
    val port: Int,
    val xhttpBasePath: String,
    val allowInsecure: Boolean,
)

interface CfIpRouteProbe {
    fun supportsXhttpRoute(
        ip: String,
        host: String,
        port: Int,
        xhttpBasePath: String,
        allowInsecure: Boolean,
        protect: ((Socket) -> Boolean)?,
    ): Boolean
}

class RealCfIpRouteProbe : CfIpRouteProbe {
    override fun supportsXhttpRoute(
        ip: String,
        host: String,
        port: Int,
        xhttpBasePath: String,
        allowInsecure: Boolean,
        protect: ((Socket) -> Boolean)?,
    ): Boolean {
        val basePath = if (xhttpBasePath.startsWith("/")) xhttpBasePath else "/$xhttpBasePath"
        val url = "https://$host:$port$basePath/create"
        val client = XhttpTransport.createOkHttpClient(
            allowInsecure = allowInsecure,
            protect = protect,
        ).newBuilder()
            .dns(object : Dns {
                override fun lookup(hostname: String): List<InetAddress> {
                    return if (hostname.equals(host, ignoreCase = true)) {
                        val ipBytes = InetAddress.getByName(ip).address
                        listOf(InetAddress.getByAddress(hostname, ipBytes))
                    } else {
                        Dns.SYSTEM.lookup(hostname)
                    }
                }
            })
            .readTimeout(5, TimeUnit.SECONDS)
            .writeTimeout(5, TimeUnit.SECONDS)
            .build()

        val request = Request.Builder()
            .url(url)
            .post(ByteArray(0).toRequestBody("application/octet-stream".toMediaType()))
            .header("Content-Type", "application/octet-stream")
            .header("Cache-Control", "no-store")
            .build()

        return runCatching {
            client.newCall(request).execute().use { response ->
                response.code in setOf(200, 400, 401, 409)
            }
        }.getOrDefault(false)
    }
}

class CfIpSpeedTester(
    private val ipPool: CfIpPool,
    private val testPort: Int,
    private val protect: ((Socket) -> Boolean)? = null,
    private val socketConnector: SocketConnector = RealSocketConnector(),
    private val routeProbe: CfIpRouteProbe? = null,
    private val routeProbeConfig: CfIpRouteProbeConfig? = null,
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
            .filter { (ip, _) -> supportsXhttpRoute(ip) }
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

    private fun supportsXhttpRoute(ip: String): Boolean {
        val probe = routeProbe ?: return true
        val config = routeProbeConfig ?: return true
        return probe.supportsXhttpRoute(
            ip = ip,
            host = config.host,
            port = config.port,
            xhttpBasePath = config.xhttpBasePath,
            allowInsecure = config.allowInsecure,
            protect = protect,
        )
    }
}
