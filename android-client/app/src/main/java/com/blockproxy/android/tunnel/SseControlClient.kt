package com.blockproxy.android.tunnel

import android.util.Log
import com.blockproxy.android.config.ServerConfig
import com.blockproxy.android.config.TunnelCredentials
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStream
import java.io.InputStreamReader
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import kotlin.random.Random
import kotlin.random.nextLong

private const val SSE_TAG = "SseControlClient"
private const val DEFAULT_ROTATION_MIN_MS = 13 * 60 * 1000L
private const val DEFAULT_ROTATION_MAX_MS = 17 * 60 * 1000L

enum class SseControlResult {
    Wake,
    Rotated,
    Disconnected,
    AuthFailed,
    NotSupported,
    Failed,
}

class SseControlClient(
    private val config: ServerConfig,
    private val credentials: TunnelCredentials,
    private val okHttpClient: OkHttpClient,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val rotationDelayMs: () -> Long = {
        Random.nextLong(DEFAULT_ROTATION_MIN_MS..DEFAULT_ROTATION_MAX_MS)
    },
) {
    @Volatile private var currentCall: Call? = null

    suspend fun connectAndRead(): SseControlResult = withContext(dispatcher) {
        val request = Request.Builder()
            .url(buildUrl())
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .get()
            .build()

        try {
            val call = okHttpClient.newCall(request)
            currentCall = call
            Log.i(SSE_TAG, "Connecting SSE control stream to ${request.url.encodedPath}")
            call.execute().use { response ->
                Log.i(SSE_TAG, "SSE HTTP response code=${response.code} contentType=${response.header("Content-Type").orEmpty()}")
                when (response.code) {
                    200 -> {
                        val contentType = response.header("Content-Type").orEmpty()
                        if (!contentType.startsWith("text/event-stream")) {
                            Log.w(SSE_TAG, "SSE failed: unexpected content type")
                            SseControlResult.Failed
                        } else {
                            readSseEventsWithRotation(response.body?.byteStream()).also {
                                Log.i(SSE_TAG, "SSE stream ended with result=$it")
                            }
                        }
                    }
                    401 -> {
                        Log.w(SSE_TAG, "SSE auth failed")
                        SseControlResult.AuthFailed
                    }
                    404 -> {
                        Log.w(SSE_TAG, "SSE endpoint not supported")
                        SseControlResult.NotSupported
                    }
                    else -> {
                        Log.w(SSE_TAG, "SSE failed: HTTP ${response.code}")
                        SseControlResult.Failed
                    }
                }
            }
        } catch (e: IOException) {
            Log.w(SSE_TAG, "SSE request failed: ${e.javaClass.simpleName}: ${e.message}")
            SseControlResult.Failed
        } catch (e: Exception) {
            Log.w(SSE_TAG, "SSE request failed: ${e.javaClass.simpleName}: ${e.message}")
            SseControlResult.Failed
        } finally {
            currentCall = null
        }
    }

    fun stop() {
        Log.i(SSE_TAG, "Stopping SSE control stream")
        currentCall?.cancel()
        currentCall = null
    }

    private suspend fun readSseEventsWithRotation(stream: InputStream?): SseControlResult = coroutineScope {
        val reader = async(dispatcher) { readSseEvents(stream) }
        val rotation = async {
            delay(rotationDelayMs())
            SseControlResult.Rotated
        }

        select {
            reader.onAwait { result ->
                rotation.cancel()
                result
            }
            rotation.onAwait { result ->
                Log.i(SSE_TAG, "SSE rotation deadline reached")
                currentCall?.cancel()
                reader.cancel()
                result
            }
        }
    }

    private fun readSseEvents(stream: InputStream?): SseControlResult {
        if (stream == null) return SseControlResult.Failed

        try {
            val reader = BufferedReader(InputStreamReader(stream))
            var eventType: String? = null
            while (true) {
                val line = reader.readLine() ?: return SseControlResult.Disconnected
                if (line.isEmpty()) {
                    if (eventType == "wake") {
                        Log.i(SSE_TAG, "Received SSE wake event")
                        return SseControlResult.Wake
                    }
                    eventType = null
                    continue
                }
                if (line.startsWith("event:")) {
                    eventType = line.substringAfter("event:").trim()
                }
            }
        } catch (_: IOException) {
            return SseControlResult.Disconnected
        } catch (_: Exception) {
            return SseControlResult.Failed
        }
    }

    private fun buildUrl(): String {
        val host = config.sseHost.ifBlank { config.serverHost }
        val port = config.ssePort.takeIf { it in 1..65535 } ?: config.serverPort
        val path = config.ssePath.let { if (it.startsWith("/")) it else "/$it" }
        val scheme = if (config.useTls) "https" else "http"
        return "$scheme://$host:$port$path?token=${token()}"
    }

    private fun token(): String {
        val bytes = MessageDigest.getInstance("SHA-256")
            .digest("${credentials.username}:${credentials.password}".toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }
    }

    companion object {
        fun createUnsafeOkHttpClient(): OkHttpClient {
            val trustManager = object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
                override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
                override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            }
            val sslContext = SSLContext.getInstance("TLS")
            sslContext.init(null, arrayOf<TrustManager>(trustManager), SecureRandom())
            return OkHttpClient.Builder()
                .sslSocketFactory(sslContext.socketFactory, trustManager)
                .hostnameVerifier { _, _ -> true }
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .build()
        }
    }
}
