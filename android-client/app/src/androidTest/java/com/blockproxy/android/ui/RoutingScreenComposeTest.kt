package com.blockproxy.android.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.blockproxy.android.config.RoutingConfig
import com.blockproxy.android.config.RoutingConfigDataSource
import com.blockproxy.android.config.RoutingConfigRepository
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * In-memory fake [RoutingConfigDataSource] for Compose UI tests.
 */
private class UiTestFakeRoutingDataSource : RoutingConfigDataSource {
    private var current: RoutingConfig = RoutingConfig()
    private val listeners = mutableListOf<(RoutingConfig) -> Unit>()

    /** Returns the most recently saved config (for test assertions). */
    fun peek(): RoutingConfig = current

    override fun observe(): Flow<RoutingConfig> = callbackFlow {
        trySend(current)
        val listener: (RoutingConfig) -> Unit = { trySend(it) }
        listeners.add(listener)
        awaitClose { listeners.remove(listener) }
    }

    override suspend fun save(config: RoutingConfig) {
        current = config
        listeners.toList().forEach { it(config) }
    }

    override suspend fun clear() {
        current = RoutingConfig()
        listeners.toList().forEach { it(current) }
    }
}

/**
 * Instrumented Compose UI tests for [RoutingScreen].
 *
 * Requires a device or emulator. Run with:
 * `./gradlew :app:connectedDebugAndroidTest --tests "RoutingScreenComposeTest"`
 */
