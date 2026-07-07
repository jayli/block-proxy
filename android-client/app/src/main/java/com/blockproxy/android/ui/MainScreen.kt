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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.blockproxy.android.status.TunnelStatus

/**
 * Main tunnel screen showing status, connect/disconnect controls, and config navigation.
 *
 * @param status Current tunnel status
 * @param isConfigValid Whether a valid config is saved
 * @param batteryExempted Whether battery optimization exemption is granted
 * @param onStart Called when the user taps the connect button
 * @param onStop Called when the user taps the disconnect button
 * @param onNavigateToConfig Called when the user taps the config button
 * @param onBatterySettingsClick Called when the user taps the battery settings link
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(
    status: TunnelStatus,
    isConfigValid: Boolean,
    batteryExempted: Boolean,
    onStart: () -> Unit,
    onStop: () -> Unit,
    onNavigateToConfig: () -> Unit,
    onBatterySettingsClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var showBatteryDialog by remember { mutableStateOf(false) }

    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text("BlockProxy") },
                actions = {
                    IconButton(onClick = onNavigateToConfig) {
                        Icon(Icons.Default.Settings, contentDescription = "配置")
                    }
                },
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
            // Status card
            StatusCard(status = status)

            // Battery warning
            if (!batteryExempted) {
                BatteryWarningCard(onClick = onBatterySettingsClick)
            }

            Spacer(modifier = Modifier.weight(1f))

            // Connect / Disconnect button
            val isConnected = status == TunnelStatus.Connected ||
                status == TunnelStatus.Connecting ||
                status == TunnelStatus.Reconnecting ||
                status == TunnelStatus.Preparing

            if (isConnected) {
                Button(
                    onClick = onStop,
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                    ),
                ) {
                    Text("断开")
                }
            } else {
                Button(
                    onClick = {
                        if (!batteryExempted) {
                            showBatteryDialog = true
                        } else {
                            onStart()
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = isConfigValid,
                ) {
                    Text("连接")
                }
                if (!isConfigValid) {
                    Text(
                        text = "请先完成配置",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                        modifier = Modifier.align(Alignment.CenterHorizontally),
                    )
                }
            }
        }
    }

    // Battery warning dialog
    if (showBatteryDialog) {
        AlertDialog(
            onDismissRequest = { showBatteryDialog = false },
            title = { Text("电池优化警告") },
            text = {
                Text(
                    "BlockProxy 未获得电池优化豁免权限。" +
                        "系统可能会在后台暂停隧道服务，导致连接中断。" +
                        "建议在系统设置中手动关闭 BlockProxy 的电池优化。"
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showBatteryDialog = false
                    onBatterySettingsClick()
                }) {
                    Text("前往设置")
                }
            },
            dismissButton = {
                TextButton(onClick = {
                    showBatteryDialog = false
                    onStart()
                }) {
                    Text("继续连接")
                }
            },
        )
    }
}

/**
 * Card displaying the current tunnel status with a colored indicator.
 */
@Composable
private fun StatusCard(status: TunnelStatus) {
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
                Text(
                    text = "状态",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = status.displayText,
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
