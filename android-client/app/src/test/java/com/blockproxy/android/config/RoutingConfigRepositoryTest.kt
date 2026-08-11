package com.blockproxy.android.config

import app.cash.turbine.test
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * In-memory fake of [RoutingConfigDataSource] for local unit tests.
 * Stores the raw encoded strings so that serialization logic is exercised.
 */
private class FakeRoutingConfigDataSource : RoutingConfigDataSource {
    private var current: RoutingConfig = RoutingConfig()
    private val listeners = mutableListOf<(RoutingConfig) -> Unit>()

    /** Captured raw encoded strings from the last save, for test assertions. */
    var lastEncodedDirect: String? = null
        private set
    var lastEncodedProxy: String? = null
        private set

    override fun observe(): Flow<RoutingConfig> = callbackFlow {
        trySend(current)
        val listener: (RoutingConfig) -> Unit = { trySend(it) }
        listeners.add(listener)
        awaitClose { listeners.remove(listener) }
    }

    override suspend fun save(config: RoutingConfig) {
        // Use the same encode function the production DataStore uses
        lastEncodedDirect = encodeRules(config.directRules)
        lastEncodedProxy = encodeRules(config.proxyRules)
        current = config
        listeners.toList().forEach { it(config) }
    }

    override suspend fun clear() {
        lastEncodedDirect = null
        lastEncodedProxy = null
        current = RoutingConfig()
        listeners.toList().forEach { it(current) }
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class RoutingConfigRepositoryTest {

    private val dispatcher = StandardTestDispatcher()
    private val scope = TestScope(dispatcher)

    private val fakeDataSource = FakeRoutingConfigDataSource()
    private val repository = RoutingConfigRepository(fakeDataSource)

    // ── Default config ───────────────────────────────────────────────────

    @Test
    fun `default config is disabled with empty rules`() = scope.runTest {
        repository.observe().test {
            val default = awaitItem()
            assertFalse(default.enabled)
            assertEquals(emptyList<String>(), default.directRules)
            assertEquals(emptyList<String>(), default.proxyRules)
            cancelAndConsumeRemainingEvents()
        }
    }

    // ── Save and observe ─────────────────────────────────────────────────

    @Test
    fun `save emits updated config`() = scope.runTest {
        val config = RoutingConfig(
            enabled = true,
            directRules = listOf("192.168.0.0/16", "10.0.0.0/8"),
            proxyRules = listOf("geosite:youtube"),
        )

        repository.observe().test {
            // initial default
            val initial = awaitItem()
            assertFalse(initial.enabled)

            repository.save(config)
            assertEquals(config, awaitItem())

            cancelAndConsumeRemainingEvents()
        }
    }

    @Test
    fun `save twice emits latest config`() = scope.runTest {
        val config1 = RoutingConfig(enabled = true, directRules = listOf("rule1"))
        val config2 = RoutingConfig(enabled = false, proxyRules = listOf("rule2"))

        repository.observe().test {
            awaitItem() // default

            repository.save(config1)
            assertEquals(config1, awaitItem())

            repository.save(config2)
            assertEquals(config2, awaitItem())

            cancelAndConsumeRemainingEvents()
        }
    }

    // ── Serialization ────────────────────────────────────────────────────

    @Test
    fun `rules are serialized as newline-separated text`() = scope.runTest {
        val config = RoutingConfig(
            enabled = true,
            directRules = listOf("192.168.0.0/16", "10.0.0.0/8", "localhost"),
            proxyRules = listOf("geosite:youtube", "geosite:google"),
        )

        repository.save(config)

        assertEquals("192.168.0.0/16\n10.0.0.0/8\nlocalhost", fakeDataSource.lastEncodedDirect)
        assertEquals("geosite:youtube\ngeosite:google", fakeDataSource.lastEncodedProxy)
    }

    @Test
    fun `empty rules serialize to empty string`() = scope.runTest {
        repository.save(RoutingConfig(enabled = true))

        assertEquals("", fakeDataSource.lastEncodedDirect)
        assertEquals("", fakeDataSource.lastEncodedProxy)
    }

    @Test
    fun `blank lines are ignored when decoding rules`() {
        val decoded = decodeRules("rule1\n\nrule2\n  \nrule3\n")
        assertEquals(listOf("rule1", "rule2", "rule3"), decoded)
    }

    @Test
    fun `decodeRules on empty string returns empty list`() {
        assertEquals(emptyList<String>(), decodeRules(""))
    }

    @Test
    fun `encodeRules joins with newline`() {
        assertEquals("a\nb\nc", encodeRules(listOf("a", "b", "c")))
    }

    // ── Clear ────────────────────────────────────────────────────────────

    @Test
    fun `clear restores default config`() = scope.runTest {
        val config = RoutingConfig(
            enabled = true,
            directRules = listOf("some-rule"),
            proxyRules = listOf("another-rule"),
        )

        repository.observe().test {
            awaitItem() // default

            repository.save(config)
            assertEquals(config, awaitItem())

            repository.clear()
            val restored = awaitItem()
            assertFalse(restored.enabled)
            assertEquals(emptyList<String>(), restored.directRules)
            assertEquals(emptyList<String>(), restored.proxyRules)

            cancelAndConsumeRemainingEvents()
        }
    }

    // ── Roundtrip ────────────────────────────────────────────────────────

    @Test
    fun `encode then decode roundtrip preserves rules`() {
        val rules = listOf("192.168.0.0/16", "geosite:youtube", "*.example.com")
        assertEquals(rules, decodeRules(encodeRules(rules)))
    }
}
