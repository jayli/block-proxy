package com.blockproxy.android.tunnel

sealed class FrameAddress {
    data class IPv4(val address: String) : FrameAddress()
    data class Domain(val domain: String) : FrameAddress()
    data class IPv6(val address: String) : FrameAddress()
}

sealed class Frame {
    data class Connect(val reqid: Int, val address: FrameAddress, val port: Int) : Frame()

    class Data(val reqid: Int, val payload: ByteArray) : Frame() {
        override fun equals(other: Any?): Boolean =
            other is Data && reqid == other.reqid && payload.contentEquals(other.payload)

        override fun hashCode(): Int = 31 * reqid + payload.contentHashCode()
    }

    data class Close(val reqid: Int) : Frame()
    data class ConnectOk(val reqid: Int) : Frame()
    data class ConnectFailed(val reqid: Int) : Frame()
    data class Ping(val payload: ByteArray) : Frame() {
        override fun equals(other: Any?): Boolean =
            other is Ping && payload.contentEquals(other.payload)
        override fun hashCode(): Int = payload.contentHashCode()
    }
    data class Pong(val payload: ByteArray) : Frame() {
        override fun equals(other: Any?): Boolean =
            other is Pong && payload.contentEquals(other.payload)
        override fun hashCode(): Int = payload.contentHashCode()
    }
    data class Auth(val username: String, val password: String) : Frame()
    data object AuthOk : Frame()
    data object AuthFail : Frame()
    data class Error(val message: String) : Frame()

    class Unknown(val type: Int, val payload: ByteArray) : Frame() {
        override fun equals(other: Any?): Boolean =
            other is Unknown && type == other.type && payload.contentEquals(other.payload)

        override fun hashCode(): Int = 31 * type + payload.contentHashCode()
    }
}

enum class FrameType(val code: Int) {
    CONNECT(0x01),
    DATA(0x02),
    CLOSE(0x03),
    CONNECT_OK(0x04),
    PING(0x10),
    PONG(0x11),
    AUTH(0x20),
    AUTH_OK(0x21),
    AUTH_FAIL(0x22),
    ERROR(0x23),
    CONNECT_FAILED(0x81),
}

enum class AddressType(val code: Int) {
    IPV4(0x01),
    DOMAIN(0x03),
    IPV6(0x04),
}
