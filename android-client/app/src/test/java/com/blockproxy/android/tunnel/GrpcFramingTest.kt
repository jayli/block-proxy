package com.blockproxy.android.tunnel

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class GrpcFramingTest {
    @Test
    fun `encode wraps tunnel frame as grpc TunnelFrame message`() {
        val frame = byteArrayOf(0x00, 0x01, 0x21)

        val encoded = GrpcFraming.encode(frame)

        assertArrayEquals(
            byteArrayOf(
                0x00, 0x00, 0x00, 0x00, 0x05,
                0x0a, 0x03, 0x00, 0x01, 0x21,
            ),
            encoded,
        )
    }

    @Test
    fun `decoder emits complete frames and buffers partial grpc messages`() {
        val frame1 = byteArrayOf(0x00, 0x01, 0x21)
        val frame2 = byteArrayOf(0x00, 0x01, 0x22)
        val decoder = GrpcFraming.Decoder()
        val first = GrpcFraming.encode(frame1)
        val second = GrpcFraming.encode(frame2)

        assertEquals(emptyList<ByteArray>(), decoder.feed(first.copyOfRange(0, 3)))
        assertArrayEquals(frame1, decoder.feed(first.copyOfRange(3, first.size)).single())
        assertArrayEquals(frame2, decoder.feed(second).single())
    }
}
