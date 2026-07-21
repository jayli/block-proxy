package com.blockproxy.android.cdn

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequest
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.blockproxy.android.config.ServerConfig
import java.util.Calendar
import java.util.UUID
import java.util.concurrent.TimeUnit

class CfIpRefreshWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val serverPort = inputData.getInt(KEY_SERVER_PORT, -1)
        if (serverPort !in 1..65535) {
            return Result.failure()
        }

        val pool = CfIpPool(applicationContext)
        val serverHost = inputData.getString(KEY_SERVER_HOST)
        val xhttpBasePath = inputData.getString(KEY_XHTTP_BASE_PATH) ?: "/xhttp"
        val allowInsecure = inputData.getBoolean(KEY_ALLOW_INSECURE, true)
        val routeProbeConfig = serverHost?.takeIf { it.isNotBlank() }?.let { host ->
            CfIpRouteProbeConfig(
                host = host,
                port = serverPort,
                xhttpBasePath = xhttpBasePath,
                allowInsecure = allowInsecure,
            )
        }
        val tester = CfIpSpeedTester(
            ipPool = pool,
            testPort = serverPort,
            protect = CfIpRuntimeRegistry.currentProtect(),
            routeProbe = routeProbeConfig?.let { RealCfIpRouteProbe() },
            routeProbeConfig = routeProbeConfig,
        )
        val selected = tester.runTest { tested, total ->
            setProgressAsync(workDataOf(KEY_TESTED to tested, KEY_TOTAL to total))
        }

        if (selected.isEmpty()) {
            return Result.retry()
        }

        val applied = CfIpRuntimeRegistry.reloadActiveSnapshot()
        return Result.success(
            workDataOf(
                KEY_SELECTED_COUNT to selected.size,
                KEY_APPLIED_TO_RUNNING_TUNNEL to applied,
            )
        )
    }

    companion object {
        const val WORK_NAME = "cf_ip_refresh"
        const val MANUAL_WORK_NAME = "cf_ip_refresh_manual"
        const val KEY_SERVER_HOST = "server_host"
        const val KEY_SERVER_PORT = "server_port"
        const val KEY_XHTTP_BASE_PATH = "xhttp_base_path"
        const val KEY_ALLOW_INSECURE = "allow_insecure"
        const val KEY_TESTED = "tested"
        const val KEY_TOTAL = "total"
        const val KEY_SELECTED_COUNT = "selected_count"
        const val KEY_APPLIED_TO_RUNNING_TUNNEL = "applied_to_running_tunnel"

        fun createOneTimeRequest(serverPort: Int): OneTimeWorkRequest {
            return OneTimeWorkRequestBuilder<CfIpRefreshWorker>()
                .setInputData(workDataOf(KEY_SERVER_PORT to serverPort))
                .setConstraints(networkConstraints())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
        }

        fun createOneTimeRequest(config: ServerConfig): OneTimeWorkRequest {
            return OneTimeWorkRequestBuilder<CfIpRefreshWorker>()
                .setInputData(workInputData(config))
                .setConstraints(networkConstraints())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
        }

        fun createPeriodicRequest(
            serverPort: Int,
            initialDelayMs: Long = calculateDelayToNext4Am(),
        ): PeriodicWorkRequest {
            return PeriodicWorkRequestBuilder<CfIpRefreshWorker>(1, TimeUnit.DAYS)
                .setInputData(workDataOf(KEY_SERVER_PORT to serverPort))
                .setInitialDelay(initialDelayMs, TimeUnit.MILLISECONDS)
                .setConstraints(networkConstraints())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
        }

        fun createPeriodicRequest(
            config: ServerConfig,
            initialDelayMs: Long = calculateDelayToNext4Am(),
        ): PeriodicWorkRequest {
            return PeriodicWorkRequestBuilder<CfIpRefreshWorker>(1, TimeUnit.DAYS)
                .setInputData(workInputData(config))
                .setInitialDelay(initialDelayMs, TimeUnit.MILLISECONDS)
                .setConstraints(networkConstraints())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
        }

        fun schedule(context: Context, serverPort: Int) {
            WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.UPDATE,
                createPeriodicRequest(serverPort),
            )
        }

        fun schedule(context: Context, config: ServerConfig) {
            WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.UPDATE,
                createPeriodicRequest(config),
            )
        }

        fun cancelSchedule(context: Context) {
            WorkManager.getInstance(context.applicationContext).cancelUniqueWork(WORK_NAME)
        }

        fun refreshNow(context: Context, serverPort: Int): UUID {
            val request = createOneTimeRequest(serverPort)
            WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
                MANUAL_WORK_NAME,
                ExistingWorkPolicy.REPLACE,
                request,
            )
            return request.id
        }

        fun refreshNow(context: Context, config: ServerConfig): UUID {
            val request = createOneTimeRequest(config)
            WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
                MANUAL_WORK_NAME,
                ExistingWorkPolicy.REPLACE,
                request,
            )
            return request.id
        }

        private fun workInputData(config: ServerConfig) = workDataOf(
            KEY_SERVER_HOST to config.serverHost,
            KEY_SERVER_PORT to config.serverPort,
            KEY_XHTTP_BASE_PATH to config.xhttpBasePath,
            KEY_ALLOW_INSECURE to config.allowInsecure,
        )

        fun calculateDelayToNext4Am(nowMillis: Long = System.currentTimeMillis()): Long {
            val now = Calendar.getInstance().apply {
                timeInMillis = nowMillis
            }
            val next = Calendar.getInstance().apply {
                timeInMillis = nowMillis
                set(Calendar.HOUR_OF_DAY, 4)
                set(Calendar.MINUTE, 0)
                set(Calendar.SECOND, 0)
                set(Calendar.MILLISECOND, 0)
                if (!after(now)) {
                    add(Calendar.DAY_OF_MONTH, 1)
                }
            }
            return next.timeInMillis - now.timeInMillis
        }

        private fun networkConstraints(): Constraints {
            return Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
        }
    }
}
