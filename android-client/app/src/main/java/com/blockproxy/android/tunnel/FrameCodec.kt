package com.blockproxy.android.tunnel

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

object FrameCodec {
    const val MAX_PAYLOAD_SIZE = 65535
    const val MAX_DATA_CHUNK = 65532
    const val CAP_PADDING = "padding"

    fun encode(frame: Frame): ByteArray {
        val payload = encodePayload(frame)

        if (payload.size > MAX_PAYLOAD_SIZE) {
            throw IllegalArgumentException("Frame too large: ${payload.size} > $MAX_PAYLOAD_SIZE")
        }

        val result = ByteArray(2 + payload.size)
        result[0] = (payload.size shr 8).toByte()
        result[1] = (payload.size and 0xFF).toByte()
        System.arraycopy(payload, 0, result, 2, payload.size)

        return result
    }

    private fun encodePayload(frame: Frame): ByteArray {
        return when (frame) {
            is Frame.Ping -> {
                val p = frame.payload
                val result = ByteArray(1 + p.size)
                result[0] = FrameType.PING.code.toByte()
                System.arraycopy(p, 0, result, 1, p.size)
                result
            }
            is Frame.Pong -> {
                val p = frame.payload
                val result = ByteArray(1 + p.size)
                result[0] = FrameType.PONG.code.toByte()
                System.arraycopy(p, 0, result, 1, p.size)
                result
            }
            is Frame.AuthOk -> byteArrayOf(FrameType.AUTH_OK.code.toByte())
            is Frame.AuthFail -> byteArrayOf(FrameType.AUTH_FAIL.code.toByte())

            is Frame.Auth -> {
                val usernameBytes = frame.username.toByteArray(Charsets.UTF_8)
                val passwordBytes = frame.password.toByteArray(Charsets.UTF_8)

                if (usernameBytes.size > 255) {
                    throw IllegalArgumentException("Username too long: ${usernameBytes.size} > 255")
                }
                if (passwordBytes.size > 255) {
                    throw IllegalArgumentException("Password too long: ${passwordBytes.size} > 255")
                }

                val result = ByteArrayOutputStream()
                result.write(FrameType.AUTH.code)
                result.write(usernameBytes.size)
                result.write(usernameBytes)
                result.write(passwordBytes.size)
                result.write(passwordBytes)
                result.write(encodeCapabilities(frame.capabilities))
                result.toByteArray()
            }

            is Frame.Connect -> {
                val output = ByteArrayOutputStream()
                output.write(FrameType.CONNECT.code)
                output.write(frame.reqid shr 8)
                output.write(frame.reqid and 0xFF)

                when (val addr = frame.address) {
                    is FrameAddress.IPv4 -> {
                        val parts = addr.address.split(".")
                        if (parts.size != 4) {
                            throw IllegalArgumentException("Invalid IPv4 address: ${addr.address}")
                        }
                        output.write(AddressType.IPV4.code)
                        for (part in parts) {
                            val value = part.toIntOrNull()
                                ?: throw IllegalArgumentException("Invalid IPv4 octet: $part")
                            if (value < 0 || value > 255) {
                                throw IllegalArgumentException("IPv4 octet out of range: $value")
                            }
                            output.write(value)
                        }
                    }
                    is FrameAddress.Domain -> {
                        val domainBytes = addr.domain.toByteArray(Charsets.UTF_8)
                        if (domainBytes.size > 255) {
                            throw IllegalArgumentException("Domain too long: ${domainBytes.size} > 255")
                        }
                        output.write(AddressType.DOMAIN.code)
                        output.write(domainBytes.size)
                        output.write(domainBytes)
                    }
                    is FrameAddress.IPv6 -> {
                        throw UnsupportedOperationException("IPv6 not yet supported")
                    }
                }

                output.write(frame.port shr 8)
                output.write(frame.port and 0xFF)
                output.toByteArray()
            }

            is Frame.Data -> {
                if (frame.payload.size > MAX_DATA_CHUNK) {
                    throw IllegalArgumentException("Data payload too large: ${frame.payload.size} > $MAX_DATA_CHUNK")
                }

                val result = ByteArrayOutputStream()
                result.write(FrameType.DATA.code)
                result.write(frame.reqid shr 8)
                result.write(frame.reqid and 0xFF)
                result.write(frame.payload)
                result.toByteArray()
            }

            is Frame.Close -> {
                byteArrayOf(
                    FrameType.CLOSE.code.toByte(),
                    (frame.reqid shr 8).toByte(),
                    (frame.reqid and 0xFF).toByte()
                )
            }

            is Frame.ConnectOk -> {
                byteArrayOf(
                    FrameType.CONNECT_OK.code.toByte(),
                    (frame.reqid shr 8).toByte(),
                    (frame.reqid and 0xFF).toByte()
                )
            }

            is Frame.ConnectFailed -> {
                byteArrayOf(
                    FrameType.CONNECT_FAILED.code.toByte(),
                    (frame.reqid shr 8).toByte(),
                    (frame.reqid and 0xFF).toByte()
                )
            }

            is Frame.Error -> {
                val messageBytes = frame.message.toByteArray(Charsets.UTF_8)
                if (messageBytes.size > 255) {
                    throw IllegalArgumentException("Error message too long: ${messageBytes.size} > 255")
                }

                val result = ByteArrayOutputStream()
                result.write(FrameType.ERROR.code)
                result.write(messageBytes.size)
                result.write(messageBytes)
                result.toByteArray()
            }

            is Frame.Capabilities -> {
                val result = ByteArrayOutputStream()
                result.write(FrameType.CAPABILITIES.code)
                result.write(encodeCapabilities(frame.capabilities))
                result.toByteArray()
            }

            is Frame.Padding -> {
                val result = ByteArray(1 + frame.data.size)
                result[0] = FrameType.PADDING.code.toByte()
                System.arraycopy(frame.data, 0, result, 1, frame.data.size)
                result
            }

            is Frame.Unknown -> {
                throw IllegalArgumentException("Cannot encode Unknown frame type")
            }
        }
    }

