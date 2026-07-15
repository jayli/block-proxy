package com.blockproxy.android.tunnel

import utlsws.Utlsws

class GomobileUtlsWsNativeClient : UtlsWsNativeClient {
    override fun connect(options: UtlsWsOptions, listener: UtlsWsListener): UtlsWsConnection {
        val nativeOptions = Utlsws.newOptions()
        nativeOptions.setURL(options.url)
        nativeOptions.setDialHost(options.dialHost)
        nativeOptions.setServerName(options.serverName)
        nativeOptions.setHostHeader(options.hostHeader)
        nativeOptions.setAllowInsecure(options.allowInsecure)
        nativeOptions.setChromeProfile(options.chromeProfile)
        nativeOptions.setConnectTimeoutMillis(options.connectTimeoutMillis.toLong())
        nativeOptions.setReadBufferBytes(options.readBufferBytes.toLong())
        nativeOptions.setInitialBinaryMessage(options.initialMessage.copyOf())
        options.headers.forEach { (name, value) ->
            nativeOptions.addHeader(name, value)
        }
        val nativeConn = Utlsws.connect(nativeOptions, object : utlsws.Listener {
            override fun onOpen() {
                listener.onOpen()
            }

            override fun onBinaryMessage(data: ByteArray) {
                listener.onBinaryMessage(data.copyOf())
            }

            override fun onClosed(code: Long, reason: String) {
                listener.onClosed(code.toInt(), reason)
            }

            override fun onFailure(message: String) {
                listener.onFailure(message)
            }
        })
        return object : UtlsWsConnection {
            override fun sendBinary(data: ByteArray): Boolean {
                return nativeConn.sendBinary(data.copyOf())
            }

            override fun close(code: Int, reason: String) {
                nativeConn.close(code.toLong(), reason)
            }
        }
    }
}
