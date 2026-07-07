/*
 * tun2socks_jni.c — JNI bridge between Kotlin Tun2Socks class and hev-socks5-tunnel C library.
 *
 * This file provides:
 * 1. JNI_OnLoad: caches JavaVM pointer and VpnService class reference for protect() callbacks.
 * 2. nativeStart: builds YAML config, spawns a native thread, runs hev_socks5_tunnel_main_from_str().
 * 3. nativeStop: wraps hev_socks5_tunnel_quit() to stop the tunnel.
 * 4. nativeStats: wraps hev_socks5_tunnel_stats() for TX/RX traffic statistics.
 * 5. Socket protect callback: allows the native tunnel to call VpnService.protect()
 *    on outbound sockets to prevent VPN routing loops.
 *
 * Architecture:
 *   Kotlin Tun2Socks → JNI (this file) → native thread → hev_socks5_tunnel_main_from_str()
 *                                                          ↓
 *                                                TUN fd → SOCKS5 (127.0.0.1:port)
 *
 * Threading model:
 *   hev_socks5_tunnel_main_from_str() BLOCKS until hev_socks5_tunnel_quit() is called.
 *   nativeStart() spawns a detached pthread to run the blocking call, then returns
 *   immediately so the Kotlin caller doesn't block. nativeStop() signals quit and
 *   the native thread exits asynchronously.
 *
 * Config format:
 *   The tunnel is configured via a YAML string passed to hev_socks5_tunnel_main_from_str().
 *   The JNI bridge builds this string from the host/port parameters. Key fields:
 *     tunnel: { mtu: 1500 }
 *     socks5: { address: "127.0.0.1", port: 1080, udp: "tcp" }
 *
 * Socket Protection:
 *   The primary mechanism for preventing routing loops is VpnService.Builder
 *   .addDisallowedApplication(packageName), which excludes all of our app's
 *   sockets from the VPN. The JNI protect callback is a defense-in-depth
 *   mechanism for patched versions of hev-socks5-tunnel.
 *
 * Copyright: BlockProxy project, MIT license.
 */

#include <jni.h>
#include <android/log.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <pthread.h>

#include <hev-socks5-tunnel.h>

#define TAG "Tun2Socks-JNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)
#define LOGD(...) __android_log_print(ANDROID_LOG_DEBUG, TAG, __VA_ARGS__)

/* Max length for generated YAML config string */
#define CONFIG_BUF_SIZE 512

/* ── Globals ──────────────────────────────────────────────────────────────── */

static JavaVM *g_jvm = NULL;

/* VpnService class and instance for protect() callback */
static jclass    g_vpn_service_class  = NULL;  /* Global ref to VpnService class */
static jobject   g_vpn_service_object = NULL;  /* Global ref to VpnService instance */
static jmethodID g_protect_method     = NULL;  /* Cached protect(I)Z method ID */

/* Native tunnel thread */
static pthread_t  g_tunnel_thread = 0;
static int        g_tunnel_running = 0;

/* Config stored for the tunnel thread to use */
static char       g_config_buf[CONFIG_BUF_SIZE];
static int        g_tun_fd = -1;

/* ── JNI_OnLoad ───────────────────────────────────────────────────────────── */

/*
 * Called when System.loadLibrary("tun2socks") is executed.
 * Caches the JavaVM pointer (needed for AttachCurrentThread from native threads)
 * and looks up the VpnService.protect() method ID.
 */
JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved) {
    (void)reserved;
    g_jvm = vm;

    JNIEnv *env;
    if ((*vm)->GetEnv(vm, (void **)&env, JNI_VERSION_1_6) != JNI_OK) {
        LOGE("JNI_OnLoad: GetEnv failed");
        return JNI_ERR;
    }

    /* Cache VpnService class and protect method.
     * Note: android.net.VpnService is guaranteed to be on the classpath. */
    jclass cls = (*env)->FindClass(env, "android/net/VpnService");
    if (cls) {
        g_vpn_service_class = (*env)->NewGlobalRef(env, cls);
        g_protect_method = (*env)->GetMethodID(env, cls, "protect", "(I)Z");
        (*env)->DeleteLocalRef(env, cls);
    }

    LOGI("JNI_OnLoad complete");
    return JNI_VERSION_1_6;
}

/* ── JNI_OnUnload ─────────────────────────────────────────────────────────── */

JNIEXPORT void JNICALL JNI_OnUnload(JavaVM *vm, void *reserved) {
    (void)reserved;
    JNIEnv *env;
    if ((*vm)->GetEnv(vm, (void **)&env, JNI_VERSION_1_6) != JNI_OK) return;

    if (g_vpn_service_object) {
        (*env)->DeleteGlobalRef(env, g_vpn_service_object);
        g_vpn_service_object = NULL;
    }
    if (g_vpn_service_class) {
        (*env)->DeleteGlobalRef(env, g_vpn_service_class);
        g_vpn_service_class = NULL;
    }
    g_protect_method = NULL;
}

