package com.blockproxy.android.config

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.blockproxy.android.cdn.CfCdnConfig
import com.blockproxy.android.tunnel.TunnelTransportMode
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

// ─── Abstraction for testability ────────────────────────────────────────────

/** Storage backend for [ServerConfig]; implemented by DataStore in production. */
interface ConfigDataSource {
    /** Observe the persisted config; emits `null` when nothing is stored. */
    fun observe(): Flow<ServerConfig?>
    /** Persist [config], replacing any previous value. */
    suspend fun save(config: ServerConfig)
    /** Remove any persisted config. */
    suspend fun clear()
}

// ─── Public repository ───────────────────────────────────────────────────────

/**
 * High-level API the rest of the app uses to read and write [ServerConfig].
 *
 * Backed by a [ConfigDataSource] — the production implementation is
 * [DataStoreConfigDataSource]; tests may inject an in-memory fake.
 */
class ConfigRepository(private val source: ConfigDataSource) {
    /** Cold [Flow] that emits the current config whenever it changes. */
    fun observe(): Flow<ServerConfig?> = source.observe()

    /** Persist [config] after basic validation. Suspending; safe to call from any coroutine. */
    suspend fun save(config: ServerConfig) {
        require(config.serverHost.isNotBlank()) { "serverHost must not be blank" }
        require(config.serverPort in 1..65535) { "serverPort must be in 1..65535" }
        if (config.cfCdnEnabled) {
            require(config.useTls) { "Cloudflare CDN mode requires TLS" }
            require(config.serverPort in CfCdnConfig.HTTPS_PORTS) {
                "Cloudflare CDN mode requires a Cloudflare HTTPS proxy port"
            }
        }
        if (config.transportMode == TunnelTransportMode.CHROME_UTLS) {
            require(config.useTls) { "Chrome uTLS transport requires TLS" }
        }
        source.save(config)
    }

    /** Remove the persisted config. */
    suspend fun clear() = source.clear()
}

// ─── DataStore implementation ────────────────────────────────────────────────

/**
 * Application-level singleton [DataStore] for server configuration.
 *
 * Lazily created on first access per the DataStore best practice.
 */
private val Context.configDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "server_config"
)

/**
 * Production [ConfigDataSource] backed by Jetpack DataStore Preferences.
 *
 * Each field of [ServerConfig] is stored as an individual preference so that
 * partial updates are straightforward and no JSON library is required.
 */
class DataStoreConfigDataSource(context: Context) : ConfigDataSource {

    private val store: DataStore<Preferences> = context.applicationContext.configDataStore

    override fun observe(): Flow<ServerConfig?> = store.data.map { prefs ->
        val host = prefs[KEY_HOST] ?: return@map null
        ServerConfig(
            serverHost = host,
            serverPort = prefs[KEY_PORT] ?: ServerConfig.DEFAULT_PORT,
            useTls = prefs[KEY_USE_TLS] ?: true,
            allowInsecure = prefs[KEY_ALLOW_INSECURE] ?: true,
            wsPath = prefs[KEY_WS_PATH] ?: "/websocket",
            httpDisguise = prefs[KEY_HTTP_DISGUISE] ?: true,
            cfCdnEnabled = prefs[KEY_CF_CDN_ENABLED] ?: false,
            transportMode = parseTransportMode(prefs[KEY_TRANSPORT_MODE]),
        )
    }

    override suspend fun save(config: ServerConfig) {
        store.edit { prefs ->
            prefs[KEY_HOST] = config.serverHost
            prefs[KEY_PORT] = config.serverPort
            prefs[KEY_USE_TLS] = config.useTls
            prefs[KEY_ALLOW_INSECURE] = config.allowInsecure
            prefs[KEY_WS_PATH] = config.wsPath
            prefs[KEY_HTTP_DISGUISE] = config.httpDisguise
            prefs[KEY_CF_CDN_ENABLED] = config.cfCdnEnabled
            prefs[KEY_TRANSPORT_MODE] = config.transportMode.name
        }
    }

    override suspend fun clear() {
        store.edit { it.clear() }
    }

    internal companion object {
        val KEY_HOST = stringPreferencesKey("server_host")
        val KEY_PORT = intPreferencesKey("server_port")
        val KEY_USE_TLS = booleanPreferencesKey("use_tls")
        val KEY_ALLOW_INSECURE = booleanPreferencesKey("allow_insecure")
        val KEY_WS_PATH = stringPreferencesKey("ws_path")
        val KEY_HTTP_DISGUISE = booleanPreferencesKey("http_disguise")
        val KEY_CF_CDN_ENABLED = booleanPreferencesKey("cf_cdn_enabled")
        val KEY_TRANSPORT_MODE = stringPreferencesKey("transport_mode")

        fun parseTransportMode(value: String?): TunnelTransportMode {
            return TunnelTransportMode.CHROME_UTLS
        }
    }
}
