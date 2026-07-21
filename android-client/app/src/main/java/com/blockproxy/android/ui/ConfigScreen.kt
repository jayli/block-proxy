package com.blockproxy.android.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Route
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.blockproxy.android.cdn.CfCdnConfig
import com.blockproxy.android.util.TlsTestResult
import kotlinx.coroutines.delay

/**
 * Configuration screen for editing server connection settings and credentials.
 *
 * @param config Current config UI state
 * @param batteryExempted Whether battery optimization exemption is granted
 * @param onNavigateToHome Called when the user taps the back arrow
 * @param onUpdateHost Called when the host field changes
 * @param onUpdatePort Called when the port field changes
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
    onNavigateToHome: () -> Unit,
    onUpdateHost: (String) -> Unit,
    onUpdatePort: (String) -> Unit,
    onUpdateUsername: (String) -> Unit,
    onUpdatePassword: (String) -> Unit,
    onUpdateCfCdnEnabled: (Boolean) -> Unit,
    onRefreshCfIpPool: () -> Unit,
    cfIpRefreshState: CfIpRefreshState,
    connectionTestState: ConnectionTestState,
    onTestConnection: () -> Unit,
    onDismissConnectionTest: () -> Unit,
    onSave: () -> Unit,
    onBatterySettingsClick: () -> Unit,
    routingEnabled: Boolean,
    onNavigateToRouting: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var passwordVisible by remember { mutableStateOf(false) }
    var saveCount by remember { mutableIntStateOf(0) }
    var showSaved by remember { mutableStateOf(false) }
    val cfPortSupported = !config.cfCdnEnabled ||
        config.port.toIntOrNull() in CfCdnConfig.HTTPS_PORTS

    LaunchedEffect(saveCount) {
        if (saveCount > 0) {
            showSaved = true
            delay(2000)
            showSaved = false
        }
    }

    Box(modifier = modifier.fillMaxSize()) {
        Scaffold(
            modifier = Modifier.fillMaxSize(),
            topBar = {
                TopAppBar(
                    title = { Text("配置") },
                    navigationIcon = {
                        IconButton(onClick = onNavigateToHome) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回首页")
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
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "服务器设置",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
                TextButton(
                    onClick = onTestConnection,
                    enabled = connectionTestState !is ConnectionTestState.Testing,
                ) {
                    if (connectionTestState is ConnectionTestState.Testing) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp),
                            strokeWidth = 2.dp,
                        )
                        Spacer(modifier = Modifier.width(4.dp))
                    }
                    Text("测试")
                }
            }

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

            Spacer(modifier = Modifier.height(8.dp))

            Text(
                text = "连接 CDN 设置",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary,
            )

            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant,
                ),
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = "使用 Cloudflare CDN",
                                style = MaterialTheme.typography.titleSmall,
                            )
                            Text(
                                text = "NAT 轮换时同步轮换 CF 边缘 IP",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Switch(
                            checked = config.cfCdnEnabled,
                            onCheckedChange = onUpdateCfCdnEnabled,
                        )
                    }

                    if (config.cfCdnEnabled && !cfPortSupported) {
                        Text(
                            text = "CF CDN 模式仅支持 HTTPS 代理端口：443、2053、2083、2087、2096、8443",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }

                    AnimatedVisibility(visible = config.cfCdnEnabled) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            OutlinedButton(
                                onClick = onRefreshCfIpPool,
                                enabled = cfIpRefreshState !is CfIpRefreshState.Refreshing &&
                                    cfPortSupported,
                            ) {
                                if (cfIpRefreshState is CfIpRefreshState.Refreshing) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(16.dp),
                                        strokeWidth = 2.dp,
                                    )
                                    Spacer(modifier = Modifier.width(8.dp))
                                }
                                Text("刷新 CF IP 池")
                            }

                            when (val state = cfIpRefreshState) {
                                is CfIpRefreshState.Refreshing -> {
                                    Text(
                                        text = if (state.total > 0) {
                                            "${state.tested}/${state.total}"
                                        } else {
                                            "刷新中"
                                        },
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                is CfIpRefreshState.Done -> {
                                    Text(
                                        text = if (state.appliedToRunningTunnel) {
                                            "已刷新 ${state.count} 个，已应用"
                                        } else {
                                            "已刷新 ${state.count} 个，下次启动生效"
                                        },
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.primary,
                                    )
                                }
                                is CfIpRefreshState.Error -> {
                                    Text(
                                        text = state.message,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.error,
                                    )
                                }
                                CfIpRefreshState.Idle -> Unit
                            }
                        }
                    }
                }
            }

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
                            text = if (routingEnabled) {
                                "已启用；直连白名单→代理白名单→默认直连"
                            } else {
                                "未启用；全局代理默认关闭，手机流量默认直连"
                            },
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
            Button(
                onClick = {
                    onSave()
                    saveCount++
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = config.host.isNotBlank() &&
                    config.port.toIntOrNull() in 1..65535 &&
                    cfPortSupported &&
                    config.username.isNotBlank() &&
                    config.password.isNotBlank(),
            ) {
                Text("保存")
            }

            Spacer(modifier = Modifier.height(16.dp))
        }
        }

        AnimatedVisibility(
            visible = showSaved,
            modifier = Modifier.align(Alignment.Center),
            enter = fadeIn(),
            exit = fadeOut(),
        ) {
            Box(
                modifier = Modifier
                    .background(
                        color = Color(0xFF424242),
                        shape = RoundedCornerShape(8.dp),
                    )
                    .padding(horizontal = 24.dp, vertical = 12.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "保存成功",
                    color = Color.White,
                    style = MaterialTheme.typography.labelLarge,
                )
            }
        }

        // 连接测试结果对话框
        when (val testState = connectionTestState) {
            is ConnectionTestState.Success -> ConnectionTestResultDialog(
                result = testState.result,
                onDismiss = onDismissConnectionTest,
            )
            is ConnectionTestState.Error -> AlertDialog(
                onDismissRequest = onDismissConnectionTest,
                title = { Text("测试失败") },
                text = { Text(testState.message) },
                confirmButton = {
                    TextButton(onClick = onDismissConnectionTest) {
                        Text("确定")
                    }
                },
            )
            else -> Unit
        }
    }
}

/**
 * 从证书 DN 字符串中提取 CN 值。
 * 例如 "CN=BlockProxy, O=BlockProxy" → "BlockProxy"
 */
