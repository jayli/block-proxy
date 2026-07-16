package com.blockproxy.android.tunnel

import org.junit.Assert.*
import org.junit.Test

class FrameCodecTest {

    // ========== Test Vectors (MUST pass exactly) ==========

    @Test
    fun `encode Ping`() {
        assertArrayEquals(
            byteArrayOf(0x00, 0x01, 0x10),
            FrameCodec.encode(Frame.Ping(byteArrayOf()))
        )
    }

    @Test
    fun `encode Pong`() {
        assertArrayEquals(
            byteArrayOf(0x00, 0x01, 0x11),
            FrameCodec.encode(Frame.Pong(byteArrayOf()))
        )
    }

    @Test
    fun `encode Auth`() {
        assertArrayEquals(
            byteArrayOf(0x00, 0x0D, 0x20, 0x05, 0x61, 0x64, 0x6D, 0x69, 0x6E, 0x04, 0x70, 0x61, 0x73, 0x73, 0x00),
            FrameCodec.encode(Frame.Auth("admin", "pass"))
        )
    }

    @Test
    fun `encode and decode Auth with capabilities`() {
        val encoded = FrameCodec.encode(Frame.Auth("admin", "pass", listOf("padding")))
        val decoded = FrameCodec.decode(encoded)

        assertTrue(decoded is Frame.Auth)
        val auth = decoded as Frame.Auth
        assertEquals("admin", auth.username)
        assertEquals("pass", auth.password)
        assertEquals(listOf("padding"), auth.capabilities)
    }

    @Test
    fun `silent mode capability constant is encoded in auth`() {
        val encoded = FrameCodec.encode(Frame.Auth("admin", "pass", listOf(FrameCodec.CAP_SILENT_MODE)))
        val decoded = FrameCodec.decode(encoded) as Frame.Auth

        assertEquals(listOf("silent_mode"), decoded.capabilities)
    }

    @Test
    fun `encode and decode Capabilities`() {
        val original = Frame.Capabilities(listOf("padding"))
        val encoded = FrameCodec.encode(original)

        assertArrayEquals(
            byteArrayOf(0x00, 0x0A, 0x24, 0x01, 0x07, 0x70, 0x61, 0x64, 0x64, 0x69, 0x6E, 0x67),
            encoded
        )
        assertEquals(original, FrameCodec.decode(encoded))
    }

    @Test
    fun `encode ConnectOk`() {
        assertArrayEquals(
            byteArrayOf(0x00, 0x03, 0x04, 0x00, 0x01),
            FrameCodec.encode(Frame.ConnectOk(1))
        )
    }

    @Test
    fun `encode ConnectFailed`() {
        assertArrayEquals(
            byteArrayOf(0x00, 0x03, 0x81.toByte(), 0x7F, 0xFF.toByte()),
            FrameCodec.encode(Frame.ConnectFailed(0x7FFF))
        )
    }

    // ========== Domain CONNECT ==========

    @Test
    fun `encode domain CONNECT for example_com_8080`() {
        val frame = Frame.Connect(
            reqid = 1,
            address = FrameAddress.Domain("example.com"),
            port = 8080
        )
        val encoded = FrameCodec.encode(frame)

        // Expected: [length:2][type:1][reqid:2][atyp:1][domain_len:1][domain:11][port:2]
        // Length = 1 + 2 + 1 + 1 + 11 + 2 = 18 = 0x0012
        assertEquals(20, encoded.size) // 2 bytes length + 18 bytes payload
        assertEquals(0x00.toByte(), encoded[0])
        assertEquals(0x12.toByte(), encoded[1])
        assertEquals(0x01.toByte(), encoded[2]) // type CONNECT
        assertEquals(0x00.toByte(), encoded[3]) // reqid high
        assertEquals(0x01.toByte(), encoded[4]) // reqid low
        assertEquals(0x03.toByte(), encoded[5]) // atyp DOMAIN
        assertEquals(0x0B.toByte(), encoded[6]) // domain length (11)
        assertEquals("example.com", String(encoded.sliceArray(7..17), Charsets.UTF_8))
        assertEquals(0x1F.toByte(), encoded[18]) // port high (8080 = 0x1F90)
        assertEquals(0x90.toByte(), encoded[19]) // port low
    }

