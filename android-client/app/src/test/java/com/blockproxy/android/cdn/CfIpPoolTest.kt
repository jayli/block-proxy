package com.blockproxy.android.cdn

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FakeCfIpStorage(
    private val assets: MutableMap<String, String> = mutableMapOf(),
    private var internalGoodIps: String? = null,
) : CfIpStorage {
    val writes = mutableListOf<String>()

    override fun readAssetText(name: String): String? = assets[name]

    override fun readInternalGoodIpsText(): String? = internalGoodIps

    override fun writeInternalGoodIpsTextAtomically(text: String) {
        internalGoodIps = text
        writes += text
    }
}

class FakeCursorStore(initial: Int = 0) : CfIpCursorStore {
    var cursor = initial
    val saved = mutableListOf<Int>()

    override suspend fun loadCursor(): Int = cursor

    override suspend fun saveCursor(index: Int) {
        cursor = index
        saved += index
    }
}

class CfIpPoolTest {

    @Test
    fun `loadAllIps trims whitespace and drops blank lines`() {
        val storage = FakeCfIpStorage(
            assets = mutableMapOf(
                "cf-ips.txt" to " 104.16.4.14 \n\n104.16.16.108\n  \n"
            )
        )
        val pool = CfIpPool(storage, FakeCursorStore())

        assertEquals(listOf("104.16.4.14", "104.16.16.108"), pool.loadAllIps())
    }

    @Test
    fun `loadGoodIps prefers internal file over asset seed`() {
        val storage = FakeCfIpStorage(
            assets = mutableMapOf("cf-good-ips.txt" to "1.1.1.1\n"),
            internalGoodIps = "2.2.2.2\n3.3.3.3\n",
        )
        val pool = CfIpPool(storage, FakeCursorStore())

        assertEquals(listOf("2.2.2.2", "3.3.3.3"), pool.loadGoodIpsBlocking())
    }

    @Test
    fun `loadGoodIps copies asset seed when internal file is missing`() {
        val storage = FakeCfIpStorage(
            assets = mutableMapOf("cf-good-ips.txt" to "1.1.1.1\n2.2.2.2\n")
        )
        val pool = CfIpPool(storage, FakeCursorStore())

        assertEquals(listOf("1.1.1.1", "2.2.2.2"), pool.loadGoodIpsBlocking())
        assertEquals(listOf("1.1.1.1\n2.2.2.2"), storage.writes)
    }

    @Test
    fun `saveGoodIps writes atomically through storage`() {
        val storage = FakeCfIpStorage()
        val pool = CfIpPool(storage, FakeCursorStore())

        pool.saveGoodIps(listOf("1.1.1.1", "2.2.2.2"))

        assertEquals(listOf("1.1.1.1\n2.2.2.2"), storage.writes)
    }

    @Test
    fun `cursor persists through cursor store`() = runTest {
        val cursorStore = FakeCursorStore()
        val pool = CfIpPool(FakeCfIpStorage(), cursorStore)

        pool.saveCursor(7)

        assertEquals(7, pool.loadCursor())
        assertEquals(listOf(7), cursorStore.saved)
    }

    @Test
    fun `loadSnapshot returns good ips and cursor`() = runTest {
        val storage = FakeCfIpStorage(internalGoodIps = "1.1.1.1\n2.2.2.2\n")
        val pool = CfIpPool(storage, FakeCursorStore(initial = 5))

        val snapshot = pool.loadSnapshot()

        assertEquals(listOf("1.1.1.1", "2.2.2.2"), snapshot.goodIps)
        assertEquals(5, snapshot.cursor)
        assertEquals(1, snapshot.normalizedCursor())
    }

    @Test
    fun `missing assets produce empty lists`() {
        val pool = CfIpPool(FakeCfIpStorage(), FakeCursorStore())

        assertTrue(pool.loadAllIps().isEmpty())
        assertTrue(pool.loadGoodIpsBlocking().isEmpty())
    }
}
