package com.blockproxy.android.tunnel

import android.util.Log
import com.blockproxy.android.cdn.CfIpSelector
import com.blockproxy.android.config.ServerConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

private const val UPLOAD_TAG = "XhttpUploadClient"
private const val UPLOAD_OCTET_STREAM = "application/octet-stream"

interface XhttpUploadClient {
    suspend fun postFrame(url: String, body: ByteArray, headers: Map<String, String> = emptyMap()): Boolean
    fun close() {}
}

class OkHttpXhttpUploadClient(
    private val httpClient: OkHttpClient,
) : XhttpUploadClient {
    override suspend fun postFrame(url: String, body: ByteArray, headers: Map<String, String>): Boolean {
        val requestBody = body.toRequestBody(UPLOAD_OCTET_STREAM.toMediaType())
        val requestBuilder = Request.Builder()
            .url(url)
            .post(requestBody)
            .header("Content-Type", UPLOAD_OCTET_STREAM)
            .header("Cache-Control", "no-store")
            .header("Connection", "keep-alive")
        for ((name, value) in headers) {
            requestBuilder.header(name, value)
        }
        val request = requestBuilder.build()

        return try {
            httpClient.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.w(UPLOAD_TAG, "Upload frame failed: HTTP ${response.code}")
                    false
                } else {
                    response.body?.bytes()
                    true
                }
            }
        } catch (e: IOException) {
            Log.w(UPLOAD_TAG, "Upload frame error: ${e.message}")
            false
        }
    }
}

class NativeUtlsXhttpUploadClient(
    private val config: ServerConfig,
    private val selector: CfIpSelector?,
    private val nativeClient: NativeUtlsPostClient,
    private val fallback: XhttpUploadClient,
) : XhttpUploadClient {
    override suspend fun postFrame(url: String, body: ByteArray, headers: Map<String, String>): Boolean {
        val options = NativeUtlsPostOptions(
            url = url,
            dialHost = selector?.selectDifferentForLookup() ?: config.serverHost,
            serverName = config.serverHost,
            hostHeader = hostAuthority(config.serverHost, config.serverPort),
            allowInsecure = config.allowInsecure,
            headers = listOf("Cache-Control" to "no-store") + headers.map { it.key to it.value },
        )
        return try {
            withContext(Dispatchers.IO) {
                nativeClient.postPacket(options, body)
            }
            true
        } catch (t: Throwable) {
            Log.w(UPLOAD_TAG, "Native uTLS upload failed, falling back to OkHttp: ${t.message}")
            fallback.postFrame(url, body, headers)
        }
    }

    override fun close() {
        nativeClient.close()
    }

    private fun hostAuthority(host: String, port: Int): String {
        return if (port == 443) host else "$host:$port"
    }
}

data class NativeUtlsPostOptions(
    val url: String,
    val dialHost: String,
    val serverName: String,
    val hostHeader: String,
    val allowInsecure: Boolean,
    val headers: List<Pair<String, String>> = emptyList(),
)

interface NativeUtlsPostClient {
    fun postPacket(options: NativeUtlsPostOptions, body: ByteArray)
    fun close()
}
