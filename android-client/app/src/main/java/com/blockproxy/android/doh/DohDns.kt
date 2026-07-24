package com.blockproxy.android.doh

import android.util.Log
import com.blockproxy.android.tunnel.ProtectedSocketFactory
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import org.json.JSONObject
import java.net.InetAddress
import java.net.Proxy
import java.net.Socket
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

private const val TAG = "DohDns"

private data class CacheEntry(
    val expiryTimeMs: Long,
    val addresses: List<InetAddress>,
)

class DohDns(
    private val serverHost: String,
    private val protect: ((Socket) -> Boolean)?,
    private val delegate: Dns = Dns.SYSTEM,
    internal var dohQueryFn: ((String, String) -> List<String>)? = null,
) : Dns {

    private val cache = ConcurrentHashMap<String, CacheEntry>()

    /** Returns the first cached IP for status display, or null. */
    fun getCurrentIp(): String? = cache[serverHost]?.addresses?.firstOrNull()?.hostAddress

    override fun lookup(hostname: String): List<InetAddress> {
        if (!hostname.equals(serverHost, ignoreCase = true)) {
            return delegate.lookup(hostname)
        }

        // Check cache
        val cached = cache[hostname]
        if (cached != null && System.currentTimeMillis() < cached.expiryTimeMs) {
            return cached.addresses
        }

        // Resolve via DoH
        try {
            val ips = dohResolve(hostname)
            if (ips.isEmpty()) {
                Log.w(TAG, "DoH returned no IPs for $hostname; falling back to system DNS")
                return delegate.lookup(hostname)
            }

            val addresses = ips.map { ip ->
                val bytes = InetAddress.getByName(ip).address
                InetAddress.getByAddress(hostname, bytes)
            }

            val expiry = System.currentTimeMillis() + DohConfig.CACHE_TTL_MS
            cache[hostname] = CacheEntry(expiry, addresses)
            return addresses
        } catch (e: Exception) {
            Log.w(TAG, "DoH resolution failed for $hostname: ${e.message}; falling back to system DNS")
            return delegate.lookup(hostname)
        }
    }

    private fun dohResolve(hostname: String): List<String> {
        val ipv4 = dohQuery(hostname, "A")
        val ipv6 = dohQuery(hostname, "AAAA")

        val seen = HashSet<String>()
        val result = mutableListOf<String>()
        for (ip in ipv4 + ipv6) {
            if (seen.add(ip)) {
                result.add(ip)
            }
        }
        return result
    }

    private fun dohQuery(domain: String, recordType: String): List<String> {
        if (dohQueryFn != null) {
            return dohQueryFn!!(domain, recordType)
        }
        return dohQueryHttp(domain, recordType)
    }

    private fun dohQueryHttp(domain: String, recordType: String): List<String> {
        val url = "${DohConfig.DOH_URL}?name=$domain&type=$recordType"
        val request = Request.Builder().url(url).header("Accept", "application/dns-json").build()

        val response = dohClient.newCall(request).execute()
        val body = response.body?.string() ?: return emptyList()

        if (!response.isSuccessful) {
            Log.w(TAG, "DoH HTTP error: ${response.code} for $domain $recordType")
            return emptyList()
        }

        val expectedType = if (recordType == "A") 1 else 28
        val ips = mutableListOf<String>()
        val json = JSONObject(body)
        val answers = json.optJSONArray("Answer") ?: return emptyList()

        for (i in 0 until answers.length()) {
            val answer = answers.getJSONObject(i)
            if (answer.optInt("type") != expectedType) continue
            val data = answer.optString("data", "")
            if (data.isEmpty()) continue
            try {
                val addr = InetAddress.getByName(data)
                if ((recordType == "A" && addr.address.size == 4) ||
                    (recordType == "AAAA" && addr.address.size == 16)
                ) {
                    ips.add(data)
                }
            } catch (_: Exception) {
                // Skip invalid IP
            }
        }
        return ips
    }

    /**
     * Internal OkHttp client for DoH queries.
     * Uses bootstrap IPs to resolve the DoH server, bypasses VPN via protect().
     */
    private val dohClient: OkHttpClient by lazy {
        val trustAllCerts = arrayOf<TrustManager>(object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        })
        val sslContext = SSLContext.getInstance("TLS").apply {
            init(null, trustAllCerts, SecureRandom())
        }

        // DNS that resolves the DoH host to bootstrap IPs, everything else to system DNS
        val bootstrapDns = object : Dns {
            override fun lookup(hostname: String): List<InetAddress> {
                if (hostname.equals(DohConfig.DOH_HOST, ignoreCase = true)) {
                    return DohConfig.BOOTSTRAP_IPS.map { InetAddress.getByName(it) }
                }
                return Dns.SYSTEM.lookup(hostname)
            }
        }

        val builder = OkHttpClient.Builder()
            .connectTimeout(DohConfig.TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .readTimeout(DohConfig.TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .writeTimeout(DohConfig.TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .protocols(listOf(Protocol.HTTP_1_1))
            .proxy(Proxy.NO_PROXY)
            .dns(bootstrapDns)
            .sslSocketFactory(sslContext.socketFactory, trustAllCerts[0] as X509TrustManager)
            .hostnameVerifier { _, _ -> true }

        if (protect != null) {
            builder.socketFactory(ProtectedSocketFactory(protect))
        }

        builder.build()
    }
}
