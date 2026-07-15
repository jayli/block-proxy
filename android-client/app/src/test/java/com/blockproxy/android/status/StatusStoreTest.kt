package com.blockproxy.android.status

import app.cash.turbine.test
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StatusStoreTest {

    @Test
    fun `currentCfIp defaults to null`() {
        val store = StatusStore()

        assertNull(store.currentCfIp.value)
    }

    @Test
    fun `updateCfIp emits value`() = runTest {
        val store = StatusStore()

        store.currentCfIp.test {
            assertNull(awaitItem())
            store.updateCfIp("104.16.4.14")
            assertEquals("104.16.4.14", awaitItem())
            cancelAndConsumeRemainingEvents()
        }
    }

    @Test
    fun `updateCfIp to null clears value`() {
        val store = StatusStore()

        store.updateCfIp("104.16.4.14")
        store.updateCfIp(null)

        assertNull(store.currentCfIp.value)
    }

    @Test
    fun `transport label defaults to null`() {
        val store = StatusStore()

        assertNull(store.transportLabel.value)
    }

    @Test
    fun `updateTransportLabel emits value`() = runTest {
        val store = StatusStore()

        store.transportLabel.test {
            assertNull(awaitItem())
            store.updateTransportLabel("OkHttp")
            assertEquals("OkHttp", awaitItem())
            cancelAndConsumeRemainingEvents()
        }
    }

    @Test
    fun `disconnected status clears transport label`() {
        val store = StatusStore()

        store.updateTransportLabel("Cronet/Chrome")
        store.update(TunnelStatus.Disconnected)

        assertNull(store.transportLabel.value)
    }
}
