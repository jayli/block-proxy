package com.blockproxy.android.cdn

import android.os.Build
import android.util.Log
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
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.TimeUnit
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager

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

interface TlsSniChecker {
    /**
     * 对指定 IP 做 TLS SNI 连通性检测。
     *
     * 直连 IP → TLS ClientHello（携带 [host] 作为 SNI）→ 检查是否收到 ServerHello。
     * 握手成功即返回 true（不验证证书、不发 HTTP 请求、不检查证书主体）。
     *
     * @return true 表示该 IP 接受此域名的 TLS 连接
     */
    fun checkSni(
        ip: String,
        host: String,
        port: Int,
        timeoutMs: Int,
        protect: ((Socket) -> Boolean)?,
    ): Boolean
}

/**
 * 基于 [SSLSocket] 的轻量 TLS SNI 检测器。
 *
 * 只完成 TCP 连接 + TLS 握手（ClientHello/ServerHello），
 * 不发送 HTTP 请求、不验证证书链，比完整 HTTPS 请求快 3~5 倍。
 *
 * SNI 设置：API 24+ 通过 [SSLParameters.serverNames]；低版本设备跳过 SNI 设置，
 * 此时 CDN 边缘节点可能返回默认证书，握手仍成功但对阿里云 CDN 域名校验无效。
 * 由于阿里云 CDN 主要面向较新设备，此限制可接受。
 */
class RealTlsSniChecker : TlsSniChecker {
    override fun checkSni(
        ip: String,
        host: String,
        port: Int,
        timeoutMs: Int,
        protect: ((Socket) -> Boolean)?,
    ): Boolean {
        return try {
            val sslContext = SSLContext.getInstance("TLS").apply {
                init(null, arrayOf<X509TrustManager>(TrustAllCertificatesManager()), SecureRandom())
            }
            val socket = sslContext.socketFactory.createSocket() as SSLSocket

            // 设置 SNI：告知 CDN 边缘节点目标域名
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                val params = socket.sslParameters
                params.serverNames = listOf(SNIHostName(host))
                socket.sslParameters = params
            }

            socket.soTimeout = timeoutMs
            protect?.invoke(socket)
            socket.connect(InetSocketAddress(ip, port), timeoutMs)
            socket.startHandshake()
            socket.close()
            true
        } catch (_: Exception) {
            false
        }
    }
}

/**
 * 接受所有证书的 TrustManager，仅用于连通性探测。
 * 不验证证书链有效性——只需要确认 TLS 握手能完成即可。
 */
private class TrustAllCertificatesManager : X509TrustManager {
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
}

class CfIpSpeedTester(
    private val ipPool: CfIpPool,
    private val testPort: Int,
    private val protect: ((Socket) -> Boolean)? = null,
    private val socketConnector: SocketConnector = RealSocketConnector(),
    private val routeProbe: CfIpRouteProbe? = null,
    private val routeProbeConfig: CfIpRouteProbeConfig? = null,
    private val sniChecker: TlsSniChecker? = null,
    private val sniHost: String? = null,
) {
    companion object {
        const val TOP_N = 50
        const val CONNECT_TIMEOUT_MS = 3_000
        const val CONCURRENCY = 20
        const val TEST_ROUNDS = 2
        private const val TAG = "CfIpSpeedTester"
    }

    private data class IpReachabilityResult(
        val ip: String,
        val tcpLatency: Long?,
        val sniOk: Boolean,
    )

    /**
     * 对单个 IP 做 TCP 延迟测速 + 可选的 TLS SNI 连通性检测。
     *
     * - TCP 不可达 → 返回 null（直接弃用）
     * - TCP 可达但 sniChecker 为 null → sniOk=true（无需 SNI 检查，例如 CF CDN）
     * - TCP 可达 + sniChecker 存在 → 执行 SNI 检测，仅握手成功的 IP 才能进入候选池
     */
    private fun testIpReachability(
        ip: String,
        sniChecker: TlsSniChecker?,
        sniHost: String?,
    ): IpReachabilityResult {
        val latency = medianLatency(ip)
        if (latency == null) {
            return IpReachabilityResult(ip, null, false)
        }

        val sniOk = if (sniChecker != null && sniHost != null) {
            sniChecker.checkSni(ip, sniHost, testPort, CONNECT_TIMEOUT_MS, protect)
        } else {
            true
        }

        return IpReachabilityResult(ip, latency, sniOk)
    }

    suspend fun runTest(onProgress: (tested: Int, total: Int) -> Unit = { _, _ -> }): List<String> {
        val allIps = ipPool.loadAllIps()
        if (allIps.isEmpty()) return emptyList()

        val _sniChecker = sniChecker
        val _sniHost = sniHost

        val tested = AtomicInteger(0)
        val semaphore = Semaphore(CONCURRENCY)
        val results = coroutineScope {
            allIps.map { ip ->
                async(Dispatchers.IO) {
                    semaphore.withPermit {
                        val reach = testIpReachability(ip, _sniChecker, _sniHost)
                        onProgress(tested.incrementAndGet(), allIps.size)
                        reach
                    }
                }
            }.awaitAll()
        }

        // 统计过滤信息
        val tcpReachableCount = results.count { it.tcpLatency != null }
        val sniPassedCount = if (_sniChecker != null && _sniHost != null) {
            results.count { it.tcpLatency != null && it.sniOk }
        } else {
            tcpReachableCount
        }
        if (_sniChecker != null && _sniHost != null) {
            Log.i(TAG, "SNI pre-filter: $tcpReachableCount TCP reachable → $sniPassedCount SNI passed (filtered ${tcpReachableCount - sniPassedCount})")
        }

        // 过滤：TCP 可达 && SNI 通过（无需 SNI 检查时默认通过）
        val validResults = results
            .filter { it.tcpLatency != null && it.sniOk }
            .sortedBy { it.tcpLatency }
            .map { it.ip }

        // 从有效 IP 中取最快 TOP_N 个，再做 route probe 最终过滤
        val candidates = validResults.take(TOP_N)
        val selected = candidates
            .filter { ip -> supportsXhttpRoute(ip) }
            .map { it }

        if (_sniChecker != null && _sniHost != null && selected.size < TOP_N) {
            Log.i(TAG, "After SNI + route-probe filter: ${selected.size} valid IPs (target $TOP_N)")
        }

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
