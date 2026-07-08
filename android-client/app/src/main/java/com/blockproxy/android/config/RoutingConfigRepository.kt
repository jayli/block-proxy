package com.blockproxy.android.config

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

// ─── Rule serialization ─────────────────────────────────────────────────────

/**
 * Encode a list of rules as a single newline-separated string.
 * Used by the DataStore implementation to persist rules without a JSON library.
 */
internal fun encodeRules(rules: List<String>): String = rules.joinToString("\n")

/**
 * Decode a newline-separated string back into a list of rules.
 * Blank lines are silently ignored so that trailing newlines or accidental
 * empty lines do not produce spurious empty-string rules.
 */
internal fun decodeRules(text: String): List<String> =
    text.split("\n").filter { it.isNotBlank() }

// ─── Abstraction for testability ────────────────────────────────────────────

/**
 * Storage backend for [RoutingConfig]; implemented by DataStore in production.
 *
 * Unlike [ConfigDataSource] which emits nullable values, this always emits a
 * valid [RoutingConfig] — the default (disabled, empty rules) when nothing is
 * stored.
 */
interface RoutingConfigDataSource {
    /** Observe the persisted config; emits [RoutingConfig] default when nothing is stored. */
    fun observe(): Flow<RoutingConfig>
    /** Persist [config], replacing any previous value. */
    suspend fun save(config: RoutingConfig)
    /** Remove any persisted config, restoring the default. */
    suspend fun clear()
}

// ─── Public repository ───────────────────────────────────────────────────────

/**
 * High-level API the rest of the app uses to read and write [RoutingConfig].
 *
 * Backed by a [RoutingConfigDataSource] — the production implementation is
 * [DataStoreRoutingConfigDataSource]; tests may inject an in-memory fake.
 */
class RoutingConfigRepository(private val source: RoutingConfigDataSource) {

    /** Cold [Flow] that emits the current routing config whenever it changes. */
    fun observe(): Flow<RoutingConfig> = source.observe()

    /** Persist [config]. Suspending; safe to call from any coroutine. */
    suspend fun save(config: RoutingConfig) = source.save(config)

    /** Remove the persisted config, restoring the default. */
    suspend fun clear() = source.clear()
}

// ─── DataStore implementation ────────────────────────────────────────────────

/**
 * Application-level singleton [DataStore] for routing configuration.
 *
 * Lazily created on first access per the DataStore best practice.
 */
private val Context.routingConfigDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "routing_config"
)

/**
 * Production [RoutingConfigDataSource] backed by Jetpack DataStore Preferences.
 *
 * Rules are stored as newline-separated strings (no JSON dependency).
 * The [RoutingConfig.enabled] flag is stored as a boolean preference.
 */
class DataStoreRoutingConfigDataSource(context: Context) : RoutingConfigDataSource {

    private val store: DataStore<Preferences> = context.applicationContext.routingConfigDataStore

    override fun observe(): Flow<RoutingConfig> = store.data.map { prefs ->
        RoutingConfig(
            enabled = prefs[KEY_ENABLED] ?: false,
            directRules = prefs[KEY_DIRECT_RULES]?.let(::decodeRules) ?: emptyList(),
            proxyRules = prefs[KEY_PROXY_RULES]?.let(::decodeRules) ?: emptyList(),
        )
    }

    override suspend fun save(config: RoutingConfig) {
        store.edit { prefs ->
            prefs[KEY_ENABLED] = config.enabled
            prefs[KEY_DIRECT_RULES] = encodeRules(config.directRules)
            prefs[KEY_PROXY_RULES] = encodeRules(config.proxyRules)
        }
    }

    override suspend fun clear() {
        store.edit { it.clear() }
    }

    private companion object {
        val KEY_ENABLED = booleanPreferencesKey("routing_enabled")
        val KEY_DIRECT_RULES = stringPreferencesKey("direct_rules")
        val KEY_PROXY_RULES = stringPreferencesKey("proxy_rules")
    }
}