@RunWith(AndroidJUnit4::class)
class RoutingScreenComposeTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    private fun createViewModel(
        initial: RoutingConfig = RoutingConfig()
    ): Pair<RoutingViewModel, UiTestFakeRoutingDataSource> {
        val dataSource = UiTestFakeRoutingDataSource().also {
            // Pre-populate so the initial Flow emission carries [initial].
            kotlinx.coroutines.runBlocking { it.save(initial) }
        }
        val repository = RoutingConfigRepository(dataSource)
        return RoutingViewModel(repository) to dataSource
    }

    // ── Title ──────────────────────────────────────────────────────────────

    @Test
    fun showsTitleAndBackButton() {
        val (vm, _) = createViewModel()
        var backClicked = false

        composeTestRule.setContent {
            RoutingScreen(viewModel = vm, onNavigateBack = { backClicked = true })
        }

        composeTestRule.onNodeWithText("路由规则").assertIsDisplayed()
        composeTestRule.onNodeWithContentDescription("返回").performClick()
        assertTrue(backClicked)
    }

    // ── Switch ──────────────────────────────────────────────────────────────

    @Test
    fun disabledRouting_hidesTabsAndShowsHint() {
        val (vm, _) = createViewModel(RoutingConfig(enabled = false))

        composeTestRule.setContent {
            RoutingScreen(viewModel = vm, onNavigateBack = {})
        }

        composeTestRule.onNodeWithText("启用分流").assertIsDisplayed()
        composeTestRule.onNodeWithText("所有流量通过代理").assertIsDisplayed()
        composeTestRule.onNodeWithText("直连规则").assertDoesNotExist()
        composeTestRule.onNodeWithText("代理规则").assertDoesNotExist()
    }

    @Test
    fun enabledRouting_showsTabsAndHidesHint() {
        val (vm, _) = createViewModel(RoutingConfig(enabled = true))

        composeTestRule.setContent {
            RoutingScreen(viewModel = vm, onNavigateBack = {})
        }

        composeTestRule.onNodeWithText("启用分流").assertIsDisplayed()
        composeTestRule.onNodeWithText("所有流量通过代理").assertDoesNotExist()
        composeTestRule.onNodeWithText("直连规则").assertIsDisplayed()
        composeTestRule.onNodeWithText("代理规则").assertIsDisplayed()
    }

    @Test
    fun togglingSwitch_showsAndHidesTabs() {
        val (vm, _) = createViewModel(RoutingConfig(enabled = false))

        composeTestRule.setContent {
            RoutingScreen(viewModel = vm, onNavigateBack = {})
        }

        // Switch is off → no tabs
        composeTestRule.onNodeWithText("直连规则").assertDoesNotExist()

        // Click the switch on
        composeTestRule.onNodeWithText("启用分流").performClick()
        composeTestRule.waitForIdle()

        composeTestRule.onNodeWithText("直连规则").assertIsDisplayed()

        // Click the switch off again
        composeTestRule.onNodeWithText("启用分流").performClick()
        composeTestRule.waitForIdle()

        composeTestRule.onNodeWithText("直连规则").assertDoesNotExist()
    }

    // ── Tabs ────────────────────────────────────────────────────────────────

    @Test
    fun directTab_isDefaultSelection() {
        val (vm, _) = createViewModel(RoutingConfig(enabled = true))

        composeTestRule.setContent {
            RoutingScreen(viewModel = vm, onNavigateBack = {})
        }

        // The direct rules editor should be visible by default
        composeTestRule.onNodeWithText("直连规则").assertIsDisplayed()
        // The hint for direct rules should appear
        composeTestRule.onNodeWithText("匹配的流量将绕过代理，直接连接目标服务器")
            .assertIsDisplayed()
    }

    @Test
    fun switchingToProxyTab_showsProxyEditor() {
        val (vm, _) = createViewModel(RoutingConfig(enabled = true))

        composeTestRule.setContent {
            RoutingScreen(viewModel = vm, onNavigateBack = {})
        }

        // Click proxy tab
        composeTestRule.onNodeWithText("代理规则").performClick()
        composeTestRule.waitForIdle()

        composeTestRule.onNodeWithText("匹配的流量将通过代理隧道转发")
            .assertIsDisplayed()
    }

    // ── Save button ─────────────────────────────────────────────────────────

    @Test
    fun saveButton_showsSaveByDefault() {
        val (vm, _) = createViewModel()

        composeTestRule.setContent {
            RoutingScreen(viewModel = vm, onNavigateBack = {})
        }

        composeTestRule.onNodeWithText("保存").assertIsDisplayed().assertIsEnabled()
    }

    @Test
    fun saveButton_showsSavedAfterClick() {
        val (vm, _) = createViewModel()

        composeTestRule.setContent {
            RoutingScreen(viewModel = vm, onNavigateBack = {})
        }

        composeTestRule.onNodeWithText("保存").performClick()
        composeTestRule.waitForIdle()

        composeTestRule.onNodeWithText("已保存").assertIsDisplayed()
    }

    @Test
    fun saveButton_persistsConfigToRepository() {
        val (vm, dataSource) = createViewModel()

        composeTestRule.setContent {
            RoutingScreen(viewModel = vm, onNavigateBack = {})
        }

        // Enable routing, then save
        composeTestRule.onNodeWithText("启用分流").performClick()
        composeTestRule.waitForIdle()

        composeTestRule.onNodeWithText("保存").performClick()
        composeTestRule.waitForIdle()

        val saved = dataSource.peek()
        assertTrue(saved.enabled)
    }

    // ── ConfigScreen entry point ────────────────────────────────────────────

    @Test
    fun configScreen_showsRoutingSection_disabled() {
        composeTestRule.setContent {
            ConfigScreen(
                config = ConfigUiState(),
                batteryExempted = true,
                onNavigateBack = {},
                onUpdateHost = {},
                onUpdatePort = {},
                onUpdateUseTls = {},
                onUpdateAllowInsecure = {},
                onUpdateUsername = {},
                onUpdatePassword = {},
                onSave = {},
                onBatterySettingsClick = {},
                routingEnabled = false,
                onNavigateToRouting = {},
            )
        }

        composeTestRule.onNodeWithText("路由规则").assertIsDisplayed()
        composeTestRule.onNodeWithText("分流规则").assertIsDisplayed()
        composeTestRule.onNodeWithText("未启用（全部走代理）").assertIsDisplayed()
    }

    @Test
    fun configScreen_showsRoutingSection_enabled() {
        composeTestRule.setContent {
            ConfigScreen(
                config = ConfigUiState(),
                batteryExempted = true,
                onNavigateBack = {},
                onUpdateHost = {},
                onUpdatePort = {},
                onUpdateUseTls = {},
                onUpdateAllowInsecure = {},
                onUpdateUsername = {},
                onUpdatePassword = {},
                onSave = {},
                onBatterySettingsClick = {},
                routingEnabled = true,
                onNavigateToRouting = {},
            )
        }

        composeTestRule.onNodeWithText("路由规则").assertIsDisplayed()
        composeTestRule.onNodeWithText("已启用").assertIsDisplayed()
    }

    @Test
    fun configScreen_routingConfigureButton_triggersNavigation() {
        var navigated = false
        composeTestRule.setContent {
            ConfigScreen(
                config = ConfigUiState(),
                batteryExempted = true,
                onNavigateBack = {},
                onUpdateHost = {},
                onUpdatePort = {},
                onUpdateUseTls = {},
                onUpdateAllowInsecure = {},
                onUpdateUsername = {},
                onUpdatePassword = {},
                onSave = {},
                onBatterySettingsClick = {},
                routingEnabled = false,
                onNavigateToRouting = { navigated = true },
            )
        }

        composeTestRule.onNodeWithText("配置").performClick()
        assertTrue(navigated)
    }
}
