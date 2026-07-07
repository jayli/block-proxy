package com.blockproxy.android.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.blockproxy.android.status.TunnelStatus
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumentation tests for [MainScreen] and [ConfigScreen] composables.
 *
 * These tests require a device or emulator to run.
 * Execute with: `./gradlew :app:connectedDebugAndroidTest`
 */
@RunWith(AndroidJUnit4::class)
class MainScreenTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun mainScreen_emptyConfig_disablesStartButton() {
        composeTestRule.setContent {
            MainScreen(
                status = TunnelStatus.Disconnected,
                isConfigValid = false,
                batteryExempted = true,
                onStart = {},
                onStop = {},
                onNavigateToConfig = {},
                onBatterySettingsClick = {},
            )
        }

        // The connect button should be disabled when config is not valid
        composeTestRule.onNodeWithText("连接")
            .assertIsDisplayed()
            .assertIsNotEnabled()

        // Should show a hint about completing config
        composeTestRule.onNodeWithText("请先完成配置")
            .assertIsDisplayed()
    }

    @Test
    fun mainScreen_savedConfig_enablesStartButton() {
        composeTestRule.setContent {
            MainScreen(
                status = TunnelStatus.Disconnected,
                isConfigValid = true,
                batteryExempted = true,
                onStart = {},
                onStop = {},
                onNavigateToConfig = {},
                onBatterySettingsClick = {},
            )
        }

        // The connect button should be enabled when config is valid
        composeTestRule.onNodeWithText("连接")
            .assertIsDisplayed()
            .assertIsEnabled()
    }

    @Test
    fun mainScreen_connectedStatus_showsDisconnectButton() {
        composeTestRule.setContent {
            MainScreen(
                status = TunnelStatus.Connected,
                isConfigValid = true,
                batteryExempted = true,
                onStart = {},
                onStop = {},
                onNavigateToConfig = {},
                onBatterySettingsClick = {},
            )
        }

        // Should show disconnect button instead of connect
        composeTestRule.onNodeWithText("断开")
            .assertIsDisplayed()
            .assertIsEnabled()
    }

    @Test
    fun mainScreen_connectingStatus_showsDisconnectButton() {
        composeTestRule.setContent {
            MainScreen(
                status = TunnelStatus.Connecting,
                isConfigValid = true,
                batteryExempted = true,
                onStart = {},
                onStop = {},
                onNavigateToConfig = {},
                onBatterySettingsClick = {},
            )
        }

        // Should show disconnect button when connecting
        composeTestRule.onNodeWithText("断开")
            .assertIsDisplayed()
            .assertIsEnabled()
    }

    @Test
    fun mainScreen_statusText_reflectsStatus() {
        val testCases = listOf(
            TunnelStatus.Disconnected to "已断开",
            TunnelStatus.Connecting to "正在连接...",
            TunnelStatus.Connected to "已连接",
            TunnelStatus.Reconnecting to "重连中",
            TunnelStatus.Error to "错误",
            TunnelStatus.AuthFailed to "认证失败",
            TunnelStatus.Occupied to "端口被占用",
            TunnelStatus.Preparing to "准备中",
        )

        for ((status, expectedText) in testCases) {
            composeTestRule.setContent {
                MainScreen(
                    status = status,
                    isConfigValid = true,
                    batteryExempted = true,
                    onStart = {},
                    onStop = {},
                    onNavigateToConfig = {},
                    onBatterySettingsClick = {},
                )
            }

            composeTestRule.onNodeWithText(expectedText)
                .assertIsDisplayed()

            composeTestRule.setContent { } // Clear for next iteration
        }
    }

    @Test
    fun mainScreen_batteryNotExempted_showsWarningCard() {
        composeTestRule.setContent {
            MainScreen(
                status = TunnelStatus.Disconnected,
                isConfigValid = true,
                batteryExempted = false,
                onStart = {},
                onStop = {},
                onNavigateToConfig = {},
                onBatterySettingsClick = {},
            )
        }

        // Should show battery warning card
        composeTestRule.onNodeWithText("电池优化未豁免")
            .assertIsDisplayed()
    }

    @Test
    fun mainScreen_batteryExempted_noWarningCard() {
        composeTestRule.setContent {
            MainScreen(
                status = TunnelStatus.Disconnected,
                isConfigValid = true,
                batteryExempted = true,
                onStart = {},
                onStop = {},
                onNavigateToConfig = {},
                onBatterySettingsClick = {},
            )
        }

        // Should NOT show battery warning card
        composeTestRule.onNodeWithText("电池优化未豁免")
            .assertDoesNotExist()
    }

    @Test
    fun mainScreen_startClick_callsOnStart() {
        var startCalled = false

        composeTestRule.setContent {
            MainScreen(
                status = TunnelStatus.Disconnected,
                isConfigValid = true,
                batteryExempted = true,
                onStart = { startCalled = true },
                onStop = {},
                onNavigateToConfig = {},
                onBatterySettingsClick = {},
            )
        }

        composeTestRule.onNodeWithText("连接")
            .performClick()

        assert(startCalled) { "onStart should have been called" }
    }

    @Test
    fun mainScreen_stopClick_callsOnStop() {
        var stopCalled = false

        composeTestRule.setContent {
            MainScreen(
                status = TunnelStatus.Connected,
                isConfigValid = true,
                batteryExempted = true,
                onStart = {},
                onStop = { stopCalled = true },
                onNavigateToConfig = {},
                onBatterySettingsClick = {},
            )
        }

        composeTestRule.onNodeWithText("断开")
            .performClick()

        assert(stopCalled) { "onStop should have been called" }
    }

    @Test
    fun mainScreen_navigateConfigClick_callsOnNavigate() {
        var navigateCalled = false

        composeTestRule.setContent {
            MainScreen(
                status = TunnelStatus.Disconnected,
                isConfigValid = true,
                batteryExempted = true,
                onStart = {},
                onStop = {},
                onNavigateToConfig = { navigateCalled = true },
                onBatterySettingsClick = {},
            )
        }

        composeTestRule.onNodeWithText("配置")
            .performClick()

        assert(navigateCalled) { "onNavigateToConfig should have been called" }
    }

    @Test
    fun configScreen_allFieldsDisplayed() {
        composeTestRule.setContent {
            ConfigScreen(
                config = ConfigUiState(),
                batteryExempted = false,
                onNavigateBack = {},
                onUpdateHost = {},
                onUpdatePort = {},
                onUpdateUseTls = {},
                onUpdateAllowInsecure = {},
                onUpdateUsername = {},
                onUpdatePassword = {},
                onUpdateTunnelHost = {},
                onUpdateTunnelPort = {},
                onSave = {},
                onBatterySettingsClick = {},
            )
        }

        // Check all major sections and fields are displayed
        composeTestRule.onNodeWithText("服务器设置").assertIsDisplayed()
        composeTestRule.onNodeWithText("认证凭据").assertIsDisplayed()
        composeTestRule.onNodeWithText("隧道覆盖（可选）").assertIsDisplayed()
        composeTestRule.onNodeWithText("电池优化").assertIsDisplayed()
        composeTestRule.onNodeWithText("保存").assertIsDisplayed()
        composeTestRule.onNodeWithText("取消").assertIsDisplayed()
    }

    @Test
    fun configScreen_emptyFields_disablesSaveButton() {
        composeTestRule.setContent {
            ConfigScreen(
                config = ConfigUiState(
                    host = "",
                    port = "8003",
                    username = "",
                    password = "",
                ),
                batteryExempted = true,
                onNavigateBack = {},
                onUpdateHost = {},
                onUpdatePort = {},
                onUpdateUseTls = {},
                onUpdateAllowInsecure = {},
                onUpdateUsername = {},
                onUpdatePassword = {},
                onUpdateTunnelHost = {},
                onUpdateTunnelPort = {},
                onSave = {},
                onBatterySettingsClick = {},
            )
        }

        composeTestRule.onNodeWithText("保存")
            .assertIsDisplayed()
            .assertIsNotEnabled()
    }

    @Test
    fun configScreen_validFields_enablesSaveButton() {
        composeTestRule.setContent {
            ConfigScreen(
                config = ConfigUiState(
                    host = "example.com",
                    port = "8003",
                    username = "user",
                    password = "pass",
                ),
                batteryExempted = true,
                onNavigateBack = {},
                onUpdateHost = {},
                onUpdatePort = {},
                onUpdateUseTls = {},
                onUpdateAllowInsecure = {},
                onUpdateUsername = {},
                onUpdatePassword = {},
                onUpdateTunnelHost = {},
                onUpdateTunnelPort = {},
                onSave = {},
                onBatterySettingsClick = {},
            )
        }

        composeTestRule.onNodeWithText("保存")
            .assertIsDisplayed()
            .assertIsEnabled()
    }
}
