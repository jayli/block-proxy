package com.blockproxy.android.diagnostics

import android.content.Context
import android.util.Log
import java.io.File
import java.time.Instant

class TunnelDiagnosticsLog(
    private val file: File,
    private val maxBytes: Long = DEFAULT_MAX_BYTES,
    private val now: () -> Instant = { Instant.now() },
) {
    fun write(event: String, detail: String = "") {
        synchronized(lock) {
            try {
                file.parentFile?.mkdirs()
                rotateIfNeeded()
                val cleanDetail = detail.replace(Regex("\\s+"), " ").trim()
                val suffix = if (cleanDetail.isEmpty()) "" else " $cleanDetail"
                file.appendText("${now()} $event$suffix\n")
            } catch (e: Exception) {
                Log.w(TAG, "Failed to write tunnel diagnostics: ${e.message}")
            }
        }
    }

    private fun rotateIfNeeded() {
        if (!file.exists() || file.length() <= maxBytes) return
        val bytes = file.readBytes()
        val keep = (maxBytes / 2).coerceAtLeast(1).toInt()
        val tail = bytes.takeLast(keep).toByteArray()
        file.writeText("... truncated ...\n")
        file.appendBytes(tail)
        if (!file.readText().endsWith("\n")) {
            file.appendText("\n")
        }
    }

    companion object {
        private const val TAG = "TunnelDiagnosticsLog"
        private const val DEFAULT_MAX_BYTES = 512L * 1024L
        private val lock = Any()

        @Volatile private var shared: TunnelDiagnosticsLog? = null

        fun initialize(context: Context) {
            shared = TunnelDiagnosticsLog(File(context.filesDir, "tunnel-diagnostics.log"))
            write("app.diagnostics.ready", "path=${File(context.filesDir, "tunnel-diagnostics.log").absolutePath}")
        }

        fun write(event: String, detail: String = "") {
            shared?.write(event, detail)
        }
    }
}
