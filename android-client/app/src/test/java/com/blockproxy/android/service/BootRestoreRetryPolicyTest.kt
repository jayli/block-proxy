package com.blockproxy.android.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BootRestoreRetryPolicyTest {

    @Test
    fun `nextDelayMillis returns null for manual starts`() {
        assertNull(
            BootRestoreRetryPolicy.nextDelayMillis(
                bootRestore = false,
                attempt = 0,
            )
        )
    }

    @Test
    fun `nextDelayMillis returns boot restore retry delays`() {
        assertEquals(15_000L, BootRestoreRetryPolicy.nextDelayMillis(bootRestore = true, attempt = 0))
        assertEquals(30_000L, BootRestoreRetryPolicy.nextDelayMillis(bootRestore = true, attempt = 1))
        assertEquals(60_000L, BootRestoreRetryPolicy.nextDelayMillis(bootRestore = true, attempt = 2))
        assertEquals(120_000L, BootRestoreRetryPolicy.nextDelayMillis(bootRestore = true, attempt = 3))
        assertEquals(120_000L, BootRestoreRetryPolicy.nextDelayMillis(bootRestore = true, attempt = 4))
    }

    @Test
    fun `nextDelayMillis returns null after boot restore attempts are exhausted`() {
        assertNull(
            BootRestoreRetryPolicy.nextDelayMillis(
                bootRestore = true,
                attempt = 5,
            )
        )
    }
}
