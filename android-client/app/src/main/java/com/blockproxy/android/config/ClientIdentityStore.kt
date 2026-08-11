package com.blockproxy.android.config

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

interface ClientIdentityDataSource {
    suspend fun load(): String?
    suspend fun save(clientId: String)
}

class ClientIdentityStore(
    private val source: ClientIdentityDataSource,
    private val generator: () -> String = ::generateClientId,
) {
    private val mutex = Mutex()

    suspend fun getOrCreate(): String = mutex.withLock {
        val existing = source.load()
        if (!existing.isNullOrBlank()) return@withLock existing

        val clientId = generator()
        source.save(clientId)
        clientId
    }

    companion object {
        fun generateClientId(): String = UUID.randomUUID().toString()
    }
}

private val Context.clientIdentityDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "client_identity",
)

class DataStoreClientIdentityDataSource(context: Context) : ClientIdentityDataSource {
    private val store: DataStore<Preferences> = context.applicationContext.clientIdentityDataStore

    override suspend fun load(): String? = store.data
        .map { prefs -> prefs[KEY_CLIENT_ID] }
        .first()

    override suspend fun save(clientId: String) {
        store.edit { prefs ->
            prefs[KEY_CLIENT_ID] = clientId
        }
    }

    private companion object {
        val KEY_CLIENT_ID = stringPreferencesKey("client_id")
    }
}
