package com.blockproxy.android.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Route
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp

/**
 * Configuration screen for editing server connection settings and credentials.
 *
 * @param config Current config UI state
 * @param batteryExempted Whether battery optimization exemption is granted
 * @param onNavigateBack Called when the user taps the back button or saves
 * @param onUpdateHost Called when the host field changes
 * @param onUpdatePort Called when the port field changes
 * @param onUpdateUseTls Called when the TLS toggle changes
 * @param onUpdateAllowInsecure Called when the allow insecure toggle changes
 * @param onUpdateUsername Called when the username field changes
 * @param onUpdatePassword Called when the password field changes
 * @param onSave Called when the user taps the save button
 * @param onBatterySettingsClick Called when the user taps the battery settings link
 * @param routingEnabled Whether the routing feature is currently enabled
 * @param onNavigateToRouting Called when the user taps the routing "Configure" button
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConfigScreen(
    config: ConfigUiState,
    batteryExempted: Boolean,
    onNavigateBack: () -> Unit,
    onUpdateHost: (String) -> Unit,
    onUpdatePort: (String) -> Unit,
    onUpdateUseTls: (Boolean) -> Unit,
    onUpdateAllowInsecure: (Boolean) -> Unit,
    onUpdateUsername: (String) -> Unit,
    onUpdatePassword: (String) -> Unit,
    onSave: () -> Unit,
    onBatterySettingsClick: () -> Unit,
    routingEnabled: Boolean,
    onNavigateToRouting: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var passwordVisible by remember { mutableStateOf(false) }

    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text("配置") },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
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
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Server settings section
            Text(
                text = "服务器设置",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary,
            )

            OutlinedTextField(
                value = config.host,
                onValueChange = onUpdateHost,
                label = { Text("服务器地址") },
                placeholder = { Text("例如: example.com") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )

            OutlinedTextField(
                value = config.port,
                onValueChange = onUpdatePort,
                label = { Text("端口") },
                placeholder = { Text("8003") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("启用 TLS")
                Switch(
                    checked = config.useTls,
                    onCheckedChange = onUpdateUseTls,
                )
            }

            if (config.useTls) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column {
                        Text("允许不安全证书")
                        Text(
                            text = "接受自签名证书",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        checked = config.allowInsecure,
                        onCheckedChange = onUpdateAllowInsecure,
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Credentials section
            Text(
                text = "认证凭据",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary,
            )

            OutlinedTextField(
                value = config.username,
                onValueChange = onUpdateUsername,
                label = { Text("用户名") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )

            OutlinedTextField(
                value = config.password,
                onValueChange = onUpdatePassword,
                label = { Text("密码") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                visualTransformation = if (passwordVisible) {
                    VisualTransformation.None
                } else {
                    PasswordVisualTransformation()
                },
                trailingIcon = {
                    IconButton(onClick = { passwordVisible = !passwordVisible }) {
                        Icon(
                            imageVector = if (passwordVisible) {
                                Icons.Default.Visibility
                            } else {
                                Icons.Default.VisibilityOff
                            },
                            contentDescription = if (passwordVisible) "隐藏密码" else "显示密码",
                        )
                    }
                },
            )

            Spacer(modifier = Modifier.height(8.dp))

            // ── Routing rules section ───────────────────────────────────────
            Text(
                text = "路由规则",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary,
            )

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
                    Icon(
                        Icons.Default.Route,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                    )
                    Spacer(modifier = Modifier.width(12.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "分流规则",
                            style = MaterialTheme.typography.titleSmall,
                        )
                        Text(
                            text = if (routingEnabled) "已启用" else "未启用（全部走代理）",
                            style = MaterialTheme.typography.bodySmall,
                            color = if (routingEnabled) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                        )
                    }
                    OutlinedButton(onClick = onNavigateToRouting) {
                        Text("配置")
                    }
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Battery optimization section
            Text(
                text = "电池优化",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary,
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("电池优化豁免")
                    Text(
                        text = if (batteryExempted) "已豁免" else "未豁免",
                        style = MaterialTheme.typography.bodySmall,
                        color = if (batteryExempted) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.error
                        },
                    )
                }
                OutlinedButton(onClick = onBatterySettingsClick) {
                    Text("前往设置")
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Auto-start guidance
            Text(
                text = "自启动指南",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary,
            )

            Text(
                text = "部分厂商的系统会限制后台应用自启动。" +
                    "如果连接经常断开，请参考 dontkillmyapp.com 配置自启动权限。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            TextButton(
                onClick = {
                    val intent = Intent(Intent.ACTION_VIEW).apply {
                        data = Uri.parse("https://dontkillmyapp.com/")
                    }
                    context.startActivity(intent)
                },
            ) {
                Text("访问 dontkillmyapp.com")
            }

            Spacer(modifier = Modifier.height(16.dp))

            // Save button
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedButton(
                    onClick = onNavigateBack,
                    modifier = Modifier.weight(1f),
                ) {
                    Text("取消")
                }
                Button(
                    onClick = {
                        onSave()
                        onNavigateBack()
                    },
                    modifier = Modifier.weight(1f),
                    enabled = config.host.isNotBlank() &&
                        config.port.toIntOrNull() in 1..65535 &&
                        config.username.isNotBlank() &&
                        config.password.isNotBlank(),
                ) {
                    Text("保存")
                }
            }

            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}