    private fun encodeCapabilities(capabilities: List<String>): ByteArray {
        if (capabilities.size > 255) {
            throw IllegalArgumentException("Too many capabilities: ${capabilities.size} > 255")
        }
        val result = ByteArrayOutputStream()
        result.write(capabilities.size)
        for (capability in capabilities) {
            val bytes = capability.toByteArray(Charsets.UTF_8)
            if (bytes.size > 255) {
                throw IllegalArgumentException("Capability too long: ${bytes.size} > 255")
            }
            result.write(bytes.size)
            result.write(bytes)
        }
        return result.toByteArray()
    }

    private fun decodeCapabilities(payload: ByteArray, startOffset: Int): Pair<List<String>, Int> {
        if (startOffset >= payload.size) return emptyList<String>() to startOffset
        var offset = startOffset
        val count = payload[offset].toInt() and 0xFF
        offset++
        val capabilities = mutableListOf<String>()
        repeat(count) {
            if (offset >= payload.size) {
                throw IllegalArgumentException("Capabilities frame too short")
            }
            val len = payload[offset].toInt() and 0xFF
            offset++
            if (offset + len > payload.size) {
                throw IllegalArgumentException("Capability extends beyond payload")
            }
            capabilities.add(String(payload, offset, len, Charsets.UTF_8))
            offset += len
        }
        return capabilities to offset
    }

    fun decode(frameBytes: ByteArray): Frame {
        if (frameBytes.size < 2) {
            throw IllegalArgumentException("Buffer too short: ${frameBytes.size} < 2")
        }

        val length = ((frameBytes[0].toInt() and 0xFF) shl 8) or (frameBytes[1].toInt() and 0xFF)

        if (frameBytes.size < 2 + length) {
            throw IllegalArgumentException("Incomplete frame: ${frameBytes.size} < ${2 + length}")
        }

        val payload = frameBytes.sliceArray(2 until 2 + length)
        return decodePayload(payload)
    }