    @Test
    fun `decode domain CONNECT round-trip`() {
        val original = Frame.Connect(
            reqid = 42,
            address = FrameAddress.Domain("test.example.org"),
            port = 443
        )
        val encoded = FrameCodec.encode(original)
        val decoded = FrameCodec.decode(encoded)

        assertEquals(original, decoded)
    }

    // ========== IPv4 CONNECT ==========

    @Test
    fun `encode IPv4 CONNECT for 192_168_1_1_443`() {
        val frame = Frame.Connect(
            reqid = 100,
            address = FrameAddress.IPv4("192.168.1.1"),
            port = 443
        )
        val encoded = FrameCodec.encode(frame)

        // Expected: [length:2][type:1][reqid:2][atyp:1][ipv4:4][port:2]
        // Length = 1 + 2 + 1 + 4 + 2 = 10 = 0x000A
        assertEquals(12, encoded.size) // 2 bytes length + 10 bytes payload
        assertEquals(0x00.toByte(), encoded[0])
        assertEquals(0x0A.toByte(), encoded[1])
        assertEquals(0x01.toByte(), encoded[2]) // type CONNECT
        assertEquals(0x00.toByte(), encoded[3]) // reqid high
        assertEquals(0x64.toByte(), encoded[4]) // reqid low (100)
        assertEquals(0x01.toByte(), encoded[5]) // atyp IPv4
        assertEquals(192.toByte(), encoded[6])
        assertEquals(168.toByte(), encoded[7])
        assertEquals(1.toByte(), encoded[8])
        assertEquals(1.toByte(), encoded[9])
        assertEquals(0x01.toByte(), encoded[10]) // port high (443 = 0x01BB)
        assertEquals(0xBB.toByte(), encoded[11]) // port low
    }

    @Test
    fun `decode IPv4 CONNECT round-trip`() {
        val original = Frame.Connect(
            reqid = 255,
            address = FrameAddress.IPv4("10.0.0.1"),
            port = 8080
        )
        val encoded = FrameCodec.encode(original)
        val decoded = FrameCodec.decode(encoded)

        assertEquals(original, decoded)
    }

    // ========== ERROR frame ==========

    @Test
    fun `encode and decode ERROR frame`() {
        val original = Frame.Error("fail")
        val encoded = FrameCodec.encode(original)

        // Expected: [length:2][type:1][msg_len:1][msg:4]
        // Length = 1 + 1 + 4 = 6 = 0x0006
        assertEquals(8, encoded.size) // 2 bytes length + 6 bytes payload
        assertEquals(0x00.toByte(), encoded[0])
        assertEquals(0x06.toByte(), encoded[1])
        assertEquals(0x23.toByte(), encoded[2]) // type ERROR
        assertEquals(0x04.toByte(), encoded[3]) // msg length
        assertEquals("fail", String(encoded.sliceArray(4..7), Charsets.UTF_8))

        val decoded = FrameCodec.decode(encoded)
        assertEquals(original, decoded)
    }

    // ========== DATA frame ==========

    @Test
    fun `encode and decode DATA frame round-trip`() {
        val payload = byteArrayOf(0x01, 0x02, 0x03, 0x04, 0x05)
        val original = Frame.Data(reqid = 123, payload = payload)
        val encoded = FrameCodec.encode(original)
        val decoded = FrameCodec.decode(encoded)

        assertEquals(original, decoded)
    }

    @Test
    fun `encode and decode empty DATA frame`() {
        val original = Frame.Data(reqid = 456, payload = byteArrayOf())
        val encoded = FrameCodec.encode(original)

        // Expected: [length:2][type:1][reqid:2]
        // Length = 1 + 2 = 3 = 0x0003
        assertEquals(5, encoded.size) // 2 bytes length + 3 bytes payload
        assertEquals(0x00.toByte(), encoded[0])
        assertEquals(0x03.toByte(), encoded[1])
        assertEquals(0x02.toByte(), encoded[2]) // type DATA
        assertEquals(0x01.toByte(), encoded[3]) // reqid high (456 = 0x01C8)
        assertEquals(0xC8.toByte(), encoded[4]) // reqid low

        val decoded = FrameCodec.decode(encoded)
        assertEquals(original, decoded)
    }

