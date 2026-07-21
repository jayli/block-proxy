package com.blockproxy.android.util

import android.util.Log
import com.blockproxy.android.cdn.CfIpRuntimeRegistry
import okhttp3.Dns
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.InetAddress
import java.net.Proxy
import java.security.cert.X509Certificate
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

/**
 * 证书链中单个证书的信息。
 */
data class CertInfo(
    val subject: String,
    val issuer: String,
    val notBefore: String,
    val notAfter: String,
    val serialNumber: String,
)

/**
 * TLS 测试结果。
 */
data class TlsTestResult(
    val reachable: Boolean,
    val isMitm: Boolean,
    val matchedKeyword: String?,
    val leafIssuer: String,
    val leafSubject: String,
    val isSelfSigned: Boolean,
    val verifyOk: Boolean,
    val certChainSize: Int,
    val chain: List<CertInfo>,
    val durationMs: Long,
    val error: String?,
    val connectedIp: String?,
    val xhttpRouteStatus: Int? = null,
    val xhttpRouteOk: Boolean? = null,
    val xhttpRouteServer: String? = null,
    val xhttpRouteCfRay: String? = null,
    val xhttpRouteError: String? = null,
)

data class XhttpRouteTestResult(
    val status: Int?,
    val ok: Boolean,
    val server: String?,
    val cfRay: String?,
    val error: String?,
)

/**
 * TLS 连接测试 + MITM 检测。
 *
 * 使用 OkHttp 执行 HTTPS 请求触发 TLS 握手。OkHttp 在所有 Android API 级别
 * （包括 API 23）都正确设置 SNI，无需反射调用平台内部 API。
 *
 * 证书提取在 RecordingTrustManager.checkServerTrusted() 中完成：
 * 该方法在 TLS 握手期间被调用，此时证书链已经完整可用。
 * 这比依赖 OkHttp 的 handshake/response 机制更可靠，
 * 因为 TrustManager 回调发生在 TLS 层，早于 HTTP 解析层。
 * 即使后续 HTTP 响应解析失败（隧道服务器不是 HTTP 服务器），证书已捕获。
 *
 * CF CDN 模式下，通过自定义 Dns 将 hostname 解析为 CF 边缘 IP。
 * 关键：InetAddress.getByAddress(hostname, ipBytes) 携带原始 hostname，
 * 让 OkHttp 内部 isNumeric(hostName) 为 false，从而正确设置 SNI。
 * 否则 OkHttp 检测到纯 IP 会跳过 SNI，导致 CF 拒绝连接。
 *
 * VPN 不需要 protect()，因为 BlockProxyVpnService 已通过
 * addDisallowedApplication(packageName) 排除本应用的所有流量。
 */
object TlsTester {
    private const val TAG = "TlsTester"

    /** 默认 MITM 检测关键字（企业代理常见 issuer） */
    val DEFAULT_MITM_KEYWORDS = listOf("Alilang")

