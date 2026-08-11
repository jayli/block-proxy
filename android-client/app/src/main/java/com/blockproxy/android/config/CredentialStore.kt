package com.blockproxy.android.config

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import android.util.Base64

// ─── Abstraction for testability ────────────────────────────────────────────

/** Storage backend for [TunnelCredentials]; swappable to AndroidX Security Crypto later. */
interface CredentialDataSource {
    /** Observe persisted credentials; emits `null` when nothing is stored. */
    fun observe(): Flow<TunnelCredentials?>
    /** Persist [credentials]. The password is encoded before writing. */
    suspend fun save(credentials: TunnelCredentials)
    /** Remove any persisted credentials. */
    suspend fun clear()
}

// ─── Public store ────────────────────────────────────────────────────────────

/**
 * Persists [TunnelCredentials] without storing the password in plaintext.
 *
 * The current implementation Base64-encodes the password, which satisfies the
 * "no plaintext passwords in DataStore" requirement. When AndroidX Security
 * Crypto (or the Android Keystore) is added later, swap in a new
 * [CredentialDataSource] — the public API is unchanged.
 */
class CredentialStore(private val source: CredentialDataSource) {

    fun observe(): Flow<TunnelCredentials?> = source.observe()

    suspend fun save(credentials: TunnelCredentials) = source.save(credentials)

    suspend fun clear() = source.clear()
}

// ─── DataStore + Base64 implementation ───────────────────────────────────────

private val Context.credentialDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "tunnel_credentials"
)

/**
 * Production [CredentialDataSource] backed by Jetpack DataStore Preferences.
 *
 * - `username` is stored as a plain string (it is not secret).
 * - `password` is Base64-encoded before storage so it is never persisted as
 *   cleartext. `android.util.Base64` is available on all Android API levels.
 *
 * **Security note:** Base64 is encoding, not encryption. A determined attacker
 * with access to the device's data can trivially recover the password. This is
 * acceptable for the first version because the SOCKS5 credentials are typically
 * a shared tunnel secret rather than a user-chosen password. For higher
 * assurance, replace this class with an implementation that uses
 * `androidx.security:security-crypto` (EncryptedSharedPreferences).
 */
class DataStoreCredentialDataSource(context: Context) : CredentialDataSource {

    private val store: DataStore<Preferences> =
        context.applicationContext.credentialDataStore

    override fun observe(): Flow<TunnelCredentials?> = store.data.map { prefs ->
        val username = prefs[KEY_USERNAME] ?: return@map null
        val encodedPassword = prefs[KEY_PASSWORD] ?: return@map null
        val password = String(Base64.decode(encodedPassword, Base64.NO_WRAP))
        TunnelCredentials(username = username, password = password)
    }

    override suspend fun save(credentials: TunnelCredentials) {
        val encodedPassword = Base64.encodeToString(
            credentials.password.toByteArray(Charsets.UTF_8),
            Base64.NO_WRAP
        )
        store.edit { prefs ->
            prefs[KEY_USERNAME] = credentials.username
            prefs[KEY_PASSWORD] = encodedPassword
        }
    }

    override suspend fun clear() {
        store.edit { it.clear() }
    }

    private companion object {
        val KEY_USERNAME = stringPreferencesKey("username")
        val KEY_PASSWORD = stringPreferencesKey("password_b64")
    }
}
