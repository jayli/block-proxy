package com.blockproxy.android.routing

/**
 * Minimal protobuf wire format parser.
 * No external dependencies — handles varint, length-delimited, and fixed-size wire types.
 * Matches the behavior of client/proto_parser.py.
 */
object ProtoParser {

    /**
     * A parsed protobuf field.
     * @property fieldNumber the field number in the message
     * @property wireType the wire type (0=varint, 2=length-delimited, 1=fixed64, 5=fixed32)
     * @property value Long for wire_type 0, ByteArray for wire_type 1/2/5
     */
    data class ProtoField(
        val fieldNumber: Int,
        val wireType: Int,
        val value: Any,
    )

    /**
     * Read a protobuf varint from [data] starting at [offset].
     * Returns a Pair of (value, bytesConsumed).
     */
    fun readVarint(data: ByteArray, offset: Int): Pair<Long, Int> {
        var result = 0L
        var shift = 0
        var pos = offset
        while (pos < data.size) {
            val byte = data[pos].toInt() and 0xFF
            result = result or ((byte.toLong() and 0x7F) shl shift)
            pos++
            if (byte and 0x80 == 0) {
                return result to (pos - offset)
            }
            shift += 7
            // Safety: varint should not exceed 10 bytes
            if (shift >= 70) break
        }
        // Truncated varint: return 0 consumed to signal failure
        return 0L to 0
    }

    /**
     * Parse a protobuf message into a list of [ProtoField].
     * wire_type 0 → value is Long (varint)
     * wire_type 2 → value is ByteArray (string/bytes/embedded message)
     * wire_type 1 → value is ByteArray (8 bytes, fixed64)
     * wire_type 5 → value is ByteArray (4 bytes, fixed32)
     */
    fun parseMessage(data: ByteArray): List<ProtoField> {
        val fields = mutableListOf<ProtoField>()
        var offset = 0
        while (offset < data.size) {
            val (tag, tagConsumed) = readVarint(data, offset)
            if (tagConsumed == 0) break
            offset += tagConsumed
            val fieldNumber = (tag shr 3).toInt()
            val wireType = (tag and 0x07).toInt()

            val value: Any = when (wireType) {
                0 -> { // varint
                    val (v, consumed) = readVarint(data, offset)
                    if (consumed == 0) break
                    offset += consumed
                    v
                }
                2 -> { // length-delimited
                    val (length, consumed) = readVarint(data, offset)
                    if (consumed == 0) break
                    offset += consumed
                    val len = length.toInt()
                    if (offset + len > data.size) break
                    val bytes = data.copyOfRange(offset, offset + len)
                    offset += len
                    bytes
                }
                1 -> { // 64-bit fixed
                    if (offset + 8 > data.size) break
                    val bytes = data.copyOfRange(offset, offset + 8)
                    offset += 8
                    bytes
                }
                5 -> { // 32-bit fixed
                    if (offset + 4 > data.size) break
                    val bytes = data.copyOfRange(offset, offset + 4)
                    offset += 4
                    bytes
                }
                else -> break // unknown wire type
            }
            fields.add(ProtoField(fieldNumber, wireType, value))
        }
        return fields
    }

    /**
     * Get a varint field value by [fieldNumber]. Returns [default] if not found.
     */
    fun getVarint(fields: List<ProtoField>, fieldNumber: Int, default: Long? = null): Long? {
        for (f in fields) {
            if (f.fieldNumber == fieldNumber && f.wireType == 0) {
                return f.value as Long
            }
        }
        return default
    }

    /**
     * Get a string field value by [fieldNumber]. Returns [default] if not found.
     */
    fun getString(fields: List<ProtoField>, fieldNumber: Int, default: String? = null): String? {
        for (f in fields) {
            if (f.fieldNumber == fieldNumber && f.wireType == 2) {
                return (f.value as ByteArray).toString(Charsets.UTF_8)
            }
        }
        return default
    }

    /**
     * Get a bytes field value by [fieldNumber]. Returns [default] if not found.
     */
    fun getBytes(fields: List<ProtoField>, fieldNumber: Int, default: ByteArray? = null): ByteArray? {
        for (f in fields) {
            if (f.fieldNumber == fieldNumber && f.wireType == 2) {
                return f.value as ByteArray
            }
        }
        return default
    }

    /**
     * Get all fields matching [fieldNumber] (for repeated fields).
     */
    fun getRepeated(fields: List<ProtoField>, fieldNumber: Int): List<ProtoField> {
        return fields.filter { it.fieldNumber == fieldNumber }
    }

    /**
     * Parse an embedded message from a length-delimited field.
     */
    fun getMessage(fields: List<ProtoField>, fieldNumber: Int): List<ProtoField>? {
        val bytes = getBytes(fields, fieldNumber) ?: return null
        return parseMessage(bytes)
    }
}
