package com.blockproxy.android.status

import org.junit.Assert.assertEquals
import org.junit.Test

class TunnelStatusTest {
    @Test fun displayTextMatchesDesign() {
        assertEquals("已断开", TunnelStatus.Disconnected.displayText)
        assertEquals("准备中", TunnelStatus.Preparing.displayText)
        assertEquals("正在连接...", TunnelStatus.Connecting.displayText)
        assertEquals("已连接", TunnelStatus.Connected.displayText)
        assertEquals("静默监听中", TunnelStatus.SilentListening.displayText)
        assertEquals("重连中", TunnelStatus.Reconnecting.displayText)
        assertEquals("隧道已占用", TunnelStatus.Occupied.displayText)
        assertEquals("认证失败", TunnelStatus.AuthFailed.displayText)
        assertEquals("错误", TunnelStatus.Error.displayText)
    }
}
