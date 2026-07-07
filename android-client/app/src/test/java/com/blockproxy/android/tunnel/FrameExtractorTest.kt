package com.blockproxy.android.tunnel

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class FrameExtractorTest {

    private lateinit var extractor: FrameExtractor

    @Before
    fun setUp() {
        extractor = FrameExtractor()
    }

    @Test
    fun `one complete frame in one append`() {
        val frame = Frame.Ping
        val encoded = FrameCodec.encode(frame)

        extractor.append(encoded)
        val extracted = extractor.nextFrame()

        assertNotNull(extracted)
        assertEquals(frame, extracted)
    }

    @Test
    fun `length prefix split across two appends`() {
        val frame = Frame.Pong
        val encoded = FrameCodec.encode(frame)

        // Append first byte of length prefix
        extractor.append(byteArrayOf(encoded[0]))
        assertNull(extractor.nextFrame())

        // Append second byte of length prefix and payload
        extractor.append(encoded.sliceArray(1 until encoded.size))
        val extracted = extractor.nextFrame()

        assertNotNull(extracted)
        assertEquals(frame, extracted)
    }

    @Test
    fun `payload split across multiple appends`() {
        val frame = Frame.Auth("user", "pass")
        val encoded = FrameCodec.encode(frame)

        // Append length prefix and first byte of payload
        extractor.append(encoded.sliceArray(0 until 3))
        assertNull(extractor.nextFrame())

        // Append second byte of payload
        extractor.append(byteArrayOf(encoded[3]))
        assertNull(extractor.nextFrame())

        // Append remaining bytes
        extractor.append(encoded.sliceArray(4 until encoded.size))
        val extracted = extractor.nextFrame()

        assertNotNull(extracted)
        assertEquals(frame, extracted)
    }

    @Test
    fun `two frames in one append`() {
        val frame1 = Frame.Ping
        val frame2 = Frame.Pong
        val encoded1 = FrameCodec.encode(frame1)
        val encoded2 = FrameCodec.encode(frame2)

        val combined = encoded1 + encoded2
        extractor.append(combined)

        val extracted1 = extractor.nextFrame()
        assertNotNull(extracted1)
        assertEquals(frame1, extracted1)

        val extracted2 = extractor.nextFrame()
        assertNotNull(extracted2)
        assertEquals(frame2, extracted2)

        assertNull(extractor.nextFrame())
    }

    @Test
    fun `one and a half frames then remaining bytes`() {
        val frame1 = Frame.Ping
        val frame2 = Frame.Auth("test", "secret")
        val encoded1 = FrameCodec.encode(frame1)
        val encoded2 = FrameCodec.encode(frame2)

        // Append first frame and half of second frame
        val halfPoint = encoded2.size / 2
        extractor.append(encoded1 + encoded2.sliceArray(0 until halfPoint))

        val extracted1 = extractor.nextFrame()
        assertNotNull(extracted1)
        assertEquals(frame1, extracted1)

        assertNull(extractor.nextFrame())

        // Append remaining bytes of second frame
        extractor.append(encoded2.sliceArray(halfPoint until encoded2.size))
        val extracted2 = extractor.nextFrame()

        assertNotNull(extracted2)
        assertEquals(frame2, extracted2)
    }

    @Test
    fun `decode failure throws exception`() {
        // Create a complete but malformed frame:
        // Length prefix = 1, payload = 0x01 (CONNECT type) which requires more bytes
        val invalidData = byteArrayOf(0x00, 0x01, 0x01)

        extractor.append(invalidData)

        try {
            extractor.nextFrame()
            fail("Expected IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            // Expected: CONNECT frame requires at least reqid (2 bytes) but payload is only 1 byte
        }
    }

    @Test
    fun `partial bytes do not count as complete frame`() {
        val frame = Frame.Ping
        val encoded = FrameCodec.encode(frame)

        // Append only partial data (missing last byte)
        extractor.append(encoded.sliceArray(0 until encoded.size - 1))
        assertNull(extractor.nextFrame())

        // Append the missing byte
        extractor.append(byteArrayOf(encoded.last()))
        val extracted = extractor.nextFrame()

        assertNotNull(extracted)
        assertEquals(frame, extracted)
    }

    @Test
    fun `large payload extraction does not box bytes`() {
        // Create a Data frame with maximum payload (65532 bytes)
        val largePayload = ByteArray(FrameCodec.MAX_DATA_CHUNK) { it.toByte() }
        val frame = Frame.Data(1, largePayload)
        val encoded = FrameCodec.encode(frame)

        extractor.append(encoded)
        val extracted = extractor.nextFrame()

        assertNotNull(extracted)
        assertTrue(extracted is Frame.Data)
        val dataFrame = extracted as Frame.Data
        assertEquals(1, dataFrame.reqid)
        assertArrayEquals(largePayload, dataFrame.payload)
    }

    @Test
    fun `clear resets buffer`() {
        val frame = Frame.Ping
        val encoded = FrameCodec.encode(frame)

        extractor.append(encoded)
        extractor.clear()

        assertNull(extractor.nextFrame())
    }

    @Test
    fun `compaction triggers after threshold exceeded`() {
        // Create large frames to exceed the 4KB compaction threshold
        val largePayload = ByteArray(3000) { it.toByte() }
        val largeFrame = Frame.Data(1, largePayload)
        val encoded = FrameCodec.encode(largeFrame)

        // Append and extract two large frames (total readOffset > 4096)
        extractor.append(encoded + encoded)
        val frame1 = extractor.nextFrame()
        assertNotNull(frame1)
        val frame2 = extractor.nextFrame()
        assertNotNull(frame2)

        // After extracting ~6KB of data, compaction should have occurred
        // Append another frame and verify it still works
        extractor.append(encoded)
        val frame3 = extractor.nextFrame()
        assertNotNull(frame3)
        assertNull(extractor.nextFrame())
    }

    @Test
    fun `empty append does not affect state`() {
        val frame = Frame.Ping
        val encoded = FrameCodec.encode(frame)

        extractor.append(encoded)
        extractor.append(byteArrayOf())

        val extracted = extractor.nextFrame()
        assertNotNull(extracted)
        assertEquals(frame, extracted)
    }

    @Test
    fun `zero length frame is invalid`() {
        // Length prefix of 0
        val invalidData = byteArrayOf(0x00, 0x00)

        extractor.append(invalidData)

        try {
            extractor.nextFrame()
            fail("Expected IllegalArgumentException for zero-length frame")
        } catch (e: IllegalArgumentException) {
            // Expected
        }
    }
}
