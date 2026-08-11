package com.blockproxy.android.util

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import com.blockproxy.android.config.ConfigRepository
import com.blockproxy.android.config.DataStoreConfigDataSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.util.Locale

data class NetworkInfo(
    val localIp: String = "-",
    val publicIp: String = "-",
    val serverIp: String = "-",
    val macAddress: String = "-",
    val subnetMask: String = "-",
    val gateway: String = "-",
    val dns: String = "-",
    val networkType: String = "-",
    val ssid: String = "-",
)

/**
 * Collects device network information for display in the UI.
 *
 * Uses ConnectivityManager / WifiManager APIs (all available on API 23+).
 * Public IP is fetched via HTTPS to ipify.org.
 */
class NetworkInfoManager(private val context: Context) {

    suspend fun refresh(): NetworkInfo = withContext(Dispatchers.IO) {
        val connectivityManager =
            context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager

        val network = connectivityManager?.activeNetwork
        val capabilities = network?.let { connectivityManager.getNetworkCapabilities(it) }
        val linkProps = network?.let { connectivityManager.getLinkProperties(it) }

        // Network type
        val networkType = when {
            capabilities == null -> "无网络"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "WiFi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "移动数据"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "以太网"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH) -> "蓝牙"
            else -> "其他"
        }

        // Local IP from NetworkInterface (most accurate, works for all transport types)
        val localIp = getLocalIpFromInterface()
            ?: linkProps?.linkAddresses
                ?.firstOrNull { it.address is Inet4Address }
                ?.address?.hostAddress ?: "-"

        // Subnet mask from NetworkInterface
        val subnetMask = getSubnetMaskFromInterface(localIp)
            ?: getSubnetMaskFromDhcp() ?: "-"

        // Gateway from DHCP / LinkProperties
        val gateway = getGatewayFromLinkProps(linkProps)
            ?: getGatewayFromDhcp() ?: "-"

        // DNS from LinkProperties (API 23+)
        val dns = linkProps?.dnsServers
            ?.filterIsInstance<Inet4Address>()
            ?.joinToString(", ") { it.hostAddress ?: "" }
            ?: getDnsFromDhcp() ?: "-"

        // MAC address from NetworkInterface
        val macAddress = getMacAddress() ?: "-"

        // WiFi SSID (requires ACCESS_FINE_LOCATION on API 23+)
        val ssid = getWifiSsid() ?: "-"

        // Public IP (best-effort HTTP call)
        val publicIp = try {
            fetchPublicIp()
        } catch (_: Exception) {
            "-"
        }

        // Server IP (resolve from configured server host)
        val serverIp = try {
            val configRepo = ConfigRepository(DataStoreConfigDataSource(context))
            val config = configRepo.observe().first()
            if (config != null) {
                resolveServerIp(config.serverHost)
            } else {
                "-"
            }
        } catch (_: Exception) {
            "-"
        }

        NetworkInfo(
            localIp = localIp,
            publicIp = publicIp,
            serverIp = serverIp,
            macAddress = macAddress,
            subnetMask = subnetMask,
            gateway = gateway,
            dns = dns,
            networkType = networkType,
            ssid = ssid,
        )
    }

    // ── Private helpers ──────────────────────────────────────────────

    private fun getLocalIpFromInterface(): String? {
        return try {
            NetworkInterface.getNetworkInterfaces()?.toList()
                ?.filter { it.isUp && !it.isLoopback && !it.isVirtual }
                ?.flatMap { it.inetAddresses.toList() }
                ?.firstOrNull { it is Inet4Address && !it.isLoopbackAddress }
                ?.hostAddress
        } catch (_: Exception) {
            null
        }
    }

