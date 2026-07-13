package com.blockproxy.android.cdn

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CfIpSelectorTest {

    @Test
    fun `first selectForLookup returns cursor IP without advancing`() {
        val persisted = mutableListOf<Int>()
        val selector = CfIpSelector(
            initialSnapshot = CfIpSnapshot(listOf("1.1.1.1", "2.2.2.2"), cursor = 1),
            persistCursor = persisted::add,
        )

        assertEquals("2.2.2.2", selector.selectForLookup())
        assertEquals(emptyList<Int>(), persisted)
    }

    @Test
    fun `markConnected reuses same IP on repeated lookup`() {
        val selector = CfIpSelector(CfIpSnapshot(listOf("1.1.1.1", "2.2.2.2"), 0)) {}

        assertEquals("1.1.1.1", selector.selectForLookup())
        selector.markConnected()

        assertEquals("1.1.1.1", selector.selectForLookup())
    }

    @Test
    fun `forceNextOnNextLookup advances exactly once`() {
        val persisted = mutableListOf<Int>()
        val selector = CfIpSelector(CfIpSnapshot(listOf("1.1.1.1", "2.2.2.2", "3.3.3.3"), 0), persisted::add)

        selector.forceNextOnNextLookup()

        assertEquals("2.2.2.2", selector.selectForLookup())
        assertEquals("2.2.2.2", selector.selectForLookup())
        assertEquals(listOf(1), persisted)
    }

    @Test
    fun `active unexpected disconnect advances next lookup exactly once`() {
        val selector = CfIpSelector(CfIpSnapshot(listOf("1.1.1.1", "2.2.2.2"), 0)) {}

        assertEquals("1.1.1.1", selector.selectForLookup())
        selector.markConnected()
        selector.markActiveDisconnectedUnexpectedly()

        assertEquals("2.2.2.2", selector.selectForLookup())
        assertEquals("2.2.2.2", selector.selectForLookup())
    }

    @Test
    fun `candidate failure advances next lookup without active failure semantics`() {
        val selector = CfIpSelector(CfIpSnapshot(listOf("1.1.1.1", "2.2.2.2"), 0)) {}

        assertEquals("1.1.1.1", selector.selectForLookup())
        selector.markConnected()
        selector.markCandidateFailed()

        assertEquals("2.2.2.2", selector.selectForLookup())
    }

    @Test
    fun `clean stop does not force advancement`() {
        val selector = CfIpSelector(CfIpSnapshot(listOf("1.1.1.1", "2.2.2.2"), 0)) {}

        assertEquals("1.1.1.1", selector.selectForLookup())
        selector.markStoppedCleanly()

        assertEquals("1.1.1.1", selector.selectForLookup())
    }

    @Test
    fun `empty pool returns null`() {
        val selector = CfIpSelector(CfIpSnapshot(emptyList(), 0)) {}

        assertNull(selector.selectForLookup())
        assertNull(selector.currentIp())
    }

    @Test
    fun `cursor wraps around`() {
        val persisted = mutableListOf<Int>()
        val selector = CfIpSelector(CfIpSnapshot(listOf("1.1.1.1", "2.2.2.2"), 1), persisted::add)

        selector.forceNextOnNextLookup()

        assertEquals("1.1.1.1", selector.selectForLookup())
        assertEquals(listOf(0), persisted)
    }

    @Test
    fun `advance with single ip returns null to allow DNS fallback`() {
        val selector = CfIpSelector(CfIpSnapshot(listOf("1.1.1.1"), 0)) {}

        assertEquals("1.1.1.1", selector.selectForLookup())
        selector.markActiveDisconnectedUnexpectedly()

        assertNull(selector.selectForLookup())
    }

    @Test
    fun `replaceSnapshot preserves selected IP if still present`() {
        val selector = CfIpSelector(CfIpSnapshot(listOf("1.1.1.1", "2.2.2.2"), 1)) {}

        assertEquals("2.2.2.2", selector.selectForLookup())
        selector.replaceSnapshot(CfIpSnapshot(listOf("3.3.3.3", "2.2.2.2"), 0))

        assertEquals("2.2.2.2", selector.currentIp())
    }

    @Test
    fun `replaceSnapshot falls back to normalized cursor when selected IP is absent`() {
        val selector = CfIpSelector(CfIpSnapshot(listOf("1.1.1.1", "2.2.2.2"), 0)) {}

        assertEquals("1.1.1.1", selector.selectForLookup())
        selector.replaceSnapshot(CfIpSnapshot(listOf("3.3.3.3", "4.4.4.4"), 3))

        assertEquals("4.4.4.4", selector.currentIp())
    }
}
