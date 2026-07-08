package com.blockproxy.android.status

/**
 * Tunnel connection status states, each with a user-visible Chinese display text.
 *
 * The status transitions are managed by the tunnel service; this enum only
 * models the state values and their presentation labels.
 */
enum class TunnelStatus(val displayText: String) {
    Disconnected("已断开"),
    Preparing("准备中"),
    Connecting("正在连接..."),
    Connected("已连接"),
    Reconnecting("重连中"),
    Occupied("端口被占用"),
    AuthFailed("认证失败"),
    Error("错误"),
}
