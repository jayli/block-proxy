package com.blockproxy.android.cdn

import java.net.Socket

object CfIpRuntimeRegistry {
    private val lock = Any()
    private var activePool: CfIpPool? = null
    private var activeSelector: CfIpSelector? = null
    private var activeProtect: ((Socket) -> Boolean)? = null

    fun attach(
        pool: CfIpPool,
        selector: CfIpSelector,
        protect: ((Socket) -> Boolean)? = null,
    ) = synchronized(lock) {
        activePool = pool
        activeSelector = selector
        activeProtect = protect
    }

    fun detach(selector: CfIpSelector) = synchronized(lock) {
        if (activeSelector === selector) {
            activePool = null
            activeSelector = null
            activeProtect = null
        }
    }

    fun currentProtect(): ((Socket) -> Boolean)? = synchronized(lock) {
        activeProtect
    }

    /** 获取当前游标指向的 CF IP（不推进游标）。用于 TLS 测试等只读场景。 */
    fun currentIp(): String? = synchronized(lock) {
        activeSelector?.currentIp()
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
        activeProtect = null
    }
}
