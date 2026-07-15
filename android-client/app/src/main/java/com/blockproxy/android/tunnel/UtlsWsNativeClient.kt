package com.blockproxy.android.tunnel

data class UtlsWsOptions(
    val url: String,
    val dialHost: String,
    val serverName: String,
    val hostHeader: String,
    val allowInsecure: Boolean,
    val chromeProfile: String,
    val headers: List<Pair<String, String>>,
    val initialMessage: ByteArray,
    val connectTimeoutMillis: Int = 10_000,
    val readBufferBytes: Int = 64 * 1024,
)

interface UtlsWsNativeClient {
    fun connect(options: UtlsWsOptions, listener: UtlsWsListener): UtlsWsConnection
}

interface UtlsWsConnection {
    fun sendBinary(data: ByteArray): Boolean
    fun close(code: Int, reason: String)
}

interface UtlsWsListener {
    fun onOpen()
    fun onBinaryMessage(data: ByteArray)
    fun onClosed(code: Int, reason: String)
    fun onFailure(message: String)
}
