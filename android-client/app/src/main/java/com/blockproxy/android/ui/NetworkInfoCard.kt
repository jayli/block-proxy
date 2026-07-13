package com.blockproxy.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.blockproxy.android.util.NetworkInfo
import com.blockproxy.android.util.NetworkInfoManager
import kotlinx.coroutines.launch

/**
 * Displays local network information in a card below the status card.
 *
 * Auto-refreshes when the composable enters composition.
 * Public IP can be manually refreshed via the icon button.
 */
@Composable
fun NetworkInfoCard(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val manager = remember { NetworkInfoManager(context) }
    var networkInfo by remember { mutableStateOf(NetworkInfo()) }
    var isLoading by remember { mutableStateOf(true) }
    var isPublicIpLoading by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    // Initial load
    LaunchedEffect(Unit) {
        isLoading = true
        networkInfo = manager.refresh()
        isLoading = false
    }

    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            // Header
            Text(
                text = "网络信息",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(
                    start = 16.dp,
                    top = 12.dp,
                    end = 16.dp,
                    bottom = 8.dp
                )
            )

            if (isLoading) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(24.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp))
                    Spacer(modifier = Modifier.width(12.dp))
                    Text(
                        text = "获取网络信息...",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            } else {
                NetworkInfoRow(label = "本机 IP", value = networkInfo.localIp)
                HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                PublicIpRow(
                    value = networkInfo.publicIp,
                    isRefreshing = isPublicIpLoading,
                    onRefresh = {
                        scope.launch {
                            isPublicIpLoading = true
                            networkInfo = networkInfo.copy(publicIp = "-")
                            networkInfo = manager.refresh()
                            isPublicIpLoading = false
                        }
                    }
                )
                HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                NetworkInfoRow(label = "服务器 IP", value = networkInfo.serverIp)
                HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                NetworkInfoRow(label = "MAC 地址", value = networkInfo.macAddress)
                HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                NetworkInfoRow(label = "子网掩码", value = networkInfo.subnetMask)
                HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                NetworkInfoRow(label = "网关", value = networkInfo.gateway)
                HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                NetworkInfoRow(label = "DNS", value = networkInfo.dns)
                HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                NetworkInfoRow(label = "网络类型", value = networkInfo.networkType)
                if (networkInfo.ssid != "-") {
                    HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                    NetworkInfoRow(label = "WiFi", value = networkInfo.ssid)
                }
                Spacer(modifier = Modifier.height(8.dp))
            }
        }
    }
}

@Composable
private fun NetworkInfoRow(label: String, value: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            color = MaterialTheme.colorScheme.onSurface
        )
    }
}

@Composable
private fun PublicIpRow(
    value: String,
    isRefreshing: Boolean,
    onRefresh: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = "公网 IP",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (isRefreshing) {
                CircularProgressIndicator(
                    modifier = Modifier.size(14.dp),
                    strokeWidth = 2.dp
                )
                Spacer(modifier = Modifier.width(8.dp))
            }
            Text(
                text = value,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurface
            )
            IconButton(onClick = onRefresh, modifier = Modifier.size(32.dp)) {
                Icon(
                    imageVector = Icons.Default.Refresh,
                    contentDescription = "刷新公网 IP",
                    modifier = Modifier.size(16.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}