    // ========== PADDING frame ==========

    @Test
    fun `encode and decode PADDING frame round-trip`() {
        val data = byteArrayOf(0x01, 0x02, 0x03)
        val original = Frame.Padding(data)
        val encoded = FrameCodec.encode(original)

        assertArrayEquals(byteArrayOf(0x00, 0x04, 0x30, 0x01, 0x02, 0x03), encoded)
        assertEquals(original, FrameCodec.decode(encoded))
    }

    @Test
    fun `encode and decode empty PADDING frame`() {
        val original = Frame.Padding(byteArrayOf())
        val encoded = FrameCodec.encode(original)

        assertArrayEquals(byteArrayOf(0x00, 0x01, 0x30), encoded)
        assertEquals(original, FrameCodec.decode(encoded))
    }

    @Test
    fun `PADDING type decodes to Frame_Padding`() {
        val decoded = FrameCodec.decode(byteArrayOf(0x00, 0x03, 0x30, 0x0A, 0x0B))

        assertTrue(decoded is Frame.Padding)
        assertArrayEquals(byteArrayOf(0x0A, 0x0B), (decoded as Frame.Padding).data)
    }

    @Test
    fun `DATA max chunk 65532 succeeds`() {
        val payload = ByteArray(65532) { it.toByte() }
        val original = Frame.Data(reqid = 1, payload = payload)
        val encoded = FrameCodec.encode(original)
        val decoded = FrameCodec.decode(encoded)

        assertEquals(original, decoded)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `DATA 65533 throws`() {
        val payload = ByteArray(65533)
        Frame.Data(reqid = 1, payload = payload)
        FrameCodec.encode(Frame.Data(reqid = 1, payload = payload))
    }

    // ========== UTF-8 with Chinese text ==========

    @Test
    fun `AUTH with Chinese username`() {
        val original = Frame.Auth(username = "用户", password = "pass")
        val encoded = FrameCodec.encode(original)
        val decoded = FrameCodec.decode(encoded)

        assertEquals(original, decoded)
    }

    @Test
    fun `ERROR with Chinese message`() {
        val original = Frame.Error("失败")
        val encoded = FrameCodec.encode(original)
        val decoded = FrameCodec.decode(encoded)

        assertEquals(original, decoded)
    }

    // ========== Field length validation ==========

    @Test(expected = IllegalArgumentException::class)
    fun `username longer than 255 UTF-8 bytes throws`() {
        val longUsername = "a".repeat(256)
        FrameCodec.encode(Frame.Auth(longUsername, "pass"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `password longer than 255 UTF-8 bytes throws`() {
        val longPassword = "a".repeat(256)
        FrameCodec.encode(Frame.Auth("user", longPassword))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `domain longer than 255 UTF-8 bytes throws`() {
        val longDomain = "a".repeat(256)
        FrameCodec.encode(Frame.Connect(1, FrameAddress.Domain(longDomain), 80))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `error message longer than 255 UTF-8 bytes throws`() {
        val longMessage = "a".repeat(256)
        FrameCodec.encode(Frame.Error(longMessage))
    }

    // ========== Fixed-length frames with trailing bytes ==========

    @Test
    fun `Ping with payload decodes correctly`() {
        val encoded = byteArrayOf(0x00, 0x02, 0x10, 0x00)
        val decoded = FrameCodec.decode(encoded)
        assertTrue(decoded is Frame.Ping)
        assertArrayEquals(byteArrayOf(0x00), (decoded as Frame.Ping).payload)
    }

    @Test
    fun `Pong with payload decodes correctly`() {
        val encoded = byteArrayOf(0x00, 0x02, 0x11, 0x00)
        val decoded = FrameCodec.decode(encoded)
        assertTrue(decoded is Frame.Pong)
        assertArrayEquals(byteArrayOf(0x00), (decoded as Frame.Pong).payload)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `AuthOk with trailing bytes throws`() {
        val invalid = byteArrayOf(0x00, 0x02, 0x21, 0x00)
        FrameCodec.decode(invalid)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `AuthFail with trailing bytes throws`() {
        val invalid = byteArrayOf(0x00, 0x02, 0x22, 0x00)
        FrameCodec.decode(invalid)
    }

    // ========== Unknown frame type ==========

    @Test
    fun `unknown type decodes to Frame_Unknown`() {
        val unknown = byteArrayOf(0x00, 0x03, 0xFF.toByte(), 0x01, 0x02)
        val decoded = FrameCodec.decode(unknown)

        assertTrue(decoded is Frame.Unknown)
        val unknownFrame = decoded as Frame.Unknown
        assertEquals(0xFF, unknownFrame.type)
        assertArrayEquals(byteArrayOf(0x01, 0x02), unknownFrame.payload)
    }

    // ========== Frame equality ==========

    @Test
    fun `Frame_Data compares byte arrays by content`() {
        val data1 = Frame.Data(1, byteArrayOf(0x01, 0x02, 0x03))
        val data2 = Frame.Data(1, byteArrayOf(0x01, 0x02, 0x03))
        val data3 = Frame.Data(1, byteArrayOf(0x01, 0x02, 0x04))

        assertEquals(data1, data2)
        assertNotEquals(data1, data3)
    }

    @Test
    fun `Frame_Padding compares byte arrays by content`() {
        val padding1 = Frame.Padding(byteArrayOf(0x01, 0x02))
        val padding2 = Frame.Padding(byteArrayOf(0x01, 0x02))
        val padding3 = Frame.Padding(byteArrayOf(0x01, 0x03))

        assertEquals(padding1, padding2)
        assertNotEquals(padding1, padding3)
    }

    @Test
    fun `Frame_Unknown compares byte arrays by content`() {
        val unknown1 = Frame.Unknown(0xFF, byteArrayOf(0x01, 0x02))
        val unknown2 = Frame.Unknown(0xFF, byteArrayOf(0x01, 0x02))
        val unknown3 = Frame.Unknown(0xFF, byteArrayOf(0x01, 0x03))

        assertEquals(unknown1, unknown2)
        assertNotEquals(unknown1, unknown3)
    }

    // ========== Invalid IPv4 ==========

    @Test(expected = IllegalArgumentException::class)
    fun `invalid IPv4 address throws`() {
        FrameCodec.encode(Frame.Connect(1, FrameAddress.IPv4("999.999.999.999"), 80))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `IPv4 with wrong number of octets throws`() {
        FrameCodec.encode(Frame.Connect(1, FrameAddress.IPv4("192.168.1"), 80))
    }

    // ========== Additional decode tests ==========

    @Test
    fun `decode AuthOk`() {
        val encoded = byteArrayOf(0x00, 0x01, 0x21)
        val decoded = FrameCodec.decode(encoded)
        assertEquals(Frame.AuthOk, decoded)
    }

    @Test
    fun `decode AuthFail`() {
        val encoded = byteArrayOf(0x00, 0x01, 0x22)
        val decoded = FrameCodec.decode(encoded)
        assertEquals(Frame.AuthFail, decoded)
    }

    @Test
    fun `decode Close`() {
        val encoded = byteArrayOf(0x00, 0x03, 0x03, 0x00, 0x0A)
        val decoded = FrameCodec.decode(encoded)
        assertEquals(Frame.Close(10), decoded)
    }

    @Test
    fun `decodePayload works without length prefix`() {
        val payload = byteArrayOf(0x10) // Just the type byte for Ping
        val decoded = FrameCodec.decodePayload(payload)
        assertTrue(decoded is Frame.Ping)
        assertEquals(0, (decoded as Frame.Ping).payload.size)
    }
}
