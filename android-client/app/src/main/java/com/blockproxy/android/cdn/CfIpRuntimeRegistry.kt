package com.blockproxy.android.cdn

import java.net.Socket

object CfIpRuntimeRegistry {
    private val lock = Any()
    private var activePool: CfIpPool? = null
    private var activeSelectors: List<CfIpSelector> = emptyList()
    private var activeProtect: ((Socket) -> Boolean)? = null

    fun attach(
        pool: CfIpPool,
        selector: CfIpSelector,
        protect: ((Socket) -> Boolean)? = null,
    ) = attach(pool, listOf(selector), protect)

    fun attach(
        pool: CfIpPool,
        selectors: List<CfIpSelector>,
        protect: ((Socket) -> Boolean)? = null,
    ) = synchronized(lock) {
        activePool = pool
        activeSelectors = selectors
        activeProtect = protect
    }

    fun detach(selector: CfIpSelector) = synchronized(lock) {
        if (selector in activeSelectors) {
            activePool = null
            activeSelectors = emptyList()
            activeProtect = null
        }
    }

    fun currentProtect(): ((Socket) -> Boolean)? = synchronized(lock) {
        activeProtect
    }

    /** 获取当前游标指向的 CF IP（不推进游标）。用于 TLS 测试等只读场景。 */
    fun currentIp(): String? = synchronized(lock) {
        activeSelectors.firstOrNull()?.currentIp()
    }

    suspend fun reloadActiveSnapshot(): Boolean {
        val pair = synchronized(lock) {
            val pool = activePool ?: return false
            if (activeSelectors.isEmpty()) return false
            pool to activeSelectors
        }
        val snapshot = pair.first.loadSnapshot()
        pair.second.forEach { it.replaceSnapshot(snapshot) }
        return true
    }

    fun clearForTest() = synchronized(lock) {
        activePool = null
        activeSelectors = emptyList()
        activeProtect = null
    }
}
