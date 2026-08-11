package com.blockproxy.android.diagnostics

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.Instant
import kotlin.io.path.createTempDirectory

class TunnelDiagnosticsLogTest {
    @Test
    fun `writes timestamped single line event`() {
        val dir = createTempDirectory().toFile()
        val log = TunnelDiagnosticsLog(
            file = File(dir, "tunnel-diagnostics.log"),
            maxBytes = 4096,
            now = { Instant.parse("2026-07-22T01:00:00Z") },
        )

        log.write("sse.connected", "session=abcdef123456\nignored")

        val text = File(dir, "tunnel-diagnostics.log").readText()
        assertTrue(text.contains("2026-07-22T01:00:00Z sse.connected session=abcdef123456 ignored"))
        assertFalse(text.contains("\nignored"))
    }

    @Test
    fun `rotates oversized log before appending`() {
        val dir = createTempDirectory().toFile()
        val file = File(dir, "tunnel-diagnostics.log")
        file.writeText("x".repeat(128))
        val log = TunnelDiagnosticsLog(
            file = file,
            maxBytes = 100,
            now = { Instant.parse("2026-07-22T01:00:00Z") },
        )

        log.write("sse.disconnected", "reason=test")

        val text = file.readText()
        assertTrue(text.startsWith("... truncated ...\n"))
        assertTrue(text.contains("sse.disconnected reason=test"))
        assertTrue(text.length <= 140)
    }
}
