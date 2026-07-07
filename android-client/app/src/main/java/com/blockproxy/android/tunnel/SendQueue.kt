package com.blockproxy.android.tunnel

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Serial write queue for tunnel outbound frames.
 *
 * All bytes enqueued through the same SendQueue are written to the
 * underlying transport in FIFO order by a single consumer coroutine,
 * guaranteeing that frames on one tunnel connection are never interleaved.
 */
class SendQueue(
    scope: CoroutineScope,
    private val writer: suspend (ByteArray) -> Unit,
) {
    private val channel = Channel<ByteArray>(Channel.UNLIMITED)
    private val consumerJob: Job

    init {
        consumerJob = scope.launch {
            try {
                for (bytes in channel) {
                    writer(bytes)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // Writer threw — will close the channel in finally
            } finally {
                // Ensure channel is closed so subsequent enqueue() calls fail,
                // whether the consumer completed normally, threw, or was cancelled
                channel.close()
            }
        }
    }

    /**
     * Enqueue a byte array for serial writing.
     *
     * Suspends if the internal buffer is full (currently unlimited, so
     * this only suspends on backpressure from the channel itself).
     * Throws if the queue has been closed (either explicitly or due to
     * a writer exception).
     */
    suspend fun enqueue(bytes: ByteArray) {
        channel.send(bytes)
    }

    /**
     * Close the queue and wait for all pending writes to complete.
     *
     * After this call returns, any subsequent enqueue() will throw.
     */
    suspend fun close() {
        channel.close()
        consumerJob.join()
    }

    /**
     * Check if the queue has been closed.
     *
     * Returns true if the channel is closed for send (either explicitly
     * via close() or due to a writer exception or scope cancellation).
     */
    fun isClosed(): Boolean = channel.isClosedForSend
}
