package com.blockproxy.android.cdn

class CfIpSelector(
    initialSnapshot: CfIpSnapshot,
    private val persistCursor: (Int) -> Unit,
) {
    private val lock = Any()
    private var goodIps: List<String> = initialSnapshot.goodIps
    private var cursor: Int = initialSnapshot.normalizedCursor()
    private var selectedIp: String? = goodIps.getOrNull(cursor)
    private var advanceOnNextLookup: Boolean = false

    fun currentIp(): String? = synchronized(lock) {
        selectedIp ?: goodIps.getOrNull(cursor)
    }

    fun selectForLookup(): String? = synchronized(lock) {
        if (goodIps.isEmpty()) {
            selectedIp = null
            return@synchronized null
        }

        if (advanceOnNextLookup) {
            if (goodIps.size <= 1) {
                selectedIp = null
                advanceOnNextLookup = false
                return@synchronized null
            }
            val nextCursor = (cursor + 1) % goodIps.size
            if (nextCursor != cursor) {
                persistCursor(nextCursor)
            }
            cursor = nextCursor
            advanceOnNextLookup = false
        }

        selectedIp = goodIps[cursor]
        selectedIp
    }

    fun forceNextOnNextLookup() = synchronized(lock) {
        advanceOnNextLookup = true
    }

    fun markConnected() = synchronized(lock) {
        advanceOnNextLookup = false
    }

    fun markActiveDisconnectedUnexpectedly() = synchronized(lock) {
        advanceOnNextLookup = true
    }

    fun markCandidateFailed() = synchronized(lock) {
        advanceOnNextLookup = true
    }

    fun markStoppedCleanly() = synchronized(lock) {
        advanceOnNextLookup = false
    }

    fun replaceSnapshot(snapshot: CfIpSnapshot) = synchronized(lock) {
        val previousSelected = selectedIp
        goodIps = snapshot.goodIps
        cursor = snapshot.normalizedCursor()
        selectedIp = when {
            goodIps.isEmpty() -> null
            previousSelected != null && previousSelected in goodIps -> {
                cursor = goodIps.indexOf(previousSelected)
                previousSelected
            }
            else -> goodIps[cursor]
        }
        advanceOnNextLookup = false
    }
}
