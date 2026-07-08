package com.blockproxy.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.TabRowDefaults
import androidx.compose.material3.TabRowDefaults.tabIndicatorOffset
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Routing configuration screen: toggle routing on/off and edit direct/proxy
 * rule lists in a tabbed multi-line text editor.
 *
 * @param viewModel Provides [RoutingUiState] and mutators.
 * @param onNavigateBack Called when the user taps the back button.
 * @param modifier Optional modifier applied to the root [Scaffold].
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RoutingScreen(
    viewModel: RoutingViewModel,
    onNavigateBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.uiState.collectAsState()

    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text("路由规则") },
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
            // ── Enable switch ───────────────────────────────────────────────
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "启用分流",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        text = if (state.enabled) {
                            "根据规则决定流量走向"
                        } else {
                            "所有流量通过代理"
                        },
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(
                    checked = state.enabled,
                    onCheckedChange = viewModel::updateEnabled,
                )
            }

            // ── Tabs + rule editors (only when enabled) ─────────────────────
            if (state.enabled) {
                Spacer(modifier = Modifier.height(4.dp))

                val tabs = listOf("直连规则", "代理规则")
                TabRow(
                    selectedTabIndex = state.selectedTab,
                    indicator = { positions ->
                        if (state.selectedTab < positions.size) {
                            TabRowDefaults.SecondaryIndicator(
                                modifier = Modifier.tabIndicatorOffset(
                                    positions[state.selectedTab]
                                )
                            )
                        }
                    },
                ) {
                    tabs.forEachIndexed { index, title ->
                        Tab(
                            selected = state.selectedTab == index,
                            onClick = { viewModel.selectTab(index) },
                            text = { Text(title) },
                        )
                    }
                }

                // Tab content
                when (state.selectedTab) {
                    0 -> RulesEditor(
                        text = state.directRulesText,
                        onTextChange = viewModel::updateDirectRules,
                        placeholder = "domain:example.com\ngeosite:cn\nip:192.168.0.0/16",
                        label = "直连规则",
                        hint = "匹配的流量将绕过代理，直接连接目标服务器",
                    )

                    1 -> RulesEditor(
                        text = state.proxyRulesText,
                        onTextChange = viewModel::updateProxyRules,
                        placeholder = "domain:google.com\ngeosite:youtube\ngeosite:telegram",
                        label = "代理规则",
                        hint = "匹配的流量将通过代理隧道转发",
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // ── Save button ─────────────────────────────────────────────────
            Button(
                onClick = {
                    viewModel.save()
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (state.isSaved) {
                    Icon(Icons.Default.Check, contentDescription = null)
                    Spacer(modifier = Modifier.padding(start = 4.dp))
                    Text("已保存")
                } else {
                    Text("保存")
                }
            }

            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}

/**
 * Multi-line text editor for one list of routing rules.
 */
@Composable
private fun RulesEditor(
    text: String,
    onTextChange: (String) -> Unit,
    placeholder: String,
    label: String,
    hint: String,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = text,
            onValueChange = onTextChange,
            label = { Text(label) },
            placeholder = { Text(placeholder) },
            modifier = Modifier
                .fillMaxWidth()
                .height(220.dp),
            maxLines = Int.MAX_VALUE,
        )
        Text(
            text = hint,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
