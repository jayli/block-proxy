package com.blockproxy.android.tunnel

import java.lang.reflect.InvocationTargetException

class GomobileUtlsPostClient private constructor(
    private val nativeClient: Any,
    private val nativeClientClass: Class<*>,
    private val nativeOptionsClass: Class<*>,
    private val newOptions: () -> Any,
) : NativeUtlsPostClient {
    override fun postPacket(options: NativeUtlsPostOptions, body: ByteArray) {
        val nativeOptions = newOptions()
        nativeOptions.call("setURL", options.url)
        nativeOptions.call("setDialHost", options.dialHost)
        nativeOptions.call("setServerName", options.serverName)
        nativeOptions.call("setHostHeader", options.hostHeader)
        nativeOptions.call("setAllowInsecure", options.allowInsecure)
        nativeOptions.call("setConnectTimeoutMillis", 10_000L)
        nativeOptions.call("setResponseTimeoutMillis", 30_000L)
        for ((name, value) in options.headers) {
            nativeOptions.call("addHeader", name, value)
        }
        try {
            nativeClientClass.getMethod("postPacket", nativeOptionsClass, ByteArray::class.java)
                .invoke(nativeClient, nativeOptions, body)
        } catch (e: InvocationTargetException) {
            throw e.targetException ?: e
        }
    }

    override fun close() {
        runCatching {
            nativeClientClass.getMethod("close").invoke(nativeClient)
        }
    }

    private fun Any.call(method: String, vararg args: Any) {
        val target = this.javaClass.methods.firstOrNull { candidate ->
            candidate.name == method &&
                candidate.parameterTypes.size == args.size &&
                candidate.parameterTypes.zip(args).all { (type, arg) -> type.accepts(arg) }
        } ?: throw NoSuchMethodException("${this.javaClass.name}.$method/${args.size}")
        target.invoke(this, *args)
    }

    private fun Class<*>.accepts(arg: Any): Boolean {
        return when {
            this == Boolean::class.javaPrimitiveType -> arg is Boolean
            this == java.lang.Boolean::class.java -> arg is Boolean
            this == Int::class.javaPrimitiveType -> arg is Int
            this == java.lang.Integer::class.java -> arg is Int
            this == Long::class.javaPrimitiveType -> arg is Long || arg is Int
            this == java.lang.Long::class.java -> arg is Long || arg is Int
            else -> isAssignableFrom(arg.javaClass)
        }
    }

    companion object {
        fun createOrNull(): NativeUtlsPostClient? {
            return runCatching {
                val packageClass = Class.forName("utlsws.Utlsws")
                val optionsClass = Class.forName("utlsws.PostOptions")
                val clientClass = Class.forName("utlsws.PostClient")
                val client = packageClass.getMethod("newPostClient").invoke(null)!!
                GomobileUtlsPostClient(
                    nativeClient = client,
                    nativeClientClass = clientClass,
                    nativeOptionsClass = optionsClass,
                    newOptions = { packageClass.getMethod("newPostOptions").invoke(null)!! },
                )
            }.getOrNull()
        }
    }
}
