package com.blockproxy.android.tunnel

/**
 * 隧道帧发送接口。
 *
 * 定义了向隧道发送帧的基本能力，包括发送帧、关闭连接和检查连接状态。
 * XhttpTransport 实现此接口以提供 xhttp 模式的隧道传输。
 */
interface FrameSender {
    /**
     * 发送编码后的隧道帧。
     *
     * @param frame 编码后的帧数据
     * @return 如果发送成功返回 true，否则返回 false
     */
    suspend fun sendFrame(frame: ByteArray): Boolean

    /**
     * 关闭隧道连接。
     *
     * @param code 关闭代码
     * @param reason 关闭原因
     */
    fun close(code: Int, reason: String)

    /**
     * 检查连接是否处于打开状态。
     */
    val isOpen: Boolean
}

/**
 * 隧道认证失败异常。
 *
 * 当服务器拒绝客户端的认证凭据时抛出。
 */
class TunnelAuthFailedException(message: String) : Exception(message)

/**
 * 隧道占用异常。
 *
 * 当服务器端口已被其他客户端占用时抛出。
 */
class TunnelOccupiedException(message: String) : Exception(message)

/**
 * 隧道协议异常。
 *
 * 当服务器响应不符合协议规范时抛出。
 */
class TunnelProtocolException(message: String) : Exception(message)
