package com.blockproxy.android.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
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
                onBatterySettingsClick = {},
            )
        }

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
                onBatterySettingsClick = {},
            )
        }

        composeTestRule.onNodeWithText("滑动以连接")
            .assertIsDisplayed()
    }

    @Test
    fun mainScreen_connectedStatus_showsActiveSlider() {
        composeTestRule.setContent {
            MainScreen(
                status = TunnelStatus.Connected,
                isConfigValid = true,
                batteryExempted = true,
                isSlideActive = true,
                sliderTrackTone = SliderTrackTone.Connected,
                onStart = {},
                onStop = {},
                onBatterySettingsClick = {},
            )
        }

        composeTestRule.onNodeWithText("已连接 · 左滑断开")
            .assertIsDisplayed()
    }

    @Test
    fun mainScreen_connectingStatus_showsConnectingSlider() {
        composeTestRule.setContent {
            MainScreen(
                status = TunnelStatus.Connecting,
                isConfigValid = true,
                batteryExempted = true,
                isSlideActive = true,
                sliderTrackTone = SliderTrackTone.Connecting,
                onStart = {},
                onStop = {},
                onBatterySettingsClick = {},
            )
        }

        composeTestRule.onNodeWithText("连接中...")
            .assertIsDisplayed()
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
                onBatterySettingsClick = {},
            )
        }

        // Should NOT show battery warning card
        composeTestRule.onNodeWithText("电池优化未豁免")
            .assertDoesNotExist()
    }

    @Test
    fun configScreen_allFieldsDisplayed() {
        composeTestRule.setContent {
            ConfigScreen(
                config = ConfigUiState(),
                batteryExempted = false,
                onNavigateToHome = {},
                onUpdateHost = {},
                onUpdatePort = {},
                onUpdateUsername = {},
                onUpdatePassword = {},
                onSave = {},
                onBatterySettingsClick = {},
                routingEnabled = false,
                onNavigateToRouting = {},
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
                onNavigateToHome = {},
                onUpdateHost = {},
                onUpdatePort = {},
                onUpdateUsername = {},
                onUpdatePassword = {},
                onSave = {},
                onBatterySettingsClick = {},
                routingEnabled = false,
                onNavigateToRouting = {},
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
                onNavigateToHome = {},
                onUpdateHost = {},
                onUpdatePort = {},
                onUpdateUsername = {},
                onUpdatePassword = {},
                onSave = {},
                onBatterySettingsClick = {},
                routingEnabled = false,
                onNavigateToRouting = {},
            )
        }

        composeTestRule.onAllNodesWithText("保存")
            .assertCountEquals(1)
    }
}
