package com.blockproxy.android.tunnel

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeUtlsWebSocketTest {

    @Test
    fun `connect passes auth payload as initial native message and completes on auth ok`() = runTest {
        val native = FakeNativeClient()
        val authPayload = FrameCodec.encode(Frame.Auth("user", "pass"))
        var authSender: FrameSender? = null

        val ws = NativeUtlsWebSocket(
            options = baseOptions(authPayload),
            nativeClient = native,
            onAuthSuccess = { authSender = it },
            onFrame = { _, _ -> },
            onDisconnect = { _, _ -> },
        )

        val connect = connectAsync(ws)
        runCurrent()
        val listener = native.listener!!
        listener.onOpen()
        listener.onBinaryMessage(FrameCodec.encode(Frame.AuthOk))

        assertSame(ws, connect.await())
        assertSame(ws, authSender)
        assertTrue(ws.isOpen)
        assertArrayEquals(authPayload, native.options!!.initialMessage)
    }

    @Test(expected = TunnelAuthFailedException::class)
    fun `auth fail maps to tunnel auth failed exception`() = runTest {
        val native = FakeNativeClient()
        val ws = NativeUtlsWebSocket(
            options = baseOptions(FrameCodec.encode(Frame.Auth("user", "bad"))),
            nativeClient = native,
            onAuthSuccess = {},
            onFrame = { _, _ -> },
            onDisconnect = { _, _ -> },
        )

        val connect = connectAsync(ws)
        runCurrent()
        val listener = native.listener!!
        listener.onOpen()
        listener.onBinaryMessage(FrameCodec.encode(Frame.AuthFail))
        connect.await()
    }

    @Test(expected = TunnelOccupiedException::class)
    fun `error during auth maps to tunnel occupied exception`() = runTest {
        val native = FakeNativeClient()
        val ws = NativeUtlsWebSocket(
            options = baseOptions(FrameCodec.encode(Frame.Auth("user", "pass"))),
            nativeClient = native,
            onAuthSuccess = {},
            onFrame = { _, _ -> },
            onDisconnect = { _, _ -> },
        )

        val connect = connectAsync(ws)
        runCurrent()
        val listener = native.listener!!
        listener.onOpen()
        listener.onBinaryMessage(FrameCodec.encode(Frame.Error("busy")))
        connect.await()
    }

    @Test
    fun `post auth binary messages are forwarded`() = runTest {
        val native = FakeNativeClient()
        val received = mutableListOf<ByteArray>()
        val ws = NativeUtlsWebSocket(
            options = baseOptions(FrameCodec.encode(Frame.Auth("user", "pass"))),
            nativeClient = native,
            onAuthSuccess = {},
            onFrame = { _, frame -> received.add(frame) },
            onDisconnect = { _, _ -> },
        )

        val connect = connectAsync(ws)
        runCurrent()
        val listener = native.listener!!
        listener.onOpen()
        listener.onBinaryMessage(FrameCodec.encode(Frame.AuthOk))
        connect.await()

        val ping = FrameCodec.encode(Frame.Ping(byteArrayOf(1, 2, 3)))
        listener.onBinaryMessage(ping)

        assertEquals(1, received.size)
        assertArrayEquals(ping, received[0])
    }

    @Test
    fun `disconnect is emitted at most once and send returns false after close`() = runTest {
        val native = FakeNativeClient()
        var disconnects = 0
        val ws = NativeUtlsWebSocket(
            options = baseOptions(FrameCodec.encode(Frame.Auth("user", "pass"))),
            nativeClient = native,
            onAuthSuccess = {},
            onFrame = { _, _ -> },
            onDisconnect = { _, _ -> disconnects++ },
        )

        val connect = connectAsync(ws)
        runCurrent()
        val listener = native.listener!!
        listener.onOpen()
        listener.onBinaryMessage(FrameCodec.encode(Frame.AuthOk))
        connect.await()

        native.connection.sendResult = false
        ws.close(1000, "done")
        listener.onClosed(1000, "done")
        listener.onFailure("late")

        assertFalse(ws.isOpen)
        assertFalse(ws.sendFrame(FrameCodec.encode(Frame.Ping(byteArrayOf()))))
        assertEquals(1, disconnects)
    }

    private fun baseOptions(authPayload: ByteArray): UtlsWsOptions {
        return UtlsWsOptions(
            url = "wss://example.com:8003/websocket",
            dialHost = "example.com",
            serverName = "example.com",
            hostHeader = "example.com:8003",
            allowInsecure = true,
            chromeProfile = "chrome_auto_stable",
            headers = emptyList(),
            initialMessage = authPayload,
        )
    }

    private fun CoroutineScope.connectAsync(ws: NativeUtlsWebSocket): CompletableDeferred<FrameSender> {
        val deferred = CompletableDeferred<FrameSender>()
        launch {
            try {
                deferred.complete(ws.connect())
            } catch (t: Throwable) {
                deferred.completeExceptionally(t)
            }
        }
        return deferred
    }

    private class FakeNativeClient : UtlsWsNativeClient {
        var options: UtlsWsOptions? = null
        var listener: UtlsWsListener? = null
        val connection = FakeConnection()

        override fun connect(options: UtlsWsOptions, listener: UtlsWsListener): UtlsWsConnection {
            this.options = options
            this.listener = listener
            return connection
        }
    }

    private class FakeConnection : UtlsWsConnection {
        var sendResult = true
        var closeCount = 0

        override fun sendBinary(data: ByteArray): Boolean = sendResult

        override fun close(code: Int, reason: String) {
            closeCount++
        }
    }
}
