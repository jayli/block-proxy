package com.blockproxy.android.util

import android.util.Log
import java.net.InetAddress
import java.net.InetSocketAddress
import java.security.cert.X509Certificate
import java.text.SimpleDateFormat
import java.util.Locale
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLParameters
import javax.net.ssl.SSLSocket
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
)

/**
 * TLS 连接测试 + MITM 检测。
 *
 * 对指定的 host:port 执行原始 TLS 握手，提取证书链信息，
 * 并检测证书 issuer 中是否包含已知的 MITM 关键字（如企业代理）。
 *
 * 检测逻辑参考 check_mitm.sh：
 * - 遍历证书链中的每个证书的 issuer DN
 * - 对 issuer 做大小写不敏感的关键字匹配
 * - 任何证书匹配到 MITM 关键字即判定为 MITM
 *
 * 注意：必须在 IO 线程调用（阻塞操作）。
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
     * @param host 服务器地址（域名或 IP）
     * @param port 服务器端口
     * @param timeoutMs 连接超时（默认 5000ms）
     * @param mitmKeywords MITM 关键字列表
     * @return 测试结果
     */
    fun test(
        host: String,
        port: Int,
        timeoutMs: Int = 5000,
        mitmKeywords: List<String> = DEFAULT_MITM_KEYWORDS,
    ): TlsTestResult {
        val startTime = System.currentTimeMillis()

        try {
            // 创建 RecordingTrustManager：接受所有证书（用于自签名），
            // 但记录系统默认 trust manager 是否会接受
            val recordingTm = RecordingTrustManager()
            val sslContext = SSLContext.getInstance("TLS").apply {
                init(null, arrayOf<TrustManager>(recordingTm), null)
            }

            val factory = sslContext.socketFactory
            val socket = factory.createSocket() as SSLSocket

            // 设置超时
            socket.soTimeout = timeoutMs
            socket.connect(InetSocketAddress(host, port), timeoutMs)

            // SNI 支持：如果 host 是域名（非 IP），设置 server name
            if (!isIpAddress(host)) {
                val params: SSLParameters = socket.sslParameters
                params.serverNames = listOf(javax.net.ssl.SNIHostName(host))
                socket.sslParameters = params
            }

            // 执行 TLS 握手
            socket.startHandshake()

            val session = socket.session
            val certs = session.peerCertificates

            // 关闭连接
            socket.close()

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
                )
            }

            // 解析证书链
            val chain = certs.map { cert ->
                val x509 = cert as X509Certificate
                CertInfo(
                    subject = x509.subjectDN.name,
                    issuer = x509.issuerDN.name,
                    notBefore = formatDate(x509.notBefore),
                    notAfter = formatDate(x509.notAfter),
                    serialNumber = x509.serialNumber.toString(16),
                )
            }

            val leafCert = certs[0] as X509Certificate
            val leafIssuer = leafCert.issuerDN.name
            val leafSubject = leafCert.subjectDN.name
            val isSelfSigned = leafSubject == leafIssuer

            // MITM 检测：遍历证书链中每个证书的 issuer
            var isMitm = false
            var matchedKeyword: String? = null
            for (cert in certs) {
                val issuerDn = (cert as X509Certificate).issuerDN.name.lowercase(Locale.ROOT)
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
            )
        }
    }

    private fun isIpAddress(host: String): Boolean {
        return try {
            InetAddress.getByName(host)
            host.matches(Regex("^\\d+\\.\\d+\\.\\d+\\.\\d+$")) || host.contains(":")
        } catch (_: Exception) {
            false
        }
    }

    private val dateFormat = SimpleDateFormat("yyyy-MM-dd", Locale.US)

    private fun formatDate(date: java.util.Date): String {
        return dateFormat.format(date)
    }
}

/**
 * 自定义 TrustManager：接受所有证书（用于支持自签名证书），
 * 但同时记录系统默认 trust manager 的验证结果。
 *
 * 这样既能拿到证书信息（自签名不会被拒绝），又能报告
 * verifyOk 状态（系统信任库是否接受该证书链）。
 */
private class RecordingTrustManager : X509TrustManager {
    @Volatile
    var lastVerifyOk: Boolean = false

    private val systemTrustManager: X509TrustManager? = try {
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        tmf.init(null as java.security.KeyStore?)
        tmf.trustManagers.filterIsInstance<X509TrustManager>().firstOrNull()
    } catch (_: Exception) {
        null
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        // 不检查客户端证书
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        // 记录系统 trust manager 是否会接受这个证书链
        lastVerifyOk = try {
            systemTrustManager?.checkServerTrusted(chain, authType)
            true
        } catch (_: Exception) {
            false
        }
        // 不抛出异常 —— 接受所有证书，让握手继续进行以获取证书信息
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
}
