package com.blockproxy.android.service

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VpnAutoRestartPolicyTest {

    @Test
    fun `shouldStartService returns true when all conditions met including prepared`() {
        assertTrue(
            VpnAutoRestartPolicy.shouldStartService(
                hasConfig = true,
                tunnelEnabled = true,
                isServiceRunning = false,
                vpnPrepared = true,
            )
        )
    }

    @Test
    fun `shouldStartService returns false when VPN is not prepared for this boot`() {
        assertFalse(
            VpnAutoRestartPolicy.shouldStartService(
                hasConfig = true,
                tunnelEnabled = true,
                isServiceRunning = false,
                vpnPrepared = false,
            )
        )
    }

    @Test
    fun `shouldStartService returns false when tunnel disabled even if prepared`() {
        assertFalse(
            VpnAutoRestartPolicy.shouldStartService(
                hasConfig = true,
                tunnelEnabled = false,
                isServiceRunning = false,
                vpnPrepared = true,
            )
        )
    }

    @Test
    fun `shouldStartService returns false when service is already running`() {
        assertFalse(
            VpnAutoRestartPolicy.shouldStartService(
                hasConfig = true,
                tunnelEnabled = true,
                isServiceRunning = true,
                vpnPrepared = true,
            )
        )
    }

    @Test
    fun `shouldStartService returns false when config is missing`() {
        assertFalse(
            VpnAutoRestartPolicy.shouldStartService(
                hasConfig = false,
                tunnelEnabled = true,
                isServiceRunning = false,
                vpnPrepared = true,
            )
        )
    }
}