    fun decodePayload(payload: ByteArray): Frame {
        if (payload.isEmpty()) {
            throw IllegalArgumentException("Empty payload")
        }

        val type = payload[0].toInt() and 0xFF
        var offset = 1

        return when (type) {
            FrameType.PING.code -> {
                Frame.Ping(payload.copyOfRange(1, payload.size))
            }

            FrameType.PONG.code -> {
                Frame.Pong(payload.copyOfRange(1, payload.size))
            }

            FrameType.AUTH_OK.code -> {
                if (payload.size != 1) {
                    throw IllegalArgumentException("AuthOk frame has trailing bytes: ${payload.size} != 1")
                }
                Frame.AuthOk
            }

            FrameType.AUTH_FAIL.code -> {
                if (payload.size != 1) {
                    throw IllegalArgumentException("AuthFail frame has trailing bytes: ${payload.size} != 1")
                }
                Frame.AuthFail
            }

            FrameType.AUTH.code -> {
                if (offset >= payload.size) {
                    throw IllegalArgumentException("Auth frame too short")
                }
                val usernameLen = payload[offset].toInt() and 0xFF
                offset++

                if (offset + usernameLen > payload.size) {
                    throw IllegalArgumentException("Auth frame username extends beyond payload")
                }
                val username = String(payload, offset, usernameLen, Charsets.UTF_8)
                offset += usernameLen

                if (offset >= payload.size) {
                    throw IllegalArgumentException("Auth frame too short for password length")
                }
                val passwordLen = payload[offset].toInt() and 0xFF
                offset++

                if (offset + passwordLen > payload.size) {
                    throw IllegalArgumentException("Auth frame password extends beyond payload")
                }
                val password = String(payload, offset, passwordLen, Charsets.UTF_8)
                offset += passwordLen

                val (capabilities, capabilityEnd) = decodeCapabilities(payload, offset)
                offset = capabilityEnd

                if (offset != payload.size) {
                    throw IllegalArgumentException("Auth frame has trailing bytes")
                }

                Frame.Auth(username, password, capabilities)
            }

            FrameType.CONNECT.code -> {
                if (offset + 2 > payload.size) {
                    throw IllegalArgumentException("Connect frame too short for reqid")
                }
                val reqid = ((payload[offset].toInt() and 0xFF) shl 8) or (payload[offset + 1].toInt() and 0xFF)
                offset += 2

                if (offset >= payload.size) {
                    throw IllegalArgumentException("Connect frame too short for address type")
                }
                val atyp = payload[offset].toInt() and 0xFF
                offset++

                val address = when (atyp) {
                    AddressType.IPV4.code -> {
                        if (offset + 4 > payload.size) {
                            throw IllegalArgumentException("Connect frame too short for IPv4 address")
                        }
                        val addr = "${payload[offset].toInt() and 0xFF}.${payload[offset + 1].toInt() and 0xFF}." +
                                "${payload[offset + 2].toInt() and 0xFF}.${payload[offset + 3].toInt() and 0xFF}"
                        offset += 4
                        FrameAddress.IPv4(addr)
                    }
                    AddressType.DOMAIN.code -> {
                        if (offset >= payload.size) {
                            throw IllegalArgumentException("Connect frame too short for domain length")
                        }
                        val domainLen = payload[offset].toInt() and 0xFF
                        offset++

                        if (offset + domainLen > payload.size) {
                            throw IllegalArgumentException("Connect frame domain extends beyond payload")
                        }
                        val domain = String(payload, offset, domainLen, Charsets.UTF_8)
                        offset += domainLen
                        FrameAddress.Domain(domain)
                    }
                    AddressType.IPV6.code -> {
                        throw UnsupportedOperationException("IPv6 not yet supported")
                    }
                    else -> {
                        throw IllegalArgumentException("Unknown address type: 0x${atyp.toString(16)}")
                    }
                }

                if (offset + 2 > payload.size) {
                    throw IllegalArgumentException("Connect frame too short for port")
                }
                val port = ((payload[offset].toInt() and 0xFF) shl 8) or (payload[offset + 1].toInt() and 0xFF)
                offset += 2

                if (offset != payload.size) {
                    throw IllegalArgumentException("Connect frame has trailing bytes")
                }

                Frame.Connect(reqid, address, port)
            }

            FrameType.DATA.code -> {
                if (offset + 2 > payload.size) {
                    throw IllegalArgumentException("Data frame too short for reqid")
                }
                val reqid = ((payload[offset].toInt() and 0xFF) shl 8) or (payload[offset + 1].toInt() and 0xFF)
                offset += 2

                val data = payload.sliceArray(offset until payload.size)
                Frame.Data(reqid, data)
            }

            FrameType.CLOSE.code -> {
                if (offset + 2 > payload.size) {
                    throw IllegalArgumentException("Close frame too short for reqid")
                }
                val reqid = ((payload[offset].toInt() and 0xFF) shl 8) or (payload[offset + 1].toInt() and 0xFF)
                offset += 2

                if (offset != payload.size) {
                    throw IllegalArgumentException("Close frame has trailing bytes")
                }

                Frame.Close(reqid)
            }

            FrameType.CONNECT_OK.code -> {
                if (offset + 2 > payload.size) {
                    throw IllegalArgumentException("ConnectOk frame too short for reqid")
                }
                val reqid = ((payload[offset].toInt() and 0xFF) shl 8) or (payload[offset + 1].toInt() and 0xFF)
                offset += 2

                if (offset != payload.size) {
                    throw IllegalArgumentException("ConnectOk frame has trailing bytes")
                }

                Frame.ConnectOk(reqid)
            }

            FrameType.CONNECT_FAILED.code -> {
                if (offset + 2 > payload.size) {
                    throw IllegalArgumentException("ConnectFailed frame too short for reqid")
                }
                val reqid = ((payload[offset].toInt() and 0xFF) shl 8) or (payload[offset + 1].toInt() and 0xFF)
                offset += 2

                if (offset != payload.size) {
                    throw IllegalArgumentException("ConnectFailed frame has trailing bytes")
                }

                Frame.ConnectFailed(reqid)
            }

            FrameType.ERROR.code -> {
                if (offset >= payload.size) {
                    throw IllegalArgumentException("Error frame too short for message length")
                }
                val messageLen = payload[offset].toInt() and 0xFF
                offset++

                if (offset + messageLen > payload.size) {
                    throw IllegalArgumentException("Error frame message extends beyond payload")
                }
                val message = String(payload, offset, messageLen, Charsets.UTF_8)
                offset += messageLen

                if (offset != payload.size) {
                    throw IllegalArgumentException("Error frame has trailing bytes")
                }

                Frame.Error(message)
            }

            FrameType.CAPABILITIES.code -> {
                val (capabilities, capabilityEnd) = decodeCapabilities(payload, offset)
                if (capabilityEnd != payload.size) {
                    throw IllegalArgumentException("Capabilities frame has trailing bytes")
                }
                Frame.Capabilities(capabilities)
            }

            FrameType.PADDING.code -> {
                Frame.Padding(payload.copyOfRange(1, payload.size))
            }

            else -> {
                Frame.Unknown(type, payload.sliceArray(1 until payload.size))
            }
        }
    }
}
