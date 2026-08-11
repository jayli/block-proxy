package com.blockproxy.android

import android.app.Application
import android.content.Intent
import android.os.Process
import android.util.Log
import com.blockproxy.android.diagnostics.TunnelDiagnosticsLog
import java.io.PrintWriter
import java.io.StringWriter
import kotlin.system.exitProcess

/**
 * 自定义 Application 类，设置全局未捕获异常处理器。
 */
class BlockProxyApplication : Application() {

    private var defaultHandler: Thread.UncaughtExceptionHandler? = null

    override fun onCreate() {
        super.onCreate()
        TunnelDiagnosticsLog.initialize(this)

        // 保存默认的异常处理器
        defaultHandler = Thread.getDefaultUncaughtExceptionHandler()

        // 设置全局异常处理器
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            Log.e(TAG, "Uncaught exception in thread ${thread.name}", throwable)
            TunnelDiagnosticsLog.write(
                "app.uncaught_exception",
                "thread=${thread.name} type=${throwable::class.java.name} message=${throwable.message ?: ""}"
            )

            try {
                // 构建堆栈信息字符串
                val sw = StringWriter()
                val pw = PrintWriter(sw)
                throwable.printStackTrace(pw)
                val stackTrace = sw.toString()

                // 确定错误类型
                val errorType = when (throwable) {
                    is NoClassDefFoundError -> "类加载失败: ${throwable.message}"
                    is ClassNotFoundException -> "类未找到: ${throwable.message}"
                    is NoSuchMethodError -> "方法未找到: ${throwable.message}"
                    is NoSuchFieldError -> "字段未找到: ${throwable.message}"
                    is VerifyError -> "类验证失败: ${throwable.message}"
                    is LinkageError -> "链接错误: ${throwable.message}"
                    is ExceptionInInitializerError -> "初始化异常: ${throwable.cause?.message ?: throwable.message}"
                    else -> throwable::class.java.name
                }

                // 启动崩溃报告 Activity
                val intent = Intent(this, CrashReportActivity::class.java).apply {
                    putExtra(CrashReportActivity.EXTRA_STACK_TRACE, stackTrace)
                    putExtra(CrashReportActivity.EXTRA_ERROR_TYPE, errorType)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK)
                }
                startActivity(intent)
            } catch (e: Exception) {
                // 如果启动 Activity 失败，使用默认处理器
                Log.e(TAG, "Failed to launch crash report activity", e)
                defaultHandler?.uncaughtException(thread, throwable)
            }

            // 终止进程
            Process.killProcess(Process.myPid())
            exitProcess(1)
        }
    }

    companion object {
        private const val TAG = "BlockProxyApp"
    }
}
