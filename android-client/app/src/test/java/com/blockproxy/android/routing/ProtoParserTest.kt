package com.blockproxy.android.routing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ProtoParserTest {

    // ── Varint decoding ─────────────────────────────────────────────────

    @Test
    fun `readVarint single byte`() {
        // 0x01 → value 1, consumed 1
        val data = byteArrayOf(0x01)
        val (value, consumed) = ProtoParser.readVarint(data, 0)
        assertEquals(1L, value)
        assertEquals(1, consumed)
    }

    @Test
    fun `readVarint zero`() {
        val data = byteArrayOf(0x00)
        val (value, consumed) = ProtoParser.readVarint(data, 0)
        assertEquals(0L, value)
        assertEquals(1, consumed)
    }

    @Test
    fun `readVarint multi-byte 300`() {
        // 300 = 0b100101100 → varint: 0xAC 0x02
        val data = byteArrayOf(0xAC.toByte(), 0x02)
        val (value, consumed) = ProtoParser.readVarint(data, 0)
        assertEquals(300L, value)
        assertEquals(2, consumed)
    }

    @Test
    fun `readVarint with offset`() {
        // Prefix byte then varint 150 = 0x96 0x01
        val data = byteArrayOf(0xFF.toByte(), 0x96.toByte(), 0x01)
        val (value, consumed) = ProtoParser.readVarint(data, 1)
        assertEquals(150L, value)
        assertEquals(2, consumed)
    }

    @Test
    fun `readVarint max int32`() {
        // 2^31 - 1 = 2147483647 = 0xFFFFFFFF7F in varint (5 bytes)
        val data = byteArrayOf(0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0xFF.toByte(), 0x07)
        val (value, consumed) = ProtoParser.readVarint(data, 0)
        assertEquals(2147483647L, value)
        assertEquals(5, consumed)
    }

    // ── Message parsing ─────────────────────────────────────────────────

    @Test
    fun `parseMessage empty data returns empty list`() {
        val fields = ProtoParser.parseMessage(byteArrayOf())
        assertEquals(0, fields.size)
    }

    @Test
    fun `parseMessage varint field`() {
        // field_number=1, wire_type=0 → tag = (1 << 3) | 0 = 0x08
        // value = 150 → varint: 0x96 0x01
        val data = byteArrayOf(0x08, 0x96.toByte(), 0x01)
        val fields = ProtoParser.parseMessage(data)
        assertEquals(1, fields.size)
        val field = fields[0]
        assertEquals(1, field.fieldNumber)
        assertEquals(0, field.wireType)
        assertEquals(150L, field.value)
    }

    @Test
    fun `parseMessage length-delimited string field`() {
        // field_number=2, wire_type=2 → tag = (2 << 3) | 2 = 0x12
        // length=5, value="hello"
        val payload = "hello".toByteArray()
        val data = byteArrayOf(0x12, payload.size.toByte()) + payload
        val fields = ProtoParser.parseMessage(data)
        assertEquals(1, fields.size)
        val field = fields[0]
        assertEquals(2, field.fieldNumber)
        assertEquals(2, field.wireType)
        assertEquals("hello", (field.value as ByteArray).toString(Charsets.UTF_8))
    }

    @Test
    fun `parseMessage multiple fields`() {
        // field 1 varint = 1, field 2 string = "test"
        val strPayload = "test".toByteArray()
        val data = byteArrayOf(
            0x08, 0x01,                           // field 1, varint, value=1
            0x12, strPayload.size.toByte()        // field 2, length-delimited
        ) + strPayload
        val fields = ProtoParser.parseMessage(data)
        assertEquals(2, fields.size)
        assertEquals(1, fields[0].fieldNumber)
        assertEquals(0, fields[0].wireType)
        assertEquals(1L, fields[0].value)
        assertEquals(2, fields[1].fieldNumber)
        assertEquals(2, fields[1].wireType)
        assertEquals("test", (fields[1].value as ByteArray).toString(Charsets.UTF_8))
    }

    @Test
    fun `parseMessage repeated fields`() {
        // Two field 1 varints: values 10 and 20
        val data = byteArrayOf(0x08, 0x0A, 0x08, 0x14)
        val fields = ProtoParser.parseMessage(data)
        assertEquals(2, fields.size)
        assertEquals(1, fields[0].fieldNumber)
        assertEquals(10L, fields[0].value)
        assertEquals(1, fields[1].fieldNumber)
        assertEquals(20L, fields[1].value)
    }

    // ── Helper functions ────────────────────────────────────────────────

    @Test
    fun `getVarint returns matching varint field`() {
        val fields = listOf(
            ProtoParser.ProtoField(1, 0, 42L),
            ProtoParser.ProtoField(2, 0, 99L),
        )
        assertEquals(42L, ProtoParser.getVarint(fields, 1))
        assertEquals(99L, ProtoParser.getVarint(fields, 2))
    }

    @Test
    fun `getVarint returns default when field missing`() {
        val fields = listOf(ProtoParser.ProtoField(1, 0, 42L))
        assertNull(ProtoParser.getVarint(fields, 99))
        assertEquals(0L, ProtoParser.getVarint(fields, 99, 0L))
    }

    @Test
    fun `getString returns decoded UTF-8 string`() {
        val fields = listOf(
            ProtoParser.ProtoField(1, 2, "hello".toByteArray()),
        )
        assertEquals("hello", ProtoParser.getString(fields, 1))
    }

    @Test
    fun `getString returns default when field missing`() {
        val fields = emptyList<ProtoParser.ProtoField>()
        assertNull(ProtoParser.getString(fields, 1))
        assertEquals("default", ProtoParser.getString(fields, 1, "default"))
    }

    @Test
    fun `getRepeated returns all matching fields`() {
        val fields = listOf(
            ProtoParser.ProtoField(1, 0, 10L),
            ProtoParser.ProtoField(2, 0, 20L),
            ProtoParser.ProtoField(1, 0, 30L),
        )
        val matches = ProtoParser.getRepeated(fields, 1)
        assertEquals(2, matches.size)
        assertEquals(10L, matches[0].value)
        assertEquals(30L, matches[1].value)
    }

    // ── Malformed input ─────────────────────────────────────────────────

    @Test
    fun `parseMessage truncated varint stops gracefully`() {
        // A byte with continuation bit set but no following byte
        val data = byteArrayOf(0x80.toByte())
        val fields = ProtoParser.parseMessage(data)
        // Should return empty or partial results, not crash
        assertEquals(0, fields.size)
    }

    @Test
    fun `parseMessage truncated length-delimited stops gracefully`() {
        // Tag for field 1 wire_type 2, length=10, but only 2 bytes follow
        val data = byteArrayOf(0x0A, 0x0A, 0x01, 0x02)
        val fields = ProtoParser.parseMessage(data)
        assertEquals(0, fields.size)
    }
}
