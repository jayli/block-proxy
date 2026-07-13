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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.blockproxy.android.util.NetworkInfo

/**
 * Displays local network information in a card below the status card.
 *
 * This is a pure display component. The parent manages the data and refresh logic.
 *
 * @param networkInfo The current network information to display
 * @param isLoading Whether the network info is currently being loaded
 * @param onRefresh Called when the user taps the refresh button
 */
@Composable
fun NetworkInfoCard(
    networkInfo: NetworkInfo,
    isLoading: Boolean,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            // Header with refresh button
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 16.dp, top = 8.dp, end = 8.dp, bottom = 8.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "网络信息",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(
                    onClick = onRefresh,
                    enabled = !isLoading,
                    modifier = Modifier.height(32.dp),
                ) {
                    if (isLoading) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp),
                            strokeWidth = 2.dp,
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                    }
                    Text(
                        text = "刷新",
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }

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
                NetworkInfoRow(label = "公网 IP", value = networkInfo.publicIp)
                HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                NetworkInfoRow(label = "服务器 IP(from DNS)", value = networkInfo.serverIp)
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
