package com.blockproxy.android.config

import app.cash.turbine.test
import com.blockproxy.android.tunnel.TunnelTransportMode
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * In-memory fake of [ConfigDataSource] for local unit tests.
 * Avoids Android framework dependencies (DataStore requires Context).
 */
private class FakeConfigDataSource : ConfigDataSource {
    var current: ServerConfig? = null
        private set
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
    fun `save and observe preserves cfCdnEnabled`() = scope.runTest {
        repository.observe().test {
            assertNull(awaitItem())

            repository.save(
                ServerConfig(
                    serverHost = "example.com",
                    serverPort = 443,
                    useTls = true,
                    cfCdnEnabled = true,
                )
            )

            assertEquals(true, awaitItem()?.cfCdnEnabled)
            cancelAndConsumeRemainingEvents()
        }
    }

    @Test
    fun `cfCdnEnabled defaults to false`() = scope.runTest {
        repository.save(ServerConfig(serverHost = "example.com"))

        repository.observe().test {
            assertEquals(false, awaitItem()?.cfCdnEnabled)
            cancelAndConsumeRemainingEvents()
        }
    }

    @Test
    fun `transport mode defaults to chrome utls`() = scope.runTest {
        repository.save(ServerConfig(serverHost = "example.com"))

        repository.observe().test {
            assertEquals(TunnelTransportMode.CHROME_UTLS, awaitItem()?.transportMode)
            cancelAndConsumeRemainingEvents()
        }
    }

    @Test
    fun `legacy okHttp transport preference is read as chrome utls`() {
        assertEquals(
            TunnelTransportMode.CHROME_UTLS,
            DataStoreConfigDataSource.parseTransportMode(TunnelTransportMode.OKHTTP.name),
        )
    }

    @Test
    fun `save rejects chrome utls when tls disabled`() = scope.runTest {
        try {
            repository.save(
                ServerConfig(
                    serverHost = "example.com",
                    useTls = false,
                    transportMode = TunnelTransportMode.CHROME_UTLS,
                )
            )
            throw AssertionError("Expected IllegalArgumentException")
        } catch (error: IllegalArgumentException) {
            assertTrue(error.message!!.contains("requires TLS"))
        }
    }

    @Test
    fun `save persists chrome utls transport mode`() = scope.runTest {
        repository.save(
            ServerConfig(
                serverHost = "example.com",
                transportMode = TunnelTransportMode.CHROME_UTLS,
            )
        )

        assertEquals(TunnelTransportMode.CHROME_UTLS, fakeDataSource.current?.transportMode)
    }

    @Test
    fun `padding defaults to enabled`() = scope.runTest {
        repository.save(ServerConfig(serverHost = "example.com"))

        repository.observe().test {
            assertEquals(true, awaitItem()?.paddingEnabled)
            cancelAndConsumeRemainingEvents()
        }
    }

    @Test
    fun `padding probability defaults to five percent`() = scope.runTest {
        repository.save(ServerConfig(serverHost = "example.com"))

        repository.observe().test {
            assertEquals(0.05f, awaitItem()?.paddingProbability)
            cancelAndConsumeRemainingEvents()
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun `cf cdn requires tls`() = scope.runTest {
        repository.save(
            ServerConfig(
                serverHost = "example.com",
                serverPort = 443,
                useTls = false,
                cfCdnEnabled = true,
            )
        )
    }

    @Test(expected = IllegalArgumentException::class)
    fun `cf cdn rejects unsupported port`() = scope.runTest {
        repository.save(
            ServerConfig(
                serverHost = "example.com",
                serverPort = 8003,
                useTls = true,
                cfCdnEnabled = true,
            )
        )
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