    /**
     * 对 host:port 执行 TLS 握手并检测 MITM。
     *
     * @param host 服务器域名（用于 SNI 和 URL）
     * @param port 服务器端口
     * @param ipOverride 直连 IP（跳过 DNS 解析）。CF CDN 模式下传入当前游标指向的 CF 边缘 IP，
     *                   避免公司网关 DNS 劫持导致 MITM。为 null 时走正常 DNS 解析。
     * @param timeoutMs 连接超时（默认 5000ms）
     * @param mitmKeywords MITM 关键字列表
     * @return 测试结果
     */
    fun test(
        host: String,
        port: Int,
        ipOverride: String? = null,
        timeoutMs: Int = 5000,
        mitmKeywords: List<String> = DEFAULT_MITM_KEYWORDS,
    ): TlsTestResult {
        val startTime = System.currentTimeMillis()

        // RecordingTrustManager 在 TLS 握手期间捕获证书
        val recordingTm = RecordingTrustManager()

        try {
            val sslContext = SSLContext.getInstance("TLS").apply {
                init(null, arrayOf<TrustManager>(recordingTm), null)
            }

            val builder = OkHttpClient.Builder()
                .connectTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                .readTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                .writeTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                .proxy(Proxy.NO_PROXY)
                .sslSocketFactory(sslContext.socketFactory, recordingTm)
                .hostnameVerifier { _, _ -> true }

            // 有 ipOverride 时：通过自定义 Dns 将 hostname 解析为指定 IP。
            // 关键：InetAddress.getByAddress(hostname, ipBytes) 携带原始 hostname，
            // 让 OkHttp 内部 isNumeric(addr.hostName) 为 false，从而正确设置 SNI。
            if (ipOverride != null) {
                builder.dns(object : Dns {
                    override fun lookup(hostname: String): List<InetAddress> {
                        val ipBytes = InetAddress.getByName(ipOverride).address
                        return listOf(InetAddress.getByAddress(hostname, ipBytes))
                    }
                })
            }

            // VPN 保护：如果 VPN 服务在运行，保护 socket 避免路由循环
            CfIpRuntimeRegistry.currentProtect()?.let { protect ->
                builder.socketFactory(
                    com.blockproxy.android.tunnel.ProtectedSocketFactory(protect)
                )
            }

            val client = builder.build()

            // 用原始 hostname 构建 URL，OkHttp 自动设置 SNI
            val url = "https://$host:$port/"
            val request = Request.Builder().url(url).build()

            try {
                val response = client.newCall(request).execute()
                response.close()
            } catch (e: Exception) {
                // 隧道服务器不是 HTTP 服务器，响应解析可能失败。
                // 但 TLS 握手已完成，证书已在 RecordingTrustManager 中捕获。
                Log.d(TAG, "HTTP response error (expected): ${e.message}")
            }

            client.dispatcher.executorService.shutdown()
            client.connectionPool.evictAll()

            val certs = recordingTm.capturedCerts
            val durationMs = System.currentTimeMillis() - startTime

            if (certs.isEmpty()) {
                return TlsTestResult(
                    reachable = false,
                    isMitm = false,
                    matchedKeyword = null,
                    leafIssuer = "",
                    leafSubject = "",
                    isSelfSigned = false,
                    verifyOk = false,
                    certChainSize = 0,
                    chain = emptyList(),
                    durationMs = durationMs,
                    error = "未获取到证书",
                    connectedIp = ipOverride,
                )
            }

            // 解析证书链
            val chain = certs.map { x509 ->
                CertInfo(
                    subject = x509.subjectDN.name,
                    issuer = x509.issuerDN.name,
                    notBefore = formatDate(x509.notBefore),
                    notAfter = formatDate(x509.notAfter),
                    serialNumber = x509.serialNumber.toString(16),
                )
            }

            val leafCert = certs[0]
            val leafIssuer = leafCert.issuerDN.name
            val leafSubject = leafCert.subjectDN.name
            val isSelfSigned = leafSubject == leafIssuer

            // MITM 检测：遍历证书链中每个证书的 issuer
            var isMitm = false
            var matchedKeyword: String? = null
            for (cert in certs) {
                val issuerDn = cert.issuerDN.name.lowercase(Locale.ROOT)
                for (keyword in mitmKeywords) {
                    if (issuerDn.contains(keyword.lowercase(Locale.ROOT))) {
                        isMitm = true
                        matchedKeyword = keyword
                        break
                    }
                }
                if (isMitm) break
            }

            return TlsTestResult(
                reachable = true,
                isMitm = isMitm,
                matchedKeyword = matchedKeyword,
                leafIssuer = leafIssuer,
                leafSubject = leafSubject,
                isSelfSigned = isSelfSigned,
                verifyOk = recordingTm.lastVerifyOk,
                certChainSize = certs.size,
                chain = chain,
                durationMs = durationMs,
                error = null,
                connectedIp = ipOverride,
            )
        } catch (e: Exception) {
            val durationMs = System.currentTimeMillis() - startTime
            Log.e(TAG, "TLS test failed: ${e.message}", e)
            return TlsTestResult(
                reachable = false,
                isMitm = false,
                matchedKeyword = null,
                leafIssuer = "",
                leafSubject = "",
                isSelfSigned = false,
                verifyOk = false,
                certChainSize = 0,
                chain = emptyList(),
                durationMs = durationMs,
                error = e.message ?: "连接失败",
                connectedIp = ipOverride,
            )
        }
    }

