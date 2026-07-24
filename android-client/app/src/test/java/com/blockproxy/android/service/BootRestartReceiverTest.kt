package com.blockproxy.android.service

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BootRestartReceiverTest {

    @Test
    fun `shouldStartOnBoot returns true when config exists, tunnel enabled, and service not running`() {
        assertTrue(
            BootRestartReceiver.shouldStartOnBoot(
                hasConfig = true,
                tunnelEnabled = true,
                isServiceRunning = false,
            )
        )
    }

    @Test
    fun `shouldStartOnBoot returns false when tunnel disabled`() {
        assertFalse(
            BootRestartReceiver.shouldStartOnBoot(
                hasConfig = true,
                tunnelEnabled = false,
                isServiceRunning = false,
            )
        )
    }

    @Test
    fun `shouldStartOnBoot returns false when config is missing`() {
        assertFalse(
            BootRestartReceiver.shouldStartOnBoot(
                hasConfig = false,
                tunnelEnabled = true,
                isServiceRunning = false,
            )
        )
    }

    @Test
    fun `shouldStartOnBoot returns false when service is already running`() {
        assertFalse(
            BootRestartReceiver.shouldStartOnBoot(
                hasConfig = true,
                tunnelEnabled = true,
                isServiceRunning = true,
            )
        )
    }
}
