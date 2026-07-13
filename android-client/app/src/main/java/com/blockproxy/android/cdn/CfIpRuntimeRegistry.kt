package com.blockproxy.android.cdn

object CfIpRuntimeRegistry {
    private val lock = Any()
    private var activePool: CfIpPool? = null
    private var activeSelector: CfIpSelector? = null

    fun attach(pool: CfIpPool, selector: CfIpSelector) = synchronized(lock) {
        activePool = pool
        activeSelector = selector
    }

    fun detach(selector: CfIpSelector) = synchronized(lock) {
        if (activeSelector === selector) {
            activePool = null
            activeSelector = null
        }
    }

    suspend fun reloadActiveSnapshot(): Boolean {
        val pair = synchronized(lock) {
            val pool = activePool ?: return false
            val selector = activeSelector ?: return false
            pool to selector
        }
        val snapshot = pair.first.loadSnapshot()
        pair.second.replaceSnapshot(snapshot)
        return true
    }

    fun clearForTest() = synchronized(lock) {
        activePool = null
        activeSelector = null
    }
}