    fun testXhttpCreateRoute(
        host: String,
        port: Int,
        xhttpBasePath: String = "/xhttp",
        ipOverride: String? = null,
        timeoutMs: Int = 5000,
    ): XhttpRouteTestResult {
        val basePath = if (xhttpBasePath.startsWith("/")) xhttpBasePath else "/$xhttpBasePath"
        val url = "https://$host:$port$basePath/create"
        val recordingTm = RecordingTrustManager()

        return try {
            val sslContext = SSLContext.getInstance("TLS").apply {
                init(null, arrayOf<TrustManager>(recordingTm), null)
            }
            val builder = OkHttpClient.Builder()
                .connectTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                .readTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                .writeTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
                .proxy(Proxy.NO_PROXY)
                .sslSocketFactory(sslContext.socketFactory, recordingTm)
                .hostnameVerifier { _, _ -> true }

            if (ipOverride != null) {
                builder.dns(object : Dns {
                    override fun lookup(hostname: String): List<InetAddress> {
                        val ipBytes = InetAddress.getByName(ipOverride).address
                        return listOf(InetAddress.getByAddress(hostname, ipBytes))
                    }
                })
            }

            CfIpRuntimeRegistry.currentProtect()?.let { protect ->
                builder.socketFactory(
                    com.blockproxy.android.tunnel.ProtectedSocketFactory(protect)
                )
            }

            val request = Request.Builder()
                .url(url)
                .post(ByteArray(0).toRequestBody("application/octet-stream".toMediaType()))
                .header("Content-Type", "application/octet-stream")
                .header("Cache-Control", "no-store")
                .build()

            val client = builder.build()
            client.newCall(request).execute().use { response ->
                val status = response.code
                response.body?.string()
                XhttpRouteTestResult(
                    status = status,
                    ok = status in setOf(200, 400, 401, 409),
                    server = response.header("server"),
                    cfRay = response.header("cf-ray"),
                    error = null,
                )
            }.also {
                client.dispatcher.executorService.shutdown()
                client.connectionPool.evictAll()
                Log.i(TAG, "xhttp create route test: status=${it.status}, ok=${it.ok}, server=${it.server}, cf-ray=${it.cfRay}, ip=$ipOverride")
            }
        } catch (e: Exception) {
            Log.w(TAG, "xhttp create route test failed: ${e.message}", e)
            XhttpRouteTestResult(
                status = null,
                ok = false,
                server = null,
                cfRay = null,
                error = e.message ?: "xhttp route test failed",
            )
        }
    }

    private val dateFormat = SimpleDateFormat("yyyy-MM-dd", Locale.US)

    private fun formatDate(date: java.util.Date): String {
        return dateFormat.format(date)
    }
}

/**
 * 自定义 TrustManager：接受所有证书（用于支持自签名证书），
 * 同时记录系统默认 trust manager 的验证结果，并捕获证书链。
 *
 * checkServerTrusted() 在 TLS 握手期间被调用，此时证书链已经完整可用。
 * 这比依赖 OkHttp 的 handshake/response 机制更可靠，因为 TrustManager 回调
 * 发生在 TLS 层，早于 HTTP 解析层。即使后续 HTTP 响应解析失败，证书已在此捕获。
 */
private class RecordingTrustManager : X509TrustManager {
    @Volatile
    var lastVerifyOk: Boolean = false

    /** TLS 握手期间捕获的证书链 */
    @Volatile
    var capturedCerts: List<X509Certificate> = emptyList()

    private val systemTrustManager: X509TrustManager? = try {
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        tmf.init(null as java.security.KeyStore?)
        tmf.trustManagers.filterIsInstance<X509TrustManager>().firstOrNull()
    } catch (_: Exception) {
        null
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        // 捕获证书链
        if (chain != null) {
            capturedCerts = chain.toList()
        }

        // 记录系统 trust manager 是否会接受这个证书链
        lastVerifyOk = try {
            systemTrustManager?.checkServerTrusted(chain, authType)
            true
        } catch (_: Exception) {
            false
        }
        // 不抛出异常 —— 接受所有证书，让握手继续进行
    }

    /**
     * Conscrypt 扩展接口：checkServerTrusted with hostname。
     *
     * OkHttp 在 Android 上通过 AndroidCertificateChainCleaner 反射查找
     * TrustManager 上的 checkServerTrusted(X509Certificate[], String, String)
     * 方法。如果找到就调用它做链验证，找不到就回退到系统默认 TrustManager，
     * 自签名证书会被拒绝导致 CertificateException。
     *
     * 此方法让 OkHttp 认为证书验证通过，返回原始证书链。
     */
    @Suppress("unused") // Called via reflection by OkHttp's AndroidCertificateChainCleaner
    fun checkServerTrusted(
        chain: Array<out X509Certificate>?,
        authType: String?,
        @Suppress("UNUSED_PARAMETER") hostname: String?,
    ): List<X509Certificate> {
        // 同时更新标准接口的验证记录
        if (chain != null) {
            capturedCerts = chain.toList()
        }
        lastVerifyOk = try {
            systemTrustManager?.checkServerTrusted(chain, authType)
            true
        } catch (_: Exception) {
            false
        }
        // 返回原始证书链，表示验证通过
        return chain?.toList() ?: emptyList()
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
}
