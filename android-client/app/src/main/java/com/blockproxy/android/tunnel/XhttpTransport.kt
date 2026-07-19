package com.blockproxy.android.tunnel

import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.Socket
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.Base64
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.TimeUnit
import javax.net.SocketFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import kotlin.random.Random

private const val TAG = "XhttpTransport"
private const val OCTET_STREAM = "application/octet-stream"

/**
 * xhttp 传输层：用按需 HTTP POST + SSE 替代 WebSocket 双向隧道。
 *
 * - 上行：每个帧通过一次 POST /xhttp/upload/:sessionId/:seq 发送
 * - 下行：通过 SSE 长连接接收 frame 事件
 */
class XhttpTransport(
    private val baseUrl: String,           // https://host:port/xhttp
    private val sessionId: String,
    private val token: String,
    private val sseHttpClient: OkHttpClient,
    private val uploadHttpClient: OkHttpClient,
    private val protect: ((Socket) -> Boolean)? = null,
    private val paddingEnabled: Boolean = true,
) : FrameSender {

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    @Volatile private var sseCall: Call? = null
    @Volatile private var sseReader: BufferedReader? = null
    private var sseJob: Job? = null

    private val _isOpen = MutableStateFlow(false)
    val isOpenFlow: StateFlow<Boolean> = _isOpen.asStateFlow()

    private val _frameChannel = Channel<ByteArray>(Channel.UNLIMITED)
    private val seqCounter = AtomicLong(0)

    /** SSE disconnected callback (for reconnection) */
    @Volatile var onSseDisconnected: (() -> Unit)? = null

    companion object {
        fun createOkHttpClient(
            allowInsecure: Boolean,
            protect: ((Socket) -> Boolean)?,
        ): OkHttpClient {
            val builder = OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .writeTimeout(0, TimeUnit.MILLISECONDS)

            if (protect != null) {
                builder.socketFactory(ProtectedSocketFactory(protect))
            }

            if (allowInsecure) {
                val trustAllCerts = arrayOf<TrustManager>(object : X509TrustManager {
                    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
                })
                val sslContext = SSLContext.getInstance("TLS").apply {
                    init(null, trustAllCerts, SecureRandom())
                }
                builder.sslSocketFactory(sslContext.socketFactory, trustAllCerts[0] as X509TrustManager)
                builder.hostnameVerifier { _, _ -> true }
            }
            return builder.build()
        }
    }

    override val isOpen: Boolean
        get() = _isOpen.value

    /** Whether SSE is connected. This is the xhttp session's online signal. */
    @Volatile var sseConnected = false
        private set

    /**
     * 启动 SSE 下行流。
     */
    fun start() {
        sseJob = scope.launch {
            try {
                connectSse()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.e(TAG, "SSE fatal error", e)
            } finally {
                sseConnected = false
                _isOpen.value = false
                _frameChannel.close()
                onSseDisconnected?.invoke()
            }
        }
    }

    suspend fun awaitOpen(timeoutMs: Long): Boolean {
        return withTimeoutOrNull(timeoutMs) {
            isOpenFlow.first { it }
            true
        } ?: false
    }

    private suspend fun connectSse() {
        val url = "$baseUrl/stream?token=$token&sessionId=$sessionId"

        val request = Request.Builder()
            .url(url)
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .get()
            .build()

        val call = sseHttpClient.newCall(request)
        sseCall = call

        Log.i(TAG, "Connecting SSE: $url")
        call.execute().use { response ->
            if (!response.isSuccessful) {
                Log.e(TAG, "SSE failed: HTTP ${response.code}")
                return
            }

            val contentType = response.header("Content-Type") ?: ""
            if (!contentType.startsWith("text/event-stream")) {
                Log.e(TAG, "SSE wrong content type: $contentType")
                return
            }

            val stream = response.body?.byteStream() ?: return

            sseReader = BufferedReader(InputStreamReader(stream))
            sseConnected = true
            Log.i(TAG, "SSE connected")
            _isOpen.value = true

            // Read SSE events (blocks until disconnected)
            readSseEvents()
        }
    }

    private fun readSseEvents() {
        val reader = sseReader ?: return
        var eventType: String? = null
        var dataBuffer = StringBuilder()

        try {
            while (true) {
                val line = reader.readLine() ?: break

                if (line.isEmpty()) {
                    when (eventType) {
                        "frame" -> {
                            if (dataBuffer.isNotEmpty()) {
                                try {
                                    val frameBytes = Base64.getDecoder().decode(dataBuffer.toString())
                                    _frameChannel.trySend(frameBytes)
                                } catch (e: Exception) {
                                    Log.w(TAG, "SSE frame decode error: ${e.message}")
                                }
                            }
                        }
                    }
                    eventType = null
                    dataBuffer.clear()
                } else if (line.startsWith("event:")) {
                    eventType = line.substringAfter("event:").trim()
                } else if (line.startsWith("data:")) {
                    dataBuffer.append(line.substringAfter("data:").trim())
                }
                // keepalive comments (:) are ignored
            }
        } catch (e: IOException) {
            if (_isOpen.value) {
                Log.w(TAG, "SSE read error: ${e.message}")
            }
        }
    }

    override suspend fun sendFrame(encoded: ByteArray): Boolean {
        if (!isOpen) return false
        val seq = seqCounter.getAndIncrement()
        val requestBody = encoded.toRequestBody(OCTET_STREAM.toMediaType())
        val requestBuilder = Request.Builder()
            .url("$baseUrl/upload/$sessionId/$seq")
            .post(requestBody)
            .header("Content-Type", OCTET_STREAM)
            .header("Cache-Control", "no-store")
            .header("Connection", "keep-alive")

        buildPaddingHeader()?.let { requestBuilder.header("X-Padding", it) }

        return try {
            uploadHttpClient.newCall(requestBuilder.build()).execute().use { response ->
                if (!response.isSuccessful) {
                    Log.w(TAG, "Upload frame failed: HTTP ${response.code}")
                    false
                } else {
                    response.body?.bytes()
                    true
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "Upload frame error: ${e.message}")
            false
        }
    }

    private fun buildPaddingHeader(): String? {
        if (!paddingEnabled || Random.nextFloat() >= 0.05f) return null
        val paddingSize = Random.nextInt(64, 513)
        return Base64.getEncoder().encodeToString(Random.nextBytes(paddingSize))
    }

    suspend fun readFrame(): ByteArray? {
        return try {
            _frameChannel.receive()
        } catch (e: Exception) {
            null
        }
    }

    override fun close(code: Int, reason: String) {
        Log.i(TAG, "Closing transport: code=$code reason=$reason")
        _isOpen.value = false

        sseCall?.cancel()
        sseCall = null
        sseJob?.cancel()
        sseJob = null

        sseConnected = false

        try { sseReader?.close() } catch (_: Exception) {}
        sseReader = null

        _frameChannel.close()
        scope.cancel()
    }
}

/**
 * VpnService.protect() 的 SocketFactory 适配器。
 */
class ProtectedSocketFactory(
    private val protect: (Socket) -> Boolean,
) : SocketFactory() {
    private val delegate = SocketFactory.getDefault()

    private fun protectSocket(socket: Socket): Socket {
        protect(socket)
        return socket
    }

    override fun createSocket(): Socket =
        protectSocket(delegate.createSocket())

    override fun createSocket(host: String, port: Int): Socket =
        protectSocket(delegate.createSocket()).apply {
            connect(java.net.InetSocketAddress(host, port))
        }

    override fun createSocket(
        host: String, port: Int, localHost: java.net.InetAddress, localPort: Int,
    ): Socket =
        protectSocket(delegate.createSocket()).apply {
            bind(java.net.InetSocketAddress(localHost, localPort))
            connect(java.net.InetSocketAddress(host, port))
        }

    override fun createSocket(host: java.net.InetAddress, port: Int): Socket =
        protectSocket(delegate.createSocket()).apply {
            connect(java.net.InetSocketAddress(host, port))
        }

    override fun createSocket(
        address: java.net.InetAddress, port: Int,
        localAddress: java.net.InetAddress, localPort: Int,
    ): Socket =
        protectSocket(delegate.createSocket()).apply {
            bind(java.net.InetSocketAddress(localAddress, localPort))
            connect(java.net.InetSocketAddress(address, port))
        }
}
