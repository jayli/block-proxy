package com.blockproxy.android.tunnel

import android.util.Log
import com.blockproxy.android.config.ServerConfig
import com.blockproxy.android.config.TunnelCredentials
import com.blockproxy.android.diagnostics.TunnelDiagnosticsLog
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
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
    private val clientId: String,
    private val sseHttpClient: OkHttpClient,
    private val uploadClient: XhttpUploadClient,
    private val protect: ((java.net.Socket) -> Boolean)? = null,
    private val uploadH2Enabled: Boolean = false,
    private val uploadListener: XhttpUploadListener? = null,
) {
    data class CreatedSession(
        val sessionId: String,
        val capabilities: List<String>,
    )

    companion object {
        internal fun buildAuthFrame(
            config: ServerConfig,
            credentials: TunnelCredentials,
            uploadH2Enabled: Boolean,
            clientId: String,
        ): ByteArray {
            val authCapabilities = buildList {
                if (config.paddingEnabled) add(FrameCodec.CAP_PADDING)
                add(FrameCodec.CAP_UPLOAD_BATCH)
                if (uploadH2Enabled) add(FrameCodec.CAP_UPLOAD_H2)
            }
            return FrameCodec.encode(
                Frame.Auth(credentials.username, credentials.password, authCapabilities, clientId)
            )
        }

        internal fun parseCreateSessionResponse(body: String): CreatedSession {
            val sessionId = Regex(""""sessionId"\s*:\s*"([^"]+)"""")
                .find(body)
                ?.groupValues
                ?.get(1)
                ?: throw IllegalArgumentException("Missing sessionId")
            return CreatedSession(
                sessionId = sessionId,
                capabilities = parseStringArray(body, "capabilities"),
            )
        }

        private fun parseStringArray(body: String, key: String): List<String> {
            val arrayBody = Regex(""""$key"\s*:\s*\[(.*?)]""")
                .find(body)
                ?.groupValues
                ?.get(1)
                ?: return emptyList()
            if (arrayBody.isBlank()) return emptyList()
            return Regex(""""([^"]*)"""")
                .findAll(arrayBody)
                .map { it.groupValues[1] }
                .toList()
        }
    }

    /**
     * 建立 xhttp 会话并启动传输。
     *
     * @return 已启动的 XhttpTransport
     */
    suspend fun establish(): XhttpTransport {
        val baseUrl = buildBaseUrl()
        val token = computeToken()

        // 1. 编码 AUTH 帧
        val authFrame = buildAuthFrame(config, credentials, uploadH2Enabled, clientId)

        // 2. POST /xhttp/create
        Log.i(TAG, "Creating xhttp session at $baseUrl/create")
        TunnelDiagnosticsLog.write(
            "xhttp.create.start",
            "host=${config.serverHost} port=${config.serverPort} path=${config.xhttpBasePath}"
        )
        val created = createSession(baseUrl, authFrame)
        Log.i(TAG, "Session created: ${created.sessionId}")
        TunnelDiagnosticsLog.write(
            "xhttp.create.success",
            "session=${created.sessionId.take(8)} capabilities=${created.capabilities.joinToString(",")}"
        )

        // 3. 创建 XhttpTransport（传入 token，内部启动 SSE）
        val transport = XhttpTransport(
            baseUrl = baseUrl,
            sessionId = created.sessionId,
            token = token,
            clientId = clientId,
            sseHttpClient = sseHttpClient,
            uploadClient = uploadClient,
            protect = protect,
            paddingEnabled = config.paddingEnabled,
            uploadBatchEnabled = created.capabilities.contains(FrameCodec.CAP_UPLOAD_BATCH),
            uploadListener = uploadListener,
        )

        transport.start()
        if (!transport.awaitOpen(10_000L)) {
            TunnelDiagnosticsLog.write("xhttp.sse_open_timeout", "session=${created.sessionId.take(8)} timeoutMs=10000")
            transport.close(1000, "sse-open-timeout")
            throw TunnelProtocolException("SSE stream did not open")
        }
        return transport
    }

    private suspend fun createSession(baseUrl: String, authFrame: ByteArray): CreatedSession {
        val url = "$baseUrl/create"

        val requestBody = authFrame.toRequestBody(OCTET_STREAM.toMediaType())
        val request = Request.Builder()
            .url(url)
            .post(requestBody)
            .header("Content-Type", OCTET_STREAM)
            .header("Cache-Control", "no-store")
            .header("Host", hostAuthority(config.serverHost, config.serverPort))
            .header("Connection", "close")
            .build()

        val response = try {
            sseHttpClient.newCall(request).execute()
        } catch (e: IOException) {
            TunnelDiagnosticsLog.write(
                "xhttp.create.io_error",
                "type=${e::class.java.simpleName} message=${e.message ?: ""}"
            )
            throw TunnelProtocolException("Failed to create session: ${e.message}")
        }

        response.use { resp ->
            if (resp.code == 401) {
                TunnelDiagnosticsLog.write("xhttp.create.auth_failed", "code=401")
                throw TunnelAuthFailedException("Authentication failed")
            }

            if (resp.code == 409 || resp.code == 423) {
                val body = resp.body?.string() ?: ""
                TunnelDiagnosticsLog.write("xhttp.create.occupied", "code=${resp.code}")
                Log.w(TAG, "Create session rejected as occupied: HTTP ${resp.code}, body=$body")
                throw TunnelOccupiedException("隧道已占用")
            }

            if (!resp.isSuccessful) {
                val body = resp.body?.string() ?: ""
                TunnelDiagnosticsLog.write(
                    "xhttp.create.http_failed",
                    "code=${resp.code} server=${resp.header("server") ?: ""} cfRay=${resp.header("cf-ray") ?: ""} location=${resp.header("location") ?: ""}"
                )
                Log.w(
                    TAG,
                    "Create session failed: HTTP ${resp.code}, server=${resp.header("server")}, cf-ray=${resp.header("cf-ray")}, location=${resp.header("location")}, body=$body"
                )
                throw TunnelProtocolException("Create session failed: HTTP ${resp.code} - $body")
            }

            val body = resp.body?.string()
                ?: run {
                    TunnelDiagnosticsLog.write("xhttp.create.empty_body")
                    throw TunnelProtocolException("Empty response body")
                }

            return try {
                parseCreateSessionResponse(body)
            } catch (e: Exception) {
                TunnelDiagnosticsLog.write(
                    "xhttp.create.parse_failed",
                    "type=${e::class.java.simpleName} message=${e.message ?: ""}"
                )
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

    private fun hostAuthority(host: String, port: Int): String {
        return if (port == 443) host else "$host:$port"
    }
}
