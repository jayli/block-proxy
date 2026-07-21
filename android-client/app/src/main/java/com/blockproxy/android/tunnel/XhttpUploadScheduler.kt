package com.blockproxy.android.tunnel

import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ClosedSendChannelException
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

private const val UPLOAD_SCHEDULER_TAG = "XhttpUploadScheduler"

/**
 * Bounded, priority-aware upload scheduler for xhttp POST frames.
 *
 * It prevents OkHttp/native upload calls from growing without bound. Queue
 * pressure suspends the producing coroutine, which propagates TCP back-pressure
 * instead of dropping bytes.
 */
class XhttpUploadScheduler(
    private val scope: CoroutineScope,
    private val baseUrl: String,
    private val sessionId: String,
    private val uploadClient: XhttpUploadClient,
    private val paddingHeaders: () -> Map<String, String> = { emptyMap() },
    maxConcurrentPosts: Int = DEFAULT_MAX_CONCURRENT_POSTS,
    controlCapacity: Int = DEFAULT_CONTROL_CAPACITY,
    reverseCapacity: Int = DEFAULT_REVERSE_CAPACITY,
    forwardCapacity: Int = DEFAULT_FORWARD_CAPACITY,
) {
    companion object {
        const val DEFAULT_MAX_CONCURRENT_POSTS = 4
        const val DEFAULT_CONTROL_CAPACITY = 256
        const val DEFAULT_REVERSE_CAPACITY = 128
        const val DEFAULT_FORWARD_CAPACITY = 128
    }

    private enum class Priority { CONTROL, REVERSE, FORWARD }

    private data class UploadTask(
        val seq: Long,
        val encoded: ByteArray,
        val result: CompletableDeferred<Boolean>,
    )

    private val controlQueue = Channel<UploadTask>(controlCapacity)
    private val reverseQueue = Channel<UploadTask>(reverseCapacity)
    private val forwardQueue = Channel<UploadTask>(forwardCapacity)
    private val seqCounter = AtomicLong(0)
    private val closed = AtomicBoolean(false)
    private val pendingTasks = ConcurrentHashMap<Long, UploadTask>()
    private val workers: List<Job>

    init {
        workers = List(maxConcurrentPosts.coerceAtLeast(1)) {
            scope.launch { workerLoop() }
        }
    }

    suspend fun sendFrame(encoded: ByteArray): Boolean {
        if (closed.get()) return false
        val task = UploadTask(
            seq = seqCounter.getAndIncrement(),
            encoded = encoded,
            result = CompletableDeferred(),
        )
        pendingTasks[task.seq] = task
        val queue = when (priorityOf(encoded)) {
            Priority.CONTROL -> controlQueue
            Priority.REVERSE -> reverseQueue
            Priority.FORWARD -> forwardQueue
        }
        return try {
            queue.send(task)
            task.result.await()
        } catch (_: ClosedSendChannelException) {
            false
        } catch (_: IllegalStateException) {
            false
        } finally {
            pendingTasks.remove(task.seq)
        }
    }

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        controlQueue.close()
        reverseQueue.close()
        forwardQueue.close()
        pendingTasks.values.forEach { it.result.complete(false) }
        pendingTasks.clear()
        workers.forEach { it.cancel() }
    }

    private suspend fun workerLoop() {
        while (scope.isActive && !closed.get()) {
            val task = receiveTask() ?: break
            try {
                val ok = try {
                    uploadClient.postFrame(
                        url = "$baseUrl/upload/$sessionId/${task.seq}",
                        body = task.encoded,
                        headers = paddingHeaders(),
                    )
                } catch (e: CancellationException) {
                    throw e
                } catch (t: Throwable) {
                    Log.w(UPLOAD_SCHEDULER_TAG, "Upload worker failed: ${t.message}")
                    false
                }
                task.result.complete(ok)
            } catch (e: CancellationException) {
                task.result.complete(false)
                throw e
            } finally {
                pendingTasks.remove(task.seq)
            }
        }
    }

    private suspend fun receiveTask(): UploadTask? {
        controlQueue.tryReceive().getOrNull()?.let { return it }
        reverseQueue.tryReceive().getOrNull()?.let { return it }
        forwardQueue.tryReceive().getOrNull()?.let { return it }

        return select {
            controlQueue.onReceiveCatching { it.getOrNull() }
            reverseQueue.onReceiveCatching { it.getOrNull() }
            forwardQueue.onReceiveCatching { it.getOrNull() }
        }
    }

    private fun priorityOf(encoded: ByteArray): Priority {
        return try {
            when (val frame = FrameCodec.decode(encoded)) {
                is Frame.Data -> if (isForwardReqid(frame.reqid)) Priority.FORWARD else Priority.REVERSE
                is Frame.Connect -> if (isForwardReqid(frame.reqid)) Priority.FORWARD else Priority.CONTROL
                is Frame.Padding -> Priority.FORWARD
                else -> Priority.CONTROL
            }
        } catch (_: Throwable) {
            Priority.CONTROL
        }
    }

    private fun isForwardReqid(reqid: Int): Boolean =
        reqid in ForwardSessionRegistry.FORWARD_REQID_MIN..ForwardSessionRegistry.FORWARD_REQID_MAX
}
