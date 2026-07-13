package com.blockproxy.android.cdn

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CfIpRuntimeRegistryTest {

    @Test
    fun `reloadActiveSnapshot returns false when nothing attached`() = runTest {
        CfIpRuntimeRegistry.clearForTest()

        assertFalse(CfIpRuntimeRegistry.reloadActiveSnapshot())
    }

    @Test
    fun `reloadActiveSnapshot replaces attached selector snapshot`() = runTest {
        CfIpRuntimeRegistry.clearForTest()
        val storage = FakeCfIpStorage(internalGoodIps = "9.9.9.9\n8.8.8.8\n")
        val pool = CfIpPool(storage, FakeCursorStore(initial = 1))
        val selector = CfIpSelector(CfIpSnapshot(listOf("1.1.1.1"), 0)) {}

        CfIpRuntimeRegistry.attach(pool, selector)

        assertTrue(CfIpRuntimeRegistry.reloadActiveSnapshot())
        assertEquals("8.8.8.8", selector.currentIp())
        CfIpRuntimeRegistry.clearForTest()
    }

    @Test
    fun `detach ignores stale selector`() = runTest {
        CfIpRuntimeRegistry.clearForTest()
        val oldSelector = CfIpSelector(CfIpSnapshot(listOf("1.1.1.1"), 0)) {}
        val newSelector = CfIpSelector(CfIpSnapshot(listOf("2.2.2.2"), 0)) {}
        val newPool = CfIpPool(FakeCfIpStorage(internalGoodIps = "3.3.3.3\n"), FakeCursorStore())

        CfIpRuntimeRegistry.attach(CfIpPool(FakeCfIpStorage(), FakeCursorStore()), oldSelector)
        CfIpRuntimeRegistry.attach(newPool, newSelector)
        CfIpRuntimeRegistry.detach(oldSelector)

        assertTrue(CfIpRuntimeRegistry.reloadActiveSnapshot())
        assertEquals("3.3.3.3", newSelector.currentIp())
        CfIpRuntimeRegistry.clearForTest()
    }
}
