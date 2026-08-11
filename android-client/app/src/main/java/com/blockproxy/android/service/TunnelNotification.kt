package com.blockproxy.android.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.blockproxy.android.MainActivity
import com.blockproxy.android.status.TunnelStatus

/**
 * Manages the notification channel and builds foreground notifications
 * for the VPN tunnel service.
 *
 * The notification is low-priority (IMPORTANCE_LOW) to minimise user
 * disruption while keeping the service alive as a foreground service.
 */
object TunnelNotification {

    const val CHANNEL_ID = "tunnel_service"
    const val NOTIFICATION_ID = 1
    const val ACTION_STOP = "com.blockproxy.android.action.STOP_TUNNEL"

    /**
     * Creates the notification channel on API 26+.
     * Safe to call multiple times — the system ignores duplicate creation.
     */
    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            "隧道服务",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "BlockProxy 隧道连接状态"
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    /**
     * Builds a foreground notification reflecting the current tunnel [status].
     *
     * - Tapping the notification opens [MainActivity].
     * - A "停止" action sends [ACTION_STOP] to [BlockProxyVpnService].
     */
    fun build(context: Context, status: TunnelStatus): Notification {
        // Content intent → open MainActivity
        val contentIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val contentPendingIntent = PendingIntent.getActivity(
            context,
            0,
            contentIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        // Stop action → send ACTION_STOP to the VPN service
        val stopIntent = Intent(context, BlockProxyVpnService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPendingIntent = PendingIntent.getService(
            context,
            0,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle("BlockProxy")
            .setContentText(status.displayText)
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(contentPendingIntent)
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "停止",
                stopPendingIntent,
            )
            .setOngoing(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}
