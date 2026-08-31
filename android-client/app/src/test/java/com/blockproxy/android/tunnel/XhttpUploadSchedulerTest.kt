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
import java.io.IOException
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

    @Test
    fun `batches data frames until max frame count`() = runTest {
        val uploadClient = RecordingUploadClient()
        val scheduler = XhttpUploadScheduler(
            scope = this,
            baseUrl = "https://example.com/xhttp",
            sessionId = "sid",
            uploadClient = uploadClient,
            maxConcurrentPosts = 1,
            batchEnabled = true,
            batchFlushMs = 10_000L,
            batchMaxBytes = 16 * 1024,
            batchMaxFrames = 2,
        )

        val first = async {
            scheduler.sendFrame(FrameCodec.encode(Frame.Data(0x8000, byteArrayOf(1))))
        }
        val second = async {
            scheduler.sendFrame(FrameCodec.encode(Frame.Data(0x8001, byteArrayOf(2))))
        }
        runCurrent()

        assertTrue(first.await())
        assertTrue(second.await())
        assertEquals(1, uploadClient.bodies.size)
        assertEquals(2, FrameCodec.decodeMany(uploadClient.bodies[0]).size)
        scheduler.close()
    }

    @Test
    fun `control frame flushes separately from queued data`() = runTest {
        val uploadClient = RecordingUploadClient()
        val scheduler = XhttpUploadScheduler(
            scope = this,
            baseUrl = "https://example.com/xhttp",
            sessionId = "sid",
            uploadClient = uploadClient,
            maxConcurrentPosts = 1,
            batchEnabled = true,
            batchFlushMs = 10_000L,
        )

        val data = async {
            scheduler.sendFrame(FrameCodec.encode(Frame.Data(0x8000, byteArrayOf(1))))
        }
        runCurrent()
        val close = async {
            scheduler.sendFrame(FrameCodec.encode(Frame.Close(0x8000)))
        }
        runCurrent()

        assertTrue(data.await())
        assertTrue(close.await())
        assertEquals(2, uploadClient.bodies.size)
        assertEquals(1, FrameCodec.decodeMany(uploadClient.bodies[0]).size)
        assertTrue(FrameCodec.decodeMany(uploadClient.bodies[1]).single() is Frame.Close)
        scheduler.close()
    }

    @Test
    fun `notifies listener after consecutive failure threshold and debounces further failures`() = runTest {
        val uploadClient = FailingUploadClient { false }
        val notifications = AtomicInteger(0)
        val lastCount = AtomicInteger(0)
        val scheduler = XhttpUploadScheduler(
            scope = this,
            baseUrl = "https://example.com/xhttp",
            sessionId = "sid",
            uploadClient = uploadClient,
            maxConcurrentPosts = 1,
            consecutiveFailureThreshold = 3,
            uploadListener = { count ->
                notifications.incrementAndGet()
                lastCount.set(count)
            },
        )

        repeat(3) {
            val send = async { scheduler.sendFrame(FrameCodec.encode(Frame.Pong(byteArrayOf(1)))) }
            runCurrent()
            assertFalse(send.await())
        }
        assertEquals(1, notifications.get())
        assertEquals(3, lastCount.get())

        // 继续失败不重复通知（防抖），直到失败数翻倍
        repeat(2) {
            val send = async { scheduler.sendFrame(FrameCodec.encode(Frame.Pong(byteArrayOf(1)))) }
            runCurrent()
            assertFalse(send.await())
        }
        assertEquals(1, notifications.get())
        scheduler.close()
    }

    @Test
    fun `re-notifies when consecutive failures double after threshold`() = runTest {
        val uploadClient = FailingUploadClient { false }
        val notifications = AtomicInteger(0)
        val lastCount = AtomicInteger(0)
        val scheduler = XhttpUploadScheduler(
            scope = this,
            baseUrl = "https://example.com/xhttp",
            sessionId = "sid",
            uploadClient = uploadClient,
            maxConcurrentPosts = 1,
            consecutiveFailureThreshold = 2,
            uploadListener = { count ->
                notifications.incrementAndGet()
                lastCount.set(count)
            },
        )

        repeat(6) {
            val send = async { scheduler.sendFrame(FrameCodec.encode(Frame.Pong(byteArrayOf(1)))) }
            runCurrent()
            assertFalse(send.await())
        }

        // 阈值 2 通知一次，失败数翻倍到 4 再通知一次，6 次时尚未到 8
        assertEquals(2, notifications.get())
        assertEquals(4, lastCount.get())
        scheduler.close()
    }

    @Test
    fun `success resets failure count and re-arms notification`() = runTest {
        val uploadClient = FailingUploadClient { call -> call == 2 } // 前两次失败，第 3 次成功
        val notifications = AtomicInteger(0)
        val scheduler = XhttpUploadScheduler(
            scope = this,
            baseUrl = "https://example.com/xhttp",
            sessionId = "sid",
            uploadClient = uploadClient,
            maxConcurrentPosts = 1,
            consecutiveFailureThreshold = 2,
            uploadListener = { notifications.incrementAndGet() },
        )

        // 失败 2 次 → 通知
        repeat(2) {
            val send = async { scheduler.sendFrame(FrameCodec.encode(Frame.Pong(byteArrayOf(1)))) }
            runCurrent()
            assertFalse(send.await())
        }
        assertEquals(1, notifications.get())

        // 成功 → 计数归零
        val success = async { scheduler.sendFrame(FrameCodec.encode(Frame.Pong(byteArrayOf(1)))) }
        runCurrent()
        assertTrue(success.await())
        assertEquals(0, scheduler.consecutiveFailures)

        // 再失败 2 次 → 重新武装后再次通知
        repeat(2) {
            val send = async { scheduler.sendFrame(FrameCodec.encode(Frame.Pong(byteArrayOf(1)))) }
            runCurrent()
            assertFalse(send.await())
        }
        assertEquals(2, notifications.get())
        scheduler.close()
    }

    @Test
    fun `exception from upload client counts as failure`() = runTest {
        val uploadClient = FailingUploadClient { null } // null = 抛异常
        val scheduler = XhttpUploadScheduler(
            scope = this,
            baseUrl = "https://example.com/xhttp",
            sessionId = "sid",
            uploadClient = uploadClient,
            maxConcurrentPosts = 1,
        )

        val send = async { scheduler.sendFrame(FrameCodec.encode(Frame.Pong(byteArrayOf(1)))) }
        runCurrent()
        assertFalse(send.await())
        assertEquals(1, scheduler.consecutiveFailures)

        // worker 未崩溃，后续任务继续处理
        val second = async { scheduler.sendFrame(FrameCodec.encode(Frame.Pong(byteArrayOf(2)))) }
        runCurrent()
        assertFalse(second.await())
        assertEquals(2, scheduler.consecutiveFailures)
        scheduler.close()
    }

    @Test
    fun `closing scheduler with pending tasks does not count as failures`() = runTest {
        val uploadClient = BlockingUploadClient()
        val notifications = AtomicInteger(0)
        val scheduler = XhttpUploadScheduler(
            scope = this,
            baseUrl = "https://example.com/xhttp",
            sessionId = "sid",
            uploadClient = uploadClient,
            maxConcurrentPosts = 1,
            consecutiveFailureThreshold = 1,
            uploadListener = { notifications.incrementAndGet() },
        )

        val send = async { scheduler.sendFrame(FrameCodec.encode(Frame.Pong(byteArrayOf(1)))) }
        runCurrent()
        scheduler.close()
        runCurrent()

        assertFalse(send.await())
        assertEquals(0, scheduler.consecutiveFailures)
        assertEquals(0, notifications.get())
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

    private class RecordingUploadClient : XhttpUploadClient {
        val bodies = CopyOnWriteArrayList<ByteArray>()

        override suspend fun postFrame(
            url: String,
            body: ByteArray,
            headers: Map<String, String>,
        ): Boolean {
            bodies.add(body)
            return true
        }
    }

    /**
     * 脚本化失败的上行客户端：按调用次序决定结果。
     * 返回 true/false 表示成功/失败，返回 null 抛异常。
     */
    private class FailingUploadClient(
        private val scripted: (call: Int) -> Boolean?,
    ) : XhttpUploadClient {
        private val calls = AtomicInteger(0)

        override suspend fun postFrame(
            url: String,
            body: ByteArray,
            headers: Map<String, String>,
        ): Boolean {
            val call = calls.getAndIncrement()
            return when (val result = scripted(call)) {
                null -> throw IOException("simulated upload failure")
                else -> result
            }
        }
    }
}