private fun extractCn(dn: String): String {
    val cnMatch = Regex("CN\\s*=\\s*([^,]+)").find(dn)
    if (cnMatch != null) return cnMatch.groupValues[1].trim()
    // 回退到 O
    val oMatch = Regex("O\\s*=\\s*([^,]+)").find(dn)
    if (oMatch != null) return "O=${oMatch.groupValues[1].trim()}"
    // 回退到整个 DN
    return dn
}

/**
 * 连接测试成功结果对话框。
 *
 * 显示：连通性、MITM 检测、证书信息、耗时等。
 */
@Composable
private fun ConnectionTestResultDialog(
    result: TlsTestResult,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = if (result.reachable) "测试结果" else "连接失败",
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!result.reachable) {
                    // 不可达
                    ResultRow(
                        label = "连通性",
                        value = "✗ ${result.error ?: "连接失败"}",
                        valueColor = Color(0xFFF44336),
                    )
                    // 直连 IP（CF CDN 模式下显示）
                    result.connectedIp?.let { ip ->
                        ResultRow(
                            label = "直连 IP",
                            value = ip,
                            valueColor = MaterialTheme.colorScheme.onSurface,
                        )
                    }
                } else {
                    // 连通性
                    ResultRow(
                        label = "连通性",
                        value = "✓ 已连通",
                        valueColor = Color(0xFF4CAF50),
                    )

                    // 直连 IP（CF CDN 模式下显示）
                    result.connectedIp?.let { ip ->
                        ResultRow(
                            label = "直连 IP",
                            value = ip,
                            valueColor = MaterialTheme.colorScheme.onSurface,
                        )
                    }

                    // MITM 检测
                    if (result.isMitm) {
                        ResultRow(
                            label = "MITM 检测",
                            value = "⚠ 检测到 MITM",
                            valueColor = Color(0xFFF44336),
                        )
                        result.matchedKeyword?.let { kw ->
                            Text(
                                text = "匹配关键字: $kw",
                                style = MaterialTheme.typography.bodySmall,
                                color = Color(0xFFF44336),
                                modifier = Modifier.padding(start = 8.dp),
                            )
                        }
                    } else {
                        ResultRow(
                            label = "MITM 检测",
                            value = "✓ 未发现",
                            valueColor = Color(0xFF4CAF50),
                        )
                    }

                    // 分隔线
                    Spacer(modifier = Modifier.height(4.dp))

                    // 证书信息
                    Text(
                        text = "证书信息",
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.primary,
                    )

                    ResultRow(
                        label = "Issuer",
                        value = extractCn(result.leafIssuer),
                        valueColor = MaterialTheme.colorScheme.onSurface,
                    )

                    ResultRow(
                        label = "Subject",
                        value = extractCn(result.leafSubject),
                        valueColor = MaterialTheme.colorScheme.onSurface,
                    )

                    ResultRow(
                        label = "自签名",
                        value = if (result.isSelfSigned) "是" else "否",
                        valueColor = MaterialTheme.colorScheme.onSurface,
                    )

                    ResultRow(
                        label = "系统信任",
                        value = if (result.verifyOk) "✓ 是" else "✗ 否",
                        valueColor = if (result.verifyOk) {
                            Color(0xFF4CAF50)
                        } else {
                            Color(0xFFFFC107)
                        },
                    )

                    if (result.certChainSize > 1) {
                        ResultRow(
                            label = "证书链",
                            value = "${result.certChainSize} 个证书",
                            valueColor = MaterialTheme.colorScheme.onSurface,
                        )

                        // 展开证书链（跳过叶子证书，因为已显示）
                        result.chain.drop(1).forEachIndexed { index, cert ->
                            Card(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(start = 8.dp),
                                colors = CardDefaults.cardColors(
                                    containerColor = MaterialTheme.colorScheme.surfaceVariant,
                                ),
                            ) {
                                Column(
                                    modifier = Modifier.padding(8.dp),
                                    verticalArrangement = Arrangement.spacedBy(2.dp),
                                ) {
                                    Text(
                                        text = "CA #${index + 1}",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.primary,
                                    )
                                    Text(
                                        text = extractCn(cert.subject),
                                        style = MaterialTheme.typography.bodySmall,
                                    )
                                    Text(
                                        text = "有效期: ${cert.notBefore} ~ ${cert.notAfter}",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }

                    // 分隔线
                    Spacer(modifier = Modifier.height(4.dp))

                    // 耗时
                    ResultRow(
                        label = "耗时",
                        value = "${result.durationMs} ms",
                        valueColor = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("确定")
            }
        },
    )
}

/**
 * 对话框中的单行结果：标签 + 值。
 */
@Composable
private fun ResultRow(
    label: String,
    value: String,
    valueColor: Color,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium,
            color = valueColor,
        )
    }
}
