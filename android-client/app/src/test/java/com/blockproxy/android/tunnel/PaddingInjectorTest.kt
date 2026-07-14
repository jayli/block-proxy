package com.blockproxy.android.tunnel

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

@OptIn(ExperimentalCoroutinesApi::class)
class PaddingInjectorTest {

    class FakeFrameSender(
        @Volatile override var isOpen: Boolean = true,
        private val failSend: Boolean = false,
    ) : FrameSender {
        val writtenBytes = CopyOnWriteArrayList<ByteArray>()
        private val closed = AtomicBoolean(false)

        override suspend fun sendFrame(encoded: ByteArray): Boolean {
            if (failSend || !isOpen || closed.get()) return false
            writtenBytes.add(encoded.copyOf())
            return true
        }

        override fun close(code: Int, reason: String) {
            if (closed.compareAndSet(false, true)) {
                isOpen = false
            }
        }
    }

    private fun decodedFrames(sender: FakeFrameSender): List<Frame> =
        sender.writtenBytes.map { FrameCodec.decode(it) }

    @Test
    fun `probability zero sends no padding`() = runTest {
        val sender = FakeFrameSender()
        val injector = PaddingInjector(
            scope = this,
            config = PaddingConfig(enabled = true, probability = 0.0f, minBytes = 4, maxBytes = 4),
        )

        injector.onDataSent(sender)
        runCurrent()

        assertTrue(sender.writtenBytes.isEmpty())
    }

    @Test
    fun `probability one sends padding`() = runTest {
        val sender = FakeFrameSender()
        val injector = PaddingInjector(
            scope = this,
            config = PaddingConfig(enabled = true, probability = 1.0f, minBytes = 4, maxBytes = 4),
        )

        injector.onDataSent(sender)
        runCurrent()

        val padding = decodedFrames(sender).single() as Frame.Padding
        assertEquals(4, padding.data.size)
    }

    @Test
    fun `padding size stays within configured range`() = runTest {
        val sender = FakeFrameSender()
        val injector = PaddingInjector(
            scope = this,
            config = PaddingConfig(enabled = true, probability = 1.0f, minBytes = 5, maxBytes = 9),
        )

        repeat(20) { injector.onDataSent(sender) }
        runCurrent()

        val sizes = decodedFrames(sender).map { (it as Frame.Padding).data.size }
        assertTrue(sizes.all { it in 5..9 })
    }

    @Test
    fun `sender failure does not throw to caller`() = runTest {
        val sender = FakeFrameSender(failSend = true)
        val injector = PaddingInjector(
            scope = this,
            config = PaddingConfig(enabled = true, probability = 1.0f, minBytes = 4, maxBytes = 4),
        )

        injector.onDataSent(sender)
        runCurrent()

        assertTrue(sender.writtenBytes.isEmpty())
    }
}