    private fun getSubnetMaskFromInterface(localIp: String): String? {
        return try {
            NetworkInterface.getNetworkInterfaces()?.toList()
                ?.filter { it.isUp && !it.isLoopback }
                ?.flatMap { iface ->
                    iface.interfaceAddresses.map { addr -> iface to addr }
                }
                ?.firstOrNull { (_, addr) ->
                    addr.address is Inet4Address && addr.address.hostAddress == localIp
                }
                ?.let { (_, addr) ->
                    val prefixLen = addr.networkPrefixLength.toInt()
                    val mask = (0xFFFFFFFF shl (32 - prefixLen)).toInt()
                    "%d.%d.%d.%d".format(
                        (mask shr 24) and 0xFF,
                        (mask shr 16) and 0xFF,
                        (mask shr 8) and 0xFF,
                        mask and 0xFF,
                    )
                }
        } catch (_: Exception) {
            null
        }
    }

    private fun getMacAddress(): String? {
        return try {
            val localIp = getLocalIpFromInterface() ?: return null
            NetworkInterface.getNetworkInterfaces()?.toList()
                ?.filter { it.isUp && !it.isLoopback }
                ?.flatMap { iface ->
                    iface.inetAddresses.toList().map { addr -> iface to addr }
                }
                ?.firstOrNull { (_, addr) ->
                    addr is Inet4Address && addr.hostAddress == localIp
                }
                ?.first?.hardwareAddress
                ?.joinToString(":") { String.format(Locale.US, "%02X", it) }
        } catch (_: Exception) {
            null
        }
    }

    private fun getGatewayFromLinkProps(
        linkProps: android.net.LinkProperties?,
    ): String? {
        // LinkProperties doesn't directly expose gateway on API 23,
        // fall back to DHCP info
        return getGatewayFromDhcp()
    }

    @Suppress("DEPRECATION")
    private fun getGatewayFromDhcp(): String? {
        return try {
            val wifiManager =
                context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val dhcp = wifiManager?.dhcpInfo ?: return null
            if (dhcp.gateway == 0) return null
            intToIp(dhcp.gateway)
        } catch (_: Exception) {
            null
        }
    }

    @Suppress("DEPRECATION")
    private fun getSubnetMaskFromDhcp(): String? {
        return try {
            val wifiManager =
                context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val dhcp = wifiManager?.dhcpInfo ?: return null
            if (dhcp.netmask == 0) return null
            intToIp(dhcp.netmask)
        } catch (_: Exception) {
            null
        }
    }

    @Suppress("DEPRECATION")
    private fun getDnsFromDhcp(): String? {
        return try {
            val wifiManager =
                context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val dhcp = wifiManager?.dhcpInfo ?: return null
            val dns1 = if (dhcp.dns1 != 0) intToIp(dhcp.dns1) else null
            val dns2 = if (dhcp.dns2 != 0) intToIp(dhcp.dns2) else null
            listOfNotNull(dns1, dns2).takeIf { it.isNotEmpty() }?.joinToString(", ")
        } catch (_: Exception) {
            null
        }
    }

    private fun getWifiSsid(): String? {
        return try {
            val wifiManager =
                context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            @Suppress("DEPRECATION")
            val info = wifiManager?.connectionInfo ?: return null
            val ssid = info.ssid ?: return null
            // Remove surrounding quotes from SSID string
            ssid.removePrefix("\"").removeSuffix("\"").takeIf { it != "<unknown ssid>" }
        } catch (_: Exception) {
            null
        }
    }

    private suspend fun fetchPublicIp(): String {
        val client = okhttp3.OkHttpClient.Builder()
            .connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
            .build()
        val request = okhttp3.Request.Builder()
            .url("https://api.ipify.org")
            .build()
        return client.newCall(request).execute().use { response ->
            if (response.isSuccessful) response.body?.string()?.trim() ?: "-" else "-"
        }
    }

    private fun resolveServerIp(host: String): String {
        return try {
            val addresses = InetAddress.getAllByName(host)
            addresses.firstOrNull { it is Inet4Address }?.hostAddress
                ?: addresses.firstOrNull()?.hostAddress
                ?: "-"
        } catch (_: Exception) {
            "-"
        }
    }

    private fun intToIp(ip: Int): String =
        "%d.%d.%d.%d".format(
            ip and 0xFF,
            (ip shr 8) and 0xFF,
            (ip shr 16) and 0xFF,
            (ip shr 24) and 0xFF,
        )
}