/* ── Socket protect callback ──────────────────────────────────────────────── */

/*
 * Calls VpnService.protect(socketFd) to bypass the VPN for the given socket.
 *
 * This function can be called from any thread. If the current thread is not
 * attached to the JVM, it temporarily attaches.
 *
 * The primary routing-loop prevention is addDisallowedApplication() in the
 * VpnService Builder. This callback is a defense-in-depth mechanism for
 * patched versions of hev-socks5-tunnel that support a protect hook.
 *
 * Returns 0 on success, -1 on failure.
 */
static int protect_socket(int socket_fd) {
    if (!g_jvm || !g_vpn_service_object || !g_protect_method) {
        LOGD("protect_socket: no VpnService reference, skipping (fd=%d)", socket_fd);
        return -1;
    }

    JNIEnv *env = NULL;
    int need_detach = 0;

    int status = (*g_jvm)->GetEnv(g_jvm, (void **)&env, JNI_VERSION_1_6);
    if (status == JNI_EDETACHED) {
        /* Native thread — attach temporarily */
        if ((*g_jvm)->AttachCurrentThread(g_jvm, &env, NULL) != JNI_OK) {
            LOGE("protect_socket: AttachCurrentThread failed");
            return -1;
        }
        need_detach = 1;
    } else if (status != JNI_OK) {
        LOGE("protect_socket: GetEnv failed with status %d", status);
        return -1;
    }

    jboolean result = (*env)->CallBooleanMethod(
        env, g_vpn_service_object, g_protect_method, (jint)socket_fd);

    if ((*env)->ExceptionCheck(env)) {
        (*env)->ExceptionDescribe(env);
        (*env)->ExceptionClear(env);
        result = JNI_FALSE;
    }

    if (need_detach) {
        (*g_jvm)->DetachCurrentThread(g_jvm);
    }

    LOGD("protect_socket: fd=%d result=%d", socket_fd, (int)result);
    return result ? 0 : -1;
}

/* ── Tunnel thread ────────────────────────────────────────────────────────── */

/*
 * Native thread entry point. Runs hev_socks5_tunnel_main_from_str() which
 * blocks until hev_socks5_tunnel_quit() is called or an error occurs.
 *
 * The config string and tun_fd are read from globals set by nativeStart().
 */
static void *tunnel_thread_func(void *arg) {
    (void)arg;

    LOGI("Tunnel thread started, tun_fd=%d", g_tun_fd);

    unsigned int config_len = (unsigned int)strlen(g_config_buf);
    int ret = hev_socks5_tunnel_main_from_str(
        (const unsigned char *)g_config_buf, config_len, g_tun_fd);

    if (ret < 0) {
        LOGE("hev_socks5_tunnel_main_from_str failed: %d", ret);
    }

    LOGI("Tunnel thread exiting (ret=%d)", ret);
    g_tunnel_running = 0;
    g_tunnel_thread = 0;

    return NULL;
}

/* ── Java_com_blockproxy_android_tun_Tun2Socks_nativeStart ────────────────── */

/*
 * Starts the TUN→SOCKS5 tunnel.
 *
 * Parameters:
 *   clazz  — Tun2Socks class (unused, static method)
 *   fd     — TUN interface file descriptor (from ParcelFileDescriptor.detachFd())
 *   host   — SOCKS5 server address (typically "127.0.0.1")
 *   port   — SOCKS5 server port
 *
 * This function:
 * 1. Builds a YAML config string from the host/port parameters
 * 2. Spawns a detached native thread that calls hev_socks5_tunnel_main_from_str()
 * 3. Returns immediately (0 on success, -1 on error)
 *
 * The blocking tunnel call runs in the native thread. Call nativeStop() to
 * signal the tunnel to quit, which unblocks the native thread.
 *
 * The TUN fd ownership is transferred to the native library — it will be
 * consumed/closed when the tunnel stops.
 */
