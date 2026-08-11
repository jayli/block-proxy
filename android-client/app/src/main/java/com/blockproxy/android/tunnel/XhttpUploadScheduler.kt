package com.blockproxy.android.tunnel

import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ClosedSendChannelException
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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
    private val batchEnabled: Boolean = false,
    private val batchFlushMs: Long = DEFAULT_BATCH_FLUSH_MS,
    private val batchMaxBytes: Int = DEFAULT_BATCH_MAX_BYTES,
    private val batchMaxFrames: Int = DEFAULT_BATCH_MAX_FRAMES,
) {
    companion object {
        const val DEFAULT_MAX_CONCURRENT_POSTS = 4
        const val DEFAULT_CONTROL_CAPACITY = 256
        const val DEFAULT_REVERSE_CAPACITY = 128
        const val DEFAULT_FORWARD_CAPACITY = 128
        const val DEFAULT_BATCH_FLUSH_MS = 10L
        const val DEFAULT_BATCH_MAX_BYTES = 16 * 1024
        const val DEFAULT_BATCH_MAX_FRAMES = 32
    }

    private enum class Priority { CONTROL, REVERSE, FORWARD }

    private data class UploadTask(
        val seq: Long,
        val encoded: ByteArray,
        val results: List<CompletableDeferred<Boolean>>,
        val priority: Priority,
    )

    private data class PendingFrame(
        val encoded: ByteArray,
        val result: CompletableDeferred<Boolean>,
    )

    private val controlQueue = Channel<UploadTask>(controlCapacity)
    private val reverseQueue = Channel<UploadTask>(reverseCapacity)
    private val forwardQueue = Channel<UploadTask>(forwardCapacity)
    private val seqCounter = AtomicLong(0)
    private val closed = AtomicBoolean(false)
    private val pendingTasks = ConcurrentHashMap<Long, UploadTask>()
    private val batchMutex = Mutex()
    private val batchBuffers = mutableMapOf<Priority, MutableList<PendingFrame>>()
    private val batchTimers = mutableMapOf<Priority, Job>()
    private val workers: List<Job>

    init {
        workers = List(maxConcurrentPosts.coerceAtLeast(1)) {
            scope.launch { workerLoop() }
        }
    }

    suspend fun sendFrame(encoded: ByteArray): Boolean {
        if (closed.get()) return false
        val result = CompletableDeferred<Boolean>()
        val priority = priorityOf(encoded)

        return try {
            if (batchEnabled && isBatchable(encoded)) {
                enqueueTasks(addToBatch(priority, PendingFrame(encoded, result)))
            } else {
                if (batchEnabled) {
                    enqueueTasks(drainAllBatches())
                }
                enqueueTask(newUploadTask(encoded, listOf(result), priority))
            }
            result.await()
        } catch (_: ClosedSendChannelException) {
            false
        } catch (_: IllegalStateException) {
            false
        }
    }

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        controlQueue.close()
        reverseQueue.close()
        forwardQueue.close()
        batchTimers.values.forEach { it.cancel() }
        batchTimers.clear()
        batchBuffers.values.flatten().forEach { it.result.complete(false) }
        batchBuffers.clear()
        pendingTasks.values.forEach { task ->
            task.results.forEach { it.complete(false) }
        }
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
                task.results.forEach { it.complete(ok) }
            } catch (e: CancellationException) {
                task.results.forEach { it.complete(false) }
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

    private suspend fun addToBatch(priority: Priority, frame: PendingFrame): List<UploadTask> {
        return batchMutex.withLock {
            val ready = mutableListOf<UploadTask>()
            val buffer = batchBuffers.getOrPut(priority) { mutableListOf() }

            if (buffer.isNotEmpty() && batchBytes(buffer) + frame.encoded.size > batchMaxBytes) {
                ready.add(buildBatchTask(priority, buffer))
                buffer.clear()
                cancelBatchTimer(priority)
            }

            buffer.add(frame)

            if (buffer.size >= batchMaxFrames || batchBytes(buffer) >= batchMaxBytes) {
                ready.add(buildBatchTask(priority, buffer))
                buffer.clear()
                cancelBatchTimer(priority)
            } else {
                scheduleBatchTimer(priority)
            }

            ready
        }
    }

    private suspend fun drainAllBatches(): List<UploadTask> {
        return batchMutex.withLock {
            val ready = mutableListOf<UploadTask>()
            for (priority in Priority.values()) {
                val buffer = batchBuffers[priority].orEmpty()
                if (buffer.isNotEmpty()) {
                    ready.add(buildBatchTask(priority, buffer))
                    batchBuffers[priority]?.clear()
                }
                cancelBatchTimer(priority)
            }
            ready
        }
    }

    private suspend fun drainBatch(priority: Priority): UploadTask? {
        return batchMutex.withLock {
            val buffer = batchBuffers[priority].orEmpty()
            if (buffer.isEmpty()) return@withLock null
            val task = buildBatchTask(priority, buffer)
            batchBuffers[priority]?.clear()
            cancelBatchTimer(priority)
            task
        }
    }

    private fun scheduleBatchTimer(priority: Priority) {
        if (batchTimers[priority]?.isActive == true) return
        batchTimers[priority] = scope.launch {
            delay(batchFlushMs.coerceAtLeast(1L))
            val task = drainBatch(priority)
            if (task != null) {
                try {
                    enqueueTask(task)
                } catch (_: Throwable) {
                    task.results.forEach { it.complete(false) }
                }
            }
        }
    }

    private fun cancelBatchTimer(priority: Priority) {
        batchTimers.remove(priority)?.cancel()
    }

    private fun buildBatchTask(priority: Priority, frames: List<PendingFrame>): UploadTask {
        val body = ByteArray(frames.sumOf { it.encoded.size })
        var offset = 0
        for (frame in frames) {
            System.arraycopy(frame.encoded, 0, body, offset, frame.encoded.size)
            offset += frame.encoded.size
        }
        return newUploadTask(body, frames.map { it.result }, priority)
    }

    private fun newUploadTask(
        encoded: ByteArray,
        results: List<CompletableDeferred<Boolean>>,
        priority: Priority,
    ): UploadTask {
        return UploadTask(
            seq = seqCounter.getAndIncrement(),
            encoded = encoded,
            results = results,
            priority = priority,
        )
    }

    private suspend fun enqueueTasks(tasks: List<UploadTask>) {
        for (task in tasks) {
            enqueueTask(task)
        }
    }

    private suspend fun enqueueTask(task: UploadTask) {
        pendingTasks[task.seq] = task
        try {
            queueFor(task.priority).send(task)
        } catch (t: Throwable) {
            pendingTasks.remove(task.seq)
            task.results.forEach { it.complete(false) }
            throw t
        }
    }

    private fun queueFor(priority: Priority): Channel<UploadTask> {
        return when (priority) {
            Priority.CONTROL -> controlQueue
            Priority.REVERSE -> reverseQueue
            Priority.FORWARD -> forwardQueue
        }
    }

    private fun batchBytes(frames: List<PendingFrame>): Int =
        frames.sumOf { it.encoded.size }

    private fun isBatchable(encoded: ByteArray): Boolean {
        return try {
            when (FrameCodec.decode(encoded)) {
                is Frame.Data,
                is Frame.Padding -> true
                else -> false
            }
        } catch (_: Throwable) {
            false
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
