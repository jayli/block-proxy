package com.blockproxy.android.config

import app.cash.turbine.test
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * In-memory fake of [ConfigDataSource] for local unit tests.
 * Avoids Android framework dependencies (DataStore requires Context).
 */
private class FakeConfigDataSource : ConfigDataSource {
    private var current: ServerConfig? = null
    private val listeners = mutableListOf<(ServerConfig?) -> Unit>()

    override fun observe(): kotlinx.coroutines.flow.Flow<ServerConfig?> = callbackFlow {
        trySend(current)
        val listener: (ServerConfig?) -> Unit = { trySend(it) }
        listeners.add(listener)
        awaitClose { listeners.remove(listener) }
    }

    override suspend fun save(config: ServerConfig) {
        current = config
        listeners.toList().forEach { it(config) }
    }

    override suspend fun clear() {
        current = null
        listeners.toList().forEach { it(null) }
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class ConfigRepositoryTest {

    private val dispatcher = StandardTestDispatcher()
    private val scope = TestScope(dispatcher)

    private val fakeDataSource = FakeConfigDataSource()
    private val repository = ConfigRepository(fakeDataSource)

    @Test
    fun `initial config is null`() = scope.runTest {
        repository.observe().test {
            assertNull(awaitItem())
            cancelAndConsumeRemainingEvents()
        }
    }

    @Test
    fun `save emits updated config`() = scope.runTest {
        val config = ServerConfig(
            serverHost = "192.168.1.100",
            serverPort = 8003,
            useTls = true,
            allowInsecure = true,
        )

        repository.observe().test {
            // initial
            assertNull(awaitItem())

            repository.save(config)
            assertEquals(config, awaitItem())

            cancelAndConsumeRemainingEvents()
        }
    }

    @Test
    fun `save twice emits latest config`() = scope.runTest {
        val config1 = ServerConfig(serverHost = "host1.example.com", serverPort = 8003)
        val config2 = ServerConfig(serverHost = "host2.example.com", serverPort = 9000)

        repository.observe().test {
            assertNull(awaitItem())

            repository.save(config1)
            assertEquals(config1, awaitItem())

            repository.save(config2)
            assertEquals(config2, awaitItem())

            cancelAndConsumeRemainingEvents()
        }
    }

    @Test
    fun `clear removes persisted config`() = scope.runTest {
        val config = ServerConfig(serverHost = "host.example.com", serverPort = 8003)

        repository.observe().test {
            assertNull(awaitItem())

            repository.save(config)
            assertEquals(config, awaitItem())

            repository.clear()
            assertNull(awaitItem())

            cancelAndConsumeRemainingEvents()
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun `save rejects blank serverHost`() = scope.runTest {
        repository.save(ServerConfig(serverHost = "  ", serverPort = 8003))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `save rejects invalid port`() = scope.runTest {
        repository.save(ServerConfig(serverHost = "host.example.com", serverPort = 0))
    }

}
