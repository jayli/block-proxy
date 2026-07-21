package com.blockproxy.android.socks

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.ByteArrayOutputStream

class TlsClientHelloParserTest {

    @Test
    fun `valid ClientHello with SNI returns hostname`() {
        val hello = clientHello("www.Weibo.CN")

        assertEquals("www.weibo.cn", TlsClientHelloParser.parseSni(hello))
    }

    @Test
    fun `ClientHello without SNI returns null`() {
        assertNull(TlsClientHelloParser.parseSni(clientHello(null)))
    }

    @Test
    fun `non TLS bytes return null`() {
        assertNull(TlsClientHelloParser.parseSni("GET / HTTP/1.1\r\n\r\n".toByteArray()))
    }

    @Test
    fun `truncated record returns null`() {
        val hello = clientHello("weibo.cn")

        assertNull(TlsClientHelloParser.parseSni(hello.copyOfRange(0, 12)))
    }

    @Test
    fun `IP literal SNI returns null`() {
        assertNull(TlsClientHelloParser.parseSni(clientHello("1.2.3.4")))
    }

    private fun clientHello(hostname: String?): ByteArray {
        val body = ByteArrayOutputStream()
        body.write(byteArrayOf(0x03, 0x03)) // client version
        body.write(ByteArray(32) { 0x11 })
        body.write(0x00) // session id length
        body.write(byteArrayOf(0x00, 0x02, 0x13, 0x01)) // cipher suites
        body.write(byteArrayOf(0x01, 0x00)) // compression methods

        val extensions = ByteArrayOutputStream()
        if (hostname != null) {
            val hostBytes = hostname.toByteArray(Charsets.US_ASCII)
            val serverName = ByteArrayOutputStream()
            serverName.write(0x00) // host_name
            serverName.write(shortBytes(hostBytes.size))
            serverName.write(hostBytes)

            val sniData = ByteArrayOutputStream()
            sniData.write(shortBytes(serverName.size()))
            sniData.write(serverName.toByteArray())

            extensions.write(byteArrayOf(0x00, 0x00))
            extensions.write(shortBytes(sniData.size()))
            extensions.write(sniData.toByteArray())
        }
        body.write(shortBytes(extensions.size()))
        body.write(extensions.toByteArray())

        val handshakeBody = body.toByteArray()
        val handshake = ByteArrayOutputStream()
        handshake.write(0x01) // ClientHello
        handshake.write(byteArrayOf(
            ((handshakeBody.size shr 16) and 0xFF).toByte(),
            ((handshakeBody.size shr 8) and 0xFF).toByte(),
            (handshakeBody.size and 0xFF).toByte(),
        ))
        handshake.write(handshakeBody)

        val recordBody = handshake.toByteArray()
        val record = ByteArrayOutputStream()
        record.write(0x16) // handshake
        record.write(byteArrayOf(0x03, 0x03))
        record.write(shortBytes(recordBody.size))
        record.write(recordBody)
        return record.toByteArray()
    }

    private fun shortBytes(value: Int): ByteArray =
        byteArrayOf(((value shr 8) and 0xFF).toByte(), (value and 0xFF).toByte())
}
