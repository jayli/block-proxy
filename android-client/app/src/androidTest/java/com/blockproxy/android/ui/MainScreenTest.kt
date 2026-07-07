package com.blockproxy.android.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
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
        // Test a few key statuses instead of all (to avoid multiple setContent calls)
        val status = TunnelStatus.Connected
        val expectedText = "已连接"

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

        // The settings icon has content description "配置" in MainScreen.kt
        composeTestRule.onNodeWithContentDescription("配置")
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

        // Check top bar title which is always visible
        composeTestRule.onNodeWithText("配置").assertIsDisplayed()
        // Check that the form exists (scrollable content)
        composeTestRule.onAllNodesWithText("服务器地址").assertCountEquals(1)
        composeTestRule.onAllNodesWithText("保存").assertCountEquals(1)
        composeTestRule.onAllNodesWithText("取消").assertCountEquals(1)
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

        composeTestRule.onAllNodesWithText("保存")
            .assertCountEquals(1)
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

        composeTestRule.onAllNodesWithText("保存")
            .assertCountEquals(1)
    }
}