JNIEXPORT jint JNICALL
Java_com_blockproxy_android_tun_Tun2Socks_nativeStart(
    JNIEnv *env, jclass clazz,
    jint fd, jstring host, jint port)
{
    (void)clazz;

    if (g_tunnel_running) {
        LOGE("nativeStart: tunnel already running");
        return -1;
    }

    const char *socks_host = (*env)->GetStringUTFChars(env, host, NULL);
    if (!socks_host) {
        LOGE("nativeStart: GetStringUTFChars failed");
        return -1;
    }

    /* Build YAML config string.
     * The tunnel section configures the TUN interface parameters.
     * Since we already created the TUN via VpnService.Builder and pass the fd,
     * the tunnel section only needs MTU (matching what we set in the Builder).
     * The socks5 section points to our local SOCKS5 server.
     * UDP mode "tcp" means UDP-over-TCP relay (required since SOCKS5 server
     * is on loopback and our architecture handles UDP through the tunnel). */
    snprintf(g_config_buf, CONFIG_BUF_SIZE,
        "tunnel:\n"
        "  mtu: 1500\n"
        "\n"
        "socks5:\n"
        "  address: %s\n"
        "  port: %d\n"
        "  udp: tcp\n",
        socks_host, (int)port);

    (*env)->ReleaseStringUTFChars(env, host, socks_host);

    g_tun_fd = (int)fd;

    LOGI("Starting tun2socks: tun_fd=%d, socks5=%s:%d", (int)fd, socks_host, (int)port);
    LOGD("Config:\n%s", g_config_buf);

    /* Spawn the tunnel thread */
    g_tunnel_running = 1;
    int ret = pthread_create(&g_tunnel_thread, NULL, tunnel_thread_func, NULL);
    if (ret != 0) {
        LOGE("pthread_create failed: %d", ret);
        g_tunnel_running = 0;
        return -1;
    }

    /* Detach the thread — we don't need to join it; it cleans up on exit */
    pthread_detach(g_tunnel_thread);

    LOGI("tun2socks tunnel thread started");
    return 0;
}

/* ── Java_com_blockproxy_android_tun_Tun2Socks_nativeStop ─────────────────── */

/*
 * Signals the tunnel to stop. The hev_socks5_tunnel_quit() function sets a
 * quit flag that causes hev_socks5_tunnel_main_from_str() to return in the
 * native thread. The thread then exits asynchronously.
 *
 * Safe to call even if the tunnel is not running.
 */
JNIEXPORT void JNICALL
Java_com_blockproxy_android_tun_Tun2Socks_nativeStop(
    JNIEnv *env, jclass clazz)
{
    (void)env;
    (void)clazz;

    if (!g_tunnel_running) {
        LOGD("nativeStop: tunnel not running");
        return;
    }

    LOGI("Stopping tun2socks");
    hev_socks5_tunnel_quit();
    /* The native thread will exit asynchronously and set g_tunnel_running = 0 */
}

/* ── Java_com_blockproxy_android_tun_Tun2Socks_nativeStats ────────────────── */

/*
 * Retrieves TX/RX traffic statistics from the tunnel.
 *
 * Returns a jlongArray with 4 elements:
 *   [0] = tx_packets  (outbound packets sent through tunnel)
 *   [1] = tx_bytes    (outbound bytes sent through tunnel)
 *   [2] = rx_packets  (inbound packets received from tunnel)
 *   [3] = rx_bytes    (inbound bytes received from tunnel)
 *
 * Returns NULL on allocation failure.
 */
JNIEXPORT jlongArray JNICALL
Java_com_blockproxy_android_tun_Tun2Socks_nativeStats(
    JNIEnv *env, jclass clazz)
{
    (void)clazz;

    size_t tx_packets = 0, tx_bytes = 0;
    size_t rx_packets = 0, rx_bytes = 0;

    hev_socks5_tunnel_stats(&tx_packets, &tx_bytes, &rx_packets, &rx_bytes);

    jlongArray result = (*env)->NewLongArray(env, 4);
    if (!result) return NULL;

    jlong stats[4] = {
        (jlong)tx_packets,
        (jlong)tx_bytes,
        (jlong)rx_packets,
        (jlong)rx_bytes,
    };
    (*env)->SetLongArrayRegion(env, result, 0, 4, stats);

    return result;
}

/* ── Java_com_blockproxy_android_tun_Tun2Socks_nativeSetProtect ───────────── */

/*
 * Stores a global reference to the VpnService instance for protect() callbacks.
 *
 * Must be called before nativeStart() so that the protect callback is available
 * when the tunnel creates outbound sockets.
 *
 * Call with service=NULL to clear the reference (e.g., when the service is destroyed).
 */
JNIEXPORT void JNICALL
Java_com_blockproxy_android_tun_Tun2Socks_nativeSetProtect(
    JNIEnv *env, jclass clazz, jobject service)
{
    (void)clazz;

    /* Clear previous reference */
    if (g_vpn_service_object) {
        (*env)->DeleteGlobalRef(env, g_vpn_service_object);
        g_vpn_service_object = NULL;
    }

    /* Set new reference */
    if (service) {
        g_vpn_service_object = (*env)->NewGlobalRef(env, service);
        LOGI("protect callback enabled");
    } else {
        LOGI("protect callback disabled");
    }
}
