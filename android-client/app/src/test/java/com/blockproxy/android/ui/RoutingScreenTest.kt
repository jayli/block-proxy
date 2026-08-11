package com.blockproxy.android.ui

import app.cash.turbine.test
import com.blockproxy.android.config.RoutingConfig
import com.blockproxy.android.config.RoutingConfigDataSource
import com.blockproxy.android.config.RoutingConfigRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * In-memory fake of [RoutingConfigDataSource] for unit tests.
 * Notifies registered observers on save / clear so that the
 * repository's `observe()` flow emits the new value.
 */
private class FakeRoutingConfigDataSource : RoutingConfigDataSource {
    private var current: RoutingConfig = RoutingConfig()
    private val listeners = mutableListOf<(RoutingConfig) -> Unit>()

    override fun observe(): Flow<RoutingConfig> = callbackFlow {
        trySend(current)
        val listener: (RoutingConfig) -> Unit = { trySend(it) }
        listeners.add(listener)
        awaitClose { listeners.remove(listener) }
    }

    override suspend fun save(config: RoutingConfig) {
        current = config
        listeners.toList().forEach { it(config) }
    }

    override suspend fun clear() {
        current = RoutingConfig()
        listeners.toList().forEach { it(current) }
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class RoutingScreenTest {

    private val dispatcher = StandardTestDispatcher()
    private val scope = TestScope(dispatcher)

    private lateinit var dataSource: FakeRoutingConfigDataSource
    private lateinit var repository: RoutingConfigRepository

    @Before
    fun setup() {
        Dispatchers.setMain(dispatcher)
        dataSource = FakeRoutingConfigDataSource()
        repository = RoutingConfigRepository(dataSource)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    // ── Initial state ────────────────────────────────────────────────────────

    @Test
    fun `initial state reflects repository defaults`() = scope.runTest {
        val vm = RoutingViewModel(repository)
        advanceUntilIdle()

        val state = vm.uiState.value
        assertFalse(state.enabled)
        assertEquals("", state.directRulesText)
        assertEquals("", state.proxyRulesText)
        assertEquals(0, state.selectedTab)
        assertFalse(state.isSaved)
    }

    @Test
    fun `initial state loads existing config from repository`() = scope.runTest {
        val config = RoutingConfig(
            enabled = true,
            directRules = listOf("domain:a.com", "geosite:cn"),
            proxyRules = listOf("geosite:youtube"),
        )
        dataSource.save(config)

        val vm = RoutingViewModel(repository)
        advanceUntilIdle()

        val state = vm.uiState.value
        assertTrue(state.enabled)
        assertEquals("domain:a.com\ngeosite:cn", state.directRulesText)
        assertEquals("geosite:youtube", state.proxyRulesText)
    }

    // ── Enable switch ────────────────────────────────────────────────────────

    @Test
    fun `updateEnabled changes enabled state`() = scope.runTest {
        val vm = RoutingViewModel(repository)
        advanceUntilIdle()

        vm.updateEnabled(true)
        assertTrue(vm.uiState.value.enabled)

        vm.updateEnabled(false)
        assertFalse(vm.uiState.value.enabled)
    }

    @Test
    fun `updateEnabled clears isSaved flag`() = scope.runTest {
        val vm = RoutingViewModel(repository)
        advanceUntilIdle()
        vm.save()
        advanceUntilIdle()
        assertTrue(vm.uiState.value.isSaved)

        vm.updateEnabled(true)
        assertFalse(vm.uiState.value.isSaved)
    }

    // ── Rule editors ─────────────────────────────────────────────────────────

    @Test
    fun `updateDirectRules updates direct rules text`() = scope.runTest {
        val vm = RoutingViewModel(repository)
        advanceUntilIdle()

        vm.updateDirectRules("domain:example.com\ngeosite:cn")
        assertEquals("domain:example.com\ngeosite:cn", vm.uiState.value.directRulesText)
    }

    @Test
    fun `updateProxyRules updates proxy rules text`() = scope.runTest {
        val vm = RoutingViewModel(repository)
        advanceUntilIdle()

        vm.updateProxyRules("geosite:youtube\ngeosite:google")
        assertEquals("geosite:youtube\ngeosite:google", vm.uiState.value.proxyRulesText)
    }

    @Test
    fun `editing rules clears isSaved flag`() = scope.runTest {
        val vm = RoutingViewModel(repository)
        advanceUntilIdle()
        vm.save()
        advanceUntilIdle()

        vm.updateDirectRules("new rule")
        assertFalse(vm.uiState.value.isSaved)

        vm.save()
        advanceUntilIdle()

        vm.updateProxyRules("another")
        assertFalse(vm.uiState.value.isSaved)
    }

    // ── Tab selection ────────────────────────────────────────────────────────

    @Test
    fun `selectTab changes selected tab`() = scope.runTest {
        val vm = RoutingViewModel(repository)
        advanceUntilIdle()

        assertEquals(0, vm.uiState.value.selectedTab)

        vm.selectTab(1)
        assertEquals(1, vm.uiState.value.selectedTab)

        vm.selectTab(0)
        assertEquals(0, vm.uiState.value.selectedTab)
    }

    // ── Save ─────────────────────────────────────────────────────────────────

    @Test
    fun `save persists current state to repository`() = scope.runTest {
        val vm = RoutingViewModel(repository)
        advanceUntilIdle()

        vm.updateEnabled(true)
        vm.updateDirectRules("domain:a.com\ngeosite:cn")
        vm.updateProxyRules("geosite:youtube")
        vm.save()
        advanceUntilIdle()

        repository.observe().test {
            val saved = awaitItem()
            assertTrue(saved.enabled)
            assertEquals(listOf("domain:a.com", "geosite:cn"), saved.directRules)
            assertEquals(listOf("geosite:youtube"), saved.proxyRules)
            cancelAndConsumeRemainingEvents()
        }
    }

    @Test
    fun `save sets isSaved flag`() = scope.runTest {
        val vm = RoutingViewModel(repository)
        advanceUntilIdle()

        assertFalse(vm.uiState.value.isSaved)
        vm.save()
        advanceUntilIdle()
        assertTrue(vm.uiState.value.isSaved)
    }

    @Test
    fun `save strips blank lines from rules`() = scope.runTest {
        val vm = RoutingViewModel(repository)
        advanceUntilIdle()

        vm.updateDirectRules("rule1\n\nrule2\n  \nrule3")
        vm.save()
        advanceUntilIdle()

        repository.observe().test {
            val saved = awaitItem()
            assertEquals(listOf("rule1", "rule2", "rule3"), saved.directRules)
            cancelAndConsumeRemainingEvents()
        }
    }

    @Test
    fun `save persists enabled=false config`() = scope.runTest {
        // Start with enabled = true
        dataSource.save(RoutingConfig(enabled = true, directRules = listOf("r")))

        val vm = RoutingViewModel(repository)
        advanceUntilIdle()

        vm.updateEnabled(false)
        vm.save()
        advanceUntilIdle()

        repository.observe().test {
            val saved = awaitItem()
            assertFalse(saved.enabled)
            cancelAndConsumeRemainingEvents()
        }
    }

    // ── Reactive updates ─────────────────────────────────────────────────────

    @Test
    fun `uiState updates when repository emits externally`() = scope.runTest {
        val vm = RoutingViewModel(repository)
        advanceUntilIdle()

        vm.uiState.test {
            // Skip the initial emission
            awaitItem()

            dataSource.save(
                RoutingConfig(
                    enabled = true,
                    directRules = listOf("external-rule"),
                    proxyRules = emptyList(),
                )
            )
            advanceUntilIdle()

            val updated = awaitItem()
            assertTrue(updated.enabled)
            assertEquals("external-rule", updated.directRulesText)
            assertEquals("", updated.proxyRulesText)

            cancelAndConsumeRemainingEvents()
        }
    }
}
