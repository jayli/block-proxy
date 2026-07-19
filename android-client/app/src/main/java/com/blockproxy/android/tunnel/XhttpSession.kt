package com.blockproxy.android.tunnel

import android.util.Log
import com.blockproxy.android.config.ServerConfig
import com.blockproxy.android.config.TunnelCredentials
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest

private const val TAG = "XhttpSession"
private const val OCTET_STREAM = "application/octet-stream"

/**
 * xhttp 会话管理器。
 *
 * 负责：
 * 1. 通过 POST /xhttp/create 创建会话（发送 AUTH 帧）
 * 2. 获取 sessionId
 * 3. 创建并启动 XhttpTransport（SSE 下行 + 按需 POST 上行）
 */
class XhttpSession(
    private val config: ServerConfig,
    private val credentials: TunnelCredentials,
    private val sseHttpClient: OkHttpClient,
    private val uploadClient: XhttpUploadClient,
    private val protect: ((java.net.Socket) -> Boolean)? = null,
) {
    /**
     * 建立 xhttp 会话并启动传输。
     *
     * @return 已启动的 XhttpTransport
     */
    suspend fun establish(): XhttpTransport {
        val baseUrl = buildBaseUrl()
        val token = computeToken()

        // 1. 编码 AUTH 帧
        val authCapabilities = buildList {
            if (config.paddingEnabled) add(FrameCodec.CAP_PADDING)
        }
        val authFrame = FrameCodec.encode(
            Frame.Auth(credentials.username, credentials.password, authCapabilities)
        )

        // 2. POST /xhttp/create
        Log.i(TAG, "Creating xhttp session at $baseUrl/create")
        val sessionId = createSession(baseUrl, authFrame)
        Log.i(TAG, "Session created: $sessionId")

        // 3. 创建 XhttpTransport（传入 token，内部启动 SSE）
        val transport = XhttpTransport(
            baseUrl = baseUrl,
            sessionId = sessionId,
            token = token,
            sseHttpClient = sseHttpClient,
            uploadClient = uploadClient,
            protect = protect,
            paddingEnabled = config.paddingEnabled,
        )

        transport.start()
        if (!transport.awaitOpen(10_000L)) {
            transport.close(1000, "sse-open-timeout")
            throw TunnelProtocolException("SSE stream did not open")
        }
        return transport
    }

    private suspend fun createSession(baseUrl: String, authFrame: ByteArray): String {
        val url = "$baseUrl/create"

        val requestBody = authFrame.toRequestBody(OCTET_STREAM.toMediaType())
        val request = Request.Builder()
            .url(url)
            .post(requestBody)
            .header("Content-Type", OCTET_STREAM)
            .header("Cache-Control", "no-store")
            .build()

        val response = try {
            sseHttpClient.newCall(request).execute()
        } catch (e: IOException) {
            throw TunnelProtocolException("Failed to create session: ${e.message}")
        }

        response.use { resp ->
            if (resp.code == 401) {
                throw TunnelAuthFailedException("Authentication failed")
            }

            if (!resp.isSuccessful) {
                val body = resp.body?.string() ?: ""
                throw TunnelProtocolException("Create session failed: HTTP ${resp.code} - $body")
            }

            val body = resp.body?.string()
                ?: throw TunnelProtocolException("Empty response body")

            return try {
                val json = JSONObject(body)
                json.getString("sessionId")
            } catch (e: Exception) {
                throw TunnelProtocolException("Failed to parse session response: ${e.message}")
            }
        }
    }

    private fun buildBaseUrl(): String {
        val scheme = if (config.useTls) "https" else "http"
        val host = config.serverHost
        val port = config.serverPort
        val basePath = config.xhttpBasePath.let { if (it.startsWith("/")) it else "/$it" }
        return "$scheme://$host:$port$basePath"
    }

    private fun computeToken(): String {
        val bytes = MessageDigest.getInstance("SHA-256")
            .digest("${credentials.username}:${credentials.password}".toByteArray(Charsets.UTF_8))
        return bytes.joinToString("") { "%02x".format(it) }
    }
}
