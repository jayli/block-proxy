package com.blockproxy.android.tunnel

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

@OptIn(ExperimentalCoroutinesApi::class)
class SendQueueTest {

    @Test
    fun `enqueue order is preserved`() = runTest {
        val written = CopyOnWriteArrayList<ByteArray>()
        val queue = SendQueue(this) { bytes -> written.add(bytes) }

        queue.enqueue(byteArrayOf(1))
        queue.enqueue(byteArrayOf(2))
        queue.enqueue(byteArrayOf(3))

        advanceUntilIdle()

        assertEquals(3, written.size)
        assertArrayEquals(byteArrayOf(1), written[0])
        assertArrayEquals(byteArrayOf(2), written[1])
        assertArrayEquals(byteArrayOf(3), written[2])

        queue.close()
    }

    @Test
    fun `slow writer blocks subsequent enqueue`() = runTest {
        val written = CopyOnWriteArrayList<ByteArray>()
        val queue = SendQueue(this) { bytes ->
            delay(100)
            written.add(bytes)
        }

        val job1 = async { queue.enqueue(byteArrayOf(1)) }
        val job2 = async { queue.enqueue(byteArrayOf(2)) }

        // Before advancing time, nothing written yet
        assertTrue(written.isEmpty())

        advanceUntilIdle()

        assertTrue(job1.isCompleted)
        assertTrue(job2.isCompleted)
        assertEquals(2, written.size)
        assertArrayEquals(byteArrayOf(1), written[0])
        assertArrayEquals(byteArrayOf(2), written[1])

        queue.close()
    }

    @Test
    fun `cancel scope stops accepting new work`() = runTest {
        val written = CopyOnWriteArrayList<ByteArray>()
        val scope = TestScope(UnconfinedTestDispatcher(testScheduler))
        val queue = SendQueue(scope) { bytes -> written.add(bytes) }

        queue.enqueue(byteArrayOf(1))
        advanceUntilIdle()
        assertEquals(1, written.size)

        // Cancel the scope
        scope.cancel()
        advanceUntilIdle()

        // After cancel, enqueue should fail
        try {
            queue.enqueue(byteArrayOf(2))
            fail("Expected exception after cancel")
        } catch (e: Exception) {
            // Expected - channel should be closed
        }
    }

    @Test
    fun `writer exception closes queue`() = runTest {
        val written = CopyOnWriteArrayList<ByteArray>()
        val queue = SendQueue(this) { bytes ->
            if (bytes[0] == 2.toByte()) {
                throw RuntimeException("write error")
            }
            written.add(bytes)
        }

        queue.enqueue(byteArrayOf(1))
        queue.enqueue(byteArrayOf(2)) // This will throw
        advanceUntilIdle()

        // First write should succeed
        assertEquals(1, written.size)
        assertArrayEquals(byteArrayOf(1), written[0])

        // After exception, queue should be closed
        try {
            queue.enqueue(byteArrayOf(3))
            fail("Expected exception after writer error")
        } catch (e: Exception) {
            // Expected
        }

        // Consumer job should have completed
        assertTrue(queue.isClosed())
    }

    @Test
    fun `mixed frame types preserve order`() = runTest {
        val written = CopyOnWriteArrayList<ByteArray>()
        val queue = SendQueue(this) { bytes -> written.add(bytes) }

        // Simulate different frame types as byte arrays
        val pong = byteArrayOf(0x00, 0x01, 0x11)
        val connectOk = byteArrayOf(0x00, 0x03, 0x04, 0x00, 0x01)
        val connectFailed = byteArrayOf(0x00, 0x03, 0x81.toByte(), 0x7F, 0xFF.toByte())
        val data = byteArrayOf(0x00, 0x05, 0x02, 0x00, 0x01, 0xAB.toByte(), 0xCD.toByte())
        val close = byteArrayOf(0x00, 0x03, 0x03, 0x00, 0x01)

        queue.enqueue(pong)
        queue.enqueue(connectOk)
        queue.enqueue(connectFailed)
        queue.enqueue(data)
        queue.enqueue(close)

        advanceUntilIdle()

        assertEquals(5, written.size)
        assertArrayEquals(pong, written[0])
        assertArrayEquals(connectOk, written[1])
        assertArrayEquals(connectFailed, written[2])
        assertArrayEquals(data, written[3])
        assertArrayEquals(close, written[4])

        queue.close()
    }

    @Test
    fun `close waits for pending writes`() = runTest {
        val written = CopyOnWriteArrayList<ByteArray>()
        val queue = SendQueue(this) { bytes ->
            delay(50)
            written.add(bytes)
        }

        queue.enqueue(byteArrayOf(1))
        queue.enqueue(byteArrayOf(2))
        queue.enqueue(byteArrayOf(3))

        queue.close()

        // After close, all pending writes should be done
        assertEquals(3, written.size)
        assertArrayEquals(byteArrayOf(1), written[0])
        assertArrayEquals(byteArrayOf(2), written[1])
        assertArrayEquals(byteArrayOf(3), written[2])
    }

    @Test
    fun `enqueue after close throws`() = runTest {
        val written = CopyOnWriteArrayList<ByteArray>()
        val queue = SendQueue(this) { bytes -> written.add(bytes) }

        queue.enqueue(byteArrayOf(1))
        queue.close()

        try {
            queue.enqueue(byteArrayOf(2))
            fail("Expected exception after close")
        } catch (e: Exception) {
            // Expected
        }
    }

    @Test
    fun `empty queue close succeeds`() = runTest {
        val written = CopyOnWriteArrayList<ByteArray>()
        val queue = SendQueue(this) { bytes -> written.add(bytes) }

        queue.close()

        assertEquals(0, written.size)
    }
}
