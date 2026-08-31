package com.blockproxy.android.tunnel

/**
 * 上行连续失败回调。
 *
 * 当 [XhttpUploadScheduler] 连续上传失败达到阈值时触发，用于隧道自愈：
 * 上行通路失效（如下行 SSE 仍存活但 upload POST 全部失败）时，
 * 上层可据此断开并重建整条隧道、轮换上行 CDN IP。
 *
 * 回调在 scheduler 的 IO 协程上下文中调用，实现方必须非阻塞。
 */
fun interface XhttpUploadListener {
    fun onConsecutiveUploadFailures(failureCount: Int)
}
