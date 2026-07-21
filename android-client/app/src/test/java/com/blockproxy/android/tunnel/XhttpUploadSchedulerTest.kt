package com.blockproxy.android.tunnel

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

@OptIn(ExperimentalCoroutinesApi::class)
class XhttpUploadSchedulerTest {
    @Test
    fun `limits concurrent upload posts`() = runTest {
        val uploadClient = BlockingUploadClient()
        val scheduler = XhttpUploadScheduler(
            scope = this,
            baseUrl = "https://example.com/xhttp",
            sessionId = "sid",
            uploadClient = uploadClient,
            maxConcurrentPosts = 2,
        )

        val sends = (0 until 5).map {
            async {
                scheduler.sendFrame(FrameCodec.encode(Frame.Data(0x8000 + it, byteArrayOf(it.toByte()))))
            }
        }
        runCurrent()

        assertEquals(2, uploadClient.maxActive.get())
        assertEquals(2, uploadClient.active.get())

        repeat(5) {
            uploadClient.releaseOne()
            runCurrent()
        }
        sends.forEach { assertTrue(it.await()) }
        scheduler.close()
    }

    @Test
    fun `control frames are sent before queued forward data`() = runTest {
        val uploadClient = BlockingUploadClient()
        val scheduler = XhttpUploadScheduler(
            scope = this,
            baseUrl = "https://example.com/xhttp",
            sessionId = "sid",
            uploadClient = uploadClient,
            maxConcurrentPosts = 1,
        )

        val firstForward = async {
            scheduler.sendFrame(FrameCodec.encode(Frame.Data(0x8000, byteArrayOf(1))))
        }
        runCurrent()
        assertEquals(1, uploadClient.startedFrames.size)

        val secondForward = async {
            scheduler.sendFrame(FrameCodec.encode(Frame.Data(0x8001, byteArrayOf(2))))
        }
        val control = async {
            scheduler.sendFrame(FrameCodec.encode(Frame.Close(0x8000)))
        }
        runCurrent()
        assertFalse(secondForward.isCompleted)
        assertFalse(control.isCompleted)

        uploadClient.releaseOne()
        runCurrent()
        firstForward.await()
        delay(1)
        runCurrent()

        assertEquals(FrameType.CLOSE, uploadClient.startedFrames[1])
        uploadClient.releaseOne()
        runCurrent()
        assertTrue(control.await())

        uploadClient.releaseOne()
        runCurrent()
        assertTrue(secondForward.await())
        scheduler.close()
    }

    private class BlockingUploadClient : XhttpUploadClient {
        val active = AtomicInteger(0)
        val maxActive = AtomicInteger(0)
        val startedFrames = CopyOnWriteArrayList<FrameType>()
        private val releases = ArrayDeque<CompletableDeferred<Unit>>()

        override suspend fun postFrame(
            url: String,
            body: ByteArray,
            headers: Map<String, String>,
        ): Boolean {
            val now = active.incrementAndGet()
            maxActive.updateAndGet { current -> maxOf(current, now) }
            startedFrames.add(frameTypeOf(body))
            val release = CompletableDeferred<Unit>()
            releases.addLast(release)
            release.await()
            active.decrementAndGet()
            return true
        }

        fun releaseOne() {
            releases.removeFirst().complete(Unit)
        }

        private fun frameTypeOf(encoded: ByteArray): FrameType {
            return when (FrameCodec.decode(encoded)) {
                is Frame.Connect -> FrameType.CONNECT
                is Frame.Data -> FrameType.DATA
                is Frame.Close -> FrameType.CLOSE
                is Frame.ConnectOk -> FrameType.CONNECT_OK
                is Frame.ConnectFailed -> FrameType.CONNECT_FAILED
                is Frame.Ping -> FrameType.PING
                is Frame.Pong -> FrameType.PONG
                is Frame.Auth -> FrameType.AUTH
                Frame.AuthOk -> FrameType.AUTH_OK
                Frame.AuthFail -> FrameType.AUTH_FAIL
                is Frame.Error -> FrameType.ERROR
                is Frame.Capabilities -> FrameType.CAPABILITIES
                is Frame.Padding -> FrameType.PADDING
                is Frame.Unknown -> error("unexpected unknown frame")
            }
        }
    }
}
