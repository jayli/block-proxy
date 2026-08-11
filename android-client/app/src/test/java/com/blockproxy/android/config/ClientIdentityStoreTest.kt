package com.blockproxy.android.config

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ClientIdentityStoreTest {
    @Test
    fun `returns the same generated client id on repeated reads`() = runTest {
        val source = InMemoryClientIdentityDataSource()
        val store = ClientIdentityStore(source, generator = { "client-a" })

        assertEquals("client-a", store.getOrCreate())
        assertEquals("client-a", store.getOrCreate())
        assertEquals(1, source.saveCount)
    }

    @Test
    fun `keeps an existing persisted client id`() = runTest {
        val source = InMemoryClientIdentityDataSource(existing = "client-existing")
        val store = ClientIdentityStore(source, generator = { "client-new" })

        assertEquals("client-existing", store.getOrCreate())
        assertEquals(0, source.saveCount)
    }

    @Test
    fun `default generator creates non empty different ids`() {
        val first = ClientIdentityStore.generateClientId()
        val second = ClientIdentityStore.generateClientId()

        assertTrue(first.isNotBlank())
        assertNotEquals(first, second)
    }

    private class InMemoryClientIdentityDataSource(
        existing: String? = null,
    ) : ClientIdentityDataSource {
        private var value = existing
        var saveCount = 0

        override suspend fun load(): String? = value

        override suspend fun save(clientId: String) {
            value = clientId
            saveCount++
        }
    }
}
