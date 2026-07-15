package com.blockproxy.android.tunnel

import java.io.ByteArrayOutputStream

object GrpcFraming {
    private const val DATA_FIELD_TAG = 0x0a
    private const val MAX_MESSAGE_BYTES = 65535 + 16

    fun encode(frameBytes: ByteArray): ByteArray {
        val message = ByteArrayOutputStream()
        message.write(DATA_FIELD_TAG)
        message.write(encodeVarint(frameBytes.size))
        message.write(frameBytes)
        val payload = message.toByteArray()

        return ByteArrayOutputStream().apply {
            write(0)
            write((payload.size ushr 24) and 0xff)
            write((payload.size ushr 16) and 0xff)
            write((payload.size ushr 8) and 0xff)
            write(payload.size and 0xff)
            write(payload)
        }.toByteArray()
    }

    class Decoder {
        private var buffer = ByteArray(0)

        fun feed(chunk: ByteArray): List<ByteArray> {
            if (chunk.isEmpty()) return emptyList()
            buffer += chunk
            val frames = mutableListOf<ByteArray>()

            while (buffer.size >= 5) {
                if (buffer[0].toInt() != 0) {
                    throw TunnelProtocolException("Compressed gRPC messages are not supported")
                }
                val length = ((buffer[1].toInt() and 0xff) shl 24) or
                    ((buffer[2].toInt() and 0xff) shl 16) or
                    ((buffer[3].toInt() and 0xff) shl 8) or
                    (buffer[4].toInt() and 0xff)
                if (length > MAX_MESSAGE_BYTES) {
                    throw TunnelProtocolException("gRPC message too large: $length")
                }
                if (buffer.size < 5 + length) break

                val message = buffer.copyOfRange(5, 5 + length)
                buffer = buffer.copyOfRange(5 + length, buffer.size)
                frames += decodeTunnelFrame(message)
            }

            return frames
        }
    }

    private fun decodeTunnelFrame(message: ByteArray): ByteArray {
        var offset = 0
        while (offset < message.size) {
            val tag = message[offset++].toInt() and 0xff
            val fieldNumber = tag ushr 3
            val wireType = tag and 0x07
            if (wireType != 2) {
                throw TunnelProtocolException("Unsupported TunnelFrame wire type: $wireType")
            }
            val decodedLength = decodeVarint(message, offset)
            offset = decodedLength.nextOffset
            val end = offset + decodedLength.value
            if (end > message.size) {
                throw TunnelProtocolException("TunnelFrame field exceeds message length")
            }
            if (fieldNumber == 1) {
                return message.copyOfRange(offset, end)
            }
            offset = end
        }
        throw TunnelProtocolException("TunnelFrame missing data field")
    }

    private fun encodeVarint(value: Int): ByteArray {
        var remaining = value
        val out = ByteArrayOutputStream()
        while (remaining >= 0x80) {
            out.write((remaining and 0x7f) or 0x80)
            remaining = remaining ushr 7
        }
        out.write(remaining)
        return out.toByteArray()
    }

    private data class VarintResult(val value: Int, val nextOffset: Int)

    private fun decodeVarint(bytes: ByteArray, startOffset: Int): VarintResult {
        var offset = startOffset
        var shift = 0
        var value = 0
        while (offset < bytes.size) {
            val b = bytes[offset++].toInt() and 0xff
            value = value or ((b and 0x7f) shl shift)
            if ((b and 0x80) == 0) return VarintResult(value, offset)
            shift += 7
            if (shift > 28) throw TunnelProtocolException("Varint too long")
        }
        throw TunnelProtocolException("Incomplete varint")
    }
}
