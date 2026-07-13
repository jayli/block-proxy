package com.blockproxy.android.cdn

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import java.io.File

private const val ASSET_ALL_IPS = "cf-ips.txt"
private const val ASSET_GOOD_IPS = "cf-good-ips.txt"
private const val GOOD_IPS_FILENAME = "cf-good-ips.txt"

private val Context.cfIpPrefs: DataStore<Preferences> by preferencesDataStore(name = "cf_ip_prefs")

data class CfIpSnapshot(
    val goodIps: List<String>,
    val cursor: Int,
) {
    fun normalizedCursor(): Int {
        if (goodIps.isEmpty()) return 0
        return ((cursor % goodIps.size) + goodIps.size) % goodIps.size
    }
}

interface CfIpStorage {
    fun readAssetText(name: String): String?
    fun readInternalGoodIpsText(): String?
    fun writeInternalGoodIpsTextAtomically(text: String)
}

interface CfIpCursorStore {
    suspend fun loadCursor(): Int
    suspend fun saveCursor(index: Int)
}

private class AndroidCfIpStorage(context: Context) : CfIpStorage {
    private val appContext = context.applicationContext

    override fun readAssetText(name: String): String? {
        return runCatching {
            appContext.assets.open(name).bufferedReader().use { it.readText() }
        }.getOrNull()
    }

    override fun readInternalGoodIpsText(): String? {
        val file = File(appContext.filesDir, GOOD_IPS_FILENAME)
        if (!file.exists()) return null
        return runCatching { file.readText() }.getOrNull()
    }

    override fun writeInternalGoodIpsTextAtomically(text: String) {
        val file = File(appContext.filesDir, GOOD_IPS_FILENAME)
        val tmp = File(appContext.filesDir, "$GOOD_IPS_FILENAME.tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(file)) {
            file.writeText(text)
            tmp.delete()
        }
    }
}

private class DataStoreCfIpCursorStore(context: Context) : CfIpCursorStore {
    private val store = context.applicationContext.cfIpPrefs
    private val key = intPreferencesKey("cf_ip_cursor")

    override suspend fun loadCursor(): Int {
        return store.data.first()[key] ?: 0
    }

    override suspend fun saveCursor(index: Int) {
        store.edit { prefs ->
            prefs[key] = index
        }
    }
}

class CfIpPool(
    private val storage: CfIpStorage,
    private val cursorStore: CfIpCursorStore,
) {
    constructor(context: Context) : this(
        AndroidCfIpStorage(context),
        DataStoreCfIpCursorStore(context),
    )

    fun loadAllIps(): List<String> {
        return parseIpList(storage.readAssetText(ASSET_ALL_IPS))
    }

    fun loadGoodIpsBlocking(): List<String> {
        val internalIps = parseIpList(storage.readInternalGoodIpsText())
        if (internalIps.isNotEmpty()) return internalIps

        val seedIps = parseIpList(storage.readAssetText(ASSET_GOOD_IPS))
        if (seedIps.isNotEmpty()) {
            saveGoodIps(seedIps)
        }
        return seedIps
    }

    fun saveGoodIps(ips: List<String>) {
        storage.writeInternalGoodIpsTextAtomically(ips.joinToString("\n"))
    }

    suspend fun loadCursor(): Int = cursorStore.loadCursor()

    suspend fun saveCursor(index: Int) = cursorStore.saveCursor(index)

    suspend fun loadSnapshot(): CfIpSnapshot {
        return CfIpSnapshot(
            goodIps = loadGoodIpsBlocking(),
            cursor = loadCursor(),
        )
    }

    private fun parseIpList(text: String?): List<String> {
        if (text.isNullOrBlank()) return emptyList()
        return text.lineSequence()
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .toList()
    }
}
