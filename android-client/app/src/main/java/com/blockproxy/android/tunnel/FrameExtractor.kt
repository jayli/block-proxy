package com.blockproxy.android.tunnel

import java.io.ByteArrayOutputStream

/**
 * Extracts complete frames from a TCP byte stream.
 *
 * Handles TCP stream fragmentation by buffering incoming bytes and
 * returning complete frames one at a time. Uses ByteArrayOutputStream
 * with a readOffset to avoid per-byte boxing that would occur with
 * ArrayDeque<Byte> or MutableList<Byte>.
 *
 * **Thread safety:** Not thread-safe. Must be used from a single thread
 * (or externally synchronized). This is the typical pattern for a
 * tunnel read loop.
 */
class FrameExtractor {
    private val buffer = ByteArrayOutputStream()
    private var readOffset = 0

    // Threshold for triggering compaction (4KB)
    private companion object {
        const val COMPACTION_THRESHOLD = 4096
    }

    /**
     * Appends bytes to the internal buffer.
     */
    fun append(bytes: ByteArray) {
        buffer.write(bytes)
    }

    /**
     * Returns the next complete frame if available, or null if not enough bytes.
     * Throws IllegalArgumentException if the frame data is malformed.
     */
    fun nextFrame(): Frame? {
        val data = buffer.toByteArray()
        val available = data.size - readOffset

        // Need at least 2 bytes for the length prefix
        if (available < 2) {
            return null
        }

        // Read the 2-byte big-endian length prefix
        val length = ((data[readOffset].toInt() and 0xFF) shl 8) or
                     (data[readOffset + 1].toInt() and 0xFF)

        // Validate length
        if (length == 0) {
            throw IllegalArgumentException("Zero-length frame is invalid")
        }

        // Check if we have the complete frame (2 bytes prefix + length bytes payload)
        val frameSize = 2 + length
        if (available < frameSize) {
            return null
        }

        // Extract the complete frame bytes
        val frameBytes = data.sliceArray(readOffset until readOffset + frameSize)
        readOffset += frameSize

        // Compact buffer if readOffset is large enough
        compactIfNeeded(data)

        // Decode the frame (this will throw on malformed data)
        return FrameCodec.decode(frameBytes)
    }

    /**
     * Resets the buffer, discarding all buffered bytes.
     */
    fun clear() {
        buffer.reset()
        readOffset = 0
    }

    /**
     * Compacts the buffer by shifting remaining bytes to the front
     * when readOffset exceeds the threshold. Reuses the already-extracted
     * data array to avoid a second toByteArray() allocation.
     */
    private fun compactIfNeeded(data: ByteArray) {
        if (readOffset >= COMPACTION_THRESHOLD) {
            val remaining = data.size - readOffset
            if (remaining > 0) {
                val remainingBytes = data.sliceArray(readOffset until data.size)
                buffer.reset()
                buffer.write(remainingBytes)
            } else {
                buffer.reset()
            }
            readOffset = 0
        }
    }
}
