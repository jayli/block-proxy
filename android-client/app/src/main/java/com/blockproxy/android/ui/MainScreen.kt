package com.blockproxy.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.blockproxy.android.status.TunnelStatus
import com.blockproxy.android.util.NetworkInfo

/**
 * Main tunnel screen showing status, connect/disconnect controls, and config navigation.
 *
 * @param status Current tunnel status
 * @param isConfigValid Whether a valid config is saved
 * @param batteryExempted Whether battery optimization exemption is granted
 * @param onStart Called when the user taps the connect button
 * @param onStop Called when the user taps the disconnect button
 * @param onBatterySettingsClick Called when the user taps the battery settings link
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(
    status: TunnelStatus,
    isConfigValid: Boolean,
    batteryExempted: Boolean,
    host: String = "",
    port: String = "",
    cfCdnEnabled: Boolean = false,
    currentCfIp: String? = null,
    transportLabel: String? = null,
    isSlideActive: Boolean = false,
    sliderTrackTone: SliderTrackTone = SliderTrackTone.Neutral,
    onSlideActiveChange: (Boolean) -> Unit = {},
    onStart: () -> Unit,
    onStop: () -> Unit,
    onBatterySettingsClick: () -> Unit,
    networkInfo: NetworkInfo = NetworkInfo(),
    isNetworkInfoLoading: Boolean = false,
    onRefreshNetworkInfo: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text("BlockProxy") },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                    titleContentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                ),
            )
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Scrollable content area
            Column(
                modifier = Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                // Status card
                StatusCard(
                    status = status,
                    host = host,
                    port = port,
                    cfCdnEnabled = cfCdnEnabled,
                    currentCfIp = currentCfIp,
                    transportLabel = transportLabel,
                )

                // Network info card
                NetworkInfoCard(
                    networkInfo = networkInfo,
                    isLoading = isNetworkInfoLoading,
                    onRefresh = onRefreshNetworkInfo,
                )

                // Battery warning
                if (!batteryExempted) {
                    BatteryWarningCard(onClick = onBatterySettingsClick)
                }
            }

            // Slide-to-connect button (fixed at bottom)
            SlideButton(
                enabled = isConfigValid,
                isActive = isSlideActive,
                trackTone = sliderTrackTone,
                onActiveChange = onSlideActiveChange,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/**
 * Card displaying the current tunnel status with a colored indicator.
 */
@Composable
private fun StatusCard(
    status: TunnelStatus,
    host: String = "",
    port: String = "",
    cfCdnEnabled: Boolean = false,
    currentCfIp: String? = null,
    transportLabel: String? = null,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusIndicator(status = status)
            Spacer(modifier = Modifier.width(12.dp))
            Column {
                val statusTitle = if (status == TunnelStatus.Connected && !transportLabel.isNullOrBlank()) {
                    "状态 · $transportLabel"
                } else {
                    "状态"
                }
                Text(
                    text = statusTitle,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                val display = if (status == TunnelStatus.Connected) {
                    if (cfCdnEnabled && currentCfIp != null) {
                        "已连接 · $currentCfIp:$port (CF)"
                    } else {
                        "已连接 · $host:$port"
                    }
                } else {
                    status.displayText
                }
                Text(
                    text = display,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Medium,
                )
            }
        }
    }
}

/**
 * Colored dot indicator reflecting the tunnel status.
 */
@Composable
private fun StatusIndicator(status: TunnelStatus) {
    val color = when (status) {
        TunnelStatus.Connected -> Color(0xFF4CAF50) // Green
        TunnelStatus.Connecting, TunnelStatus.Reconnecting, TunnelStatus.Preparing ->
            Color(0xFFFFC107) // Amber
        TunnelStatus.Disconnected -> Color(0xFF9E9E9E) // Grey
        TunnelStatus.Error, TunnelStatus.AuthFailed, TunnelStatus.Occupied ->
            Color(0xFFF44336) // Red
    }

    Box(
        modifier = Modifier
            .size(16.dp)
            .clip(CircleShape)
            .background(color),
    )
}

/**
 * Card warning the user about battery optimization exemption.
 */
@Composable
private fun BatteryWarningCard(onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.errorContainer,
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
        ) {
            Text(
                text = "电池优化未豁免",
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = "系统可能会在后台暂停隧道服务，建议前往设置关闭电池优化。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onErrorContainer,
            )
            Spacer(modifier = Modifier.height(8.dp))
            TextButton(
                onClick = onClick,
                colors = ButtonDefaults.textButtonColors(
                    contentColor = MaterialTheme.colorScheme.error,
                ),
            ) {
                Text("前往设置")
            }
        }
    }
}
