# NDK build file for BlockProxy tun2socks integration.
#
# This build file:
# 1. Includes the hev-socks5-tunnel submodule (builds libhev-socks5-tunnel.so
#    and the hev-socks5-tunnel-bin executable)
# 2. Adds our JNI wrapper module (libtun2socks.so) that links against
#    libhev-socks5-tunnel.so
#
# Build command:
#   cd android-client
#   ndk-build NDK_PROJECT_PATH=native APP_BUILD_SCRIPT=native/jni/Android.mk \
#             APP_PLATFORM=android-21 APP_ABI=arm64-v8a
#
# Output:
#   native/libs/arm64-v8a/libhev-socks5-tunnel.so  (tunnel library)
#   native/libs/arm64-v8a/libtun2socks.so           (JNI wrapper)
#
# Copy to jniLibs:
#   cp native/libs/arm64-v8a/*.so app/src/main/jniLibs/arm64-v8a/

NATIVE_DIR := $(call my-dir)/..
HEV_TUNNEL_DIR := $(NATIVE_DIR)/hev-socks5-tunnel

# Include the hev-socks5-tunnel submodule's Android.mk
# It defines two modules: hev-socks5-tunnel (shared lib) and hev-socks5-tunnel-bin (executable)
# Guard with modules-get-list to prevent double-inclusion
ifeq ($(filter $(modules-get-list),hev-socks5-tunnel),)
  ifneq ($(wildcard $(HEV_TUNNEL_DIR)/Android.mk),)
    include $(HEV_TUNNEL_DIR)/Android.mk
  else
    $(warning hev-socks5-tunnel not found at $(HEV_TUNNEL_DIR). Run: git submodule update --init --recursive)
  endif
endif

# ── JNI wrapper module ──────────────────────────────────────────────────────
# Thin JNI bridge that wraps hev-socks5-tunnel's C API for Kotlin/Java access.
# Produces libtun2socks.so which is loaded via System.loadLibrary("tun2socks").

LOCAL_PATH := $(NATIVE_DIR)/jni

include $(CLEAR_VARS)
LOCAL_MODULE := tun2socks
LOCAL_SRC_FILES := tun2socks_jni.c
LOCAL_C_INCLUDES := $(HEV_TUNNEL_DIR)/include
LOCAL_SHARED_LIBRARIES := hev-socks5-tunnel
LOCAL_LDLIBS := -llog
include $(BUILD_SHARED_LIBRARY)
