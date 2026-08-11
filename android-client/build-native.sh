#!/bin/bash
# build-native.sh — Build the native tun2socks library for Android
#
# Prerequisites:
#   - Android NDK installed (set ANDROID_NDK_HOME or ndk-build on PATH)
#   - hev-socks5-tunnel submodule initialized:
#       git submodule update --init --recursive native/hev-socks5-tunnel
#
# Usage:
#   cd android-client
#   bash build-native.sh                  # Build arm64-v8a only (default)
#   bash build-native.sh arm64-v8a,armeabi-v7a,x86_64  # Build multiple ABIs
#
# Output:
#   native/libs/<abi>/libhev-socks5-tunnel.so
#   native/libs/<abi>/libtun2socks.so
#   Copied automatically to app/src/main/jniLibs/<abi>/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NATIVE_DIR="$SCRIPT_DIR/native"
JNI_LIBS_DIR="$SCRIPT_DIR/app/src/main/jniLibs"

# Default ABI
ABIS="${1:-arm64-v8a}"

# Find ndk-build
if command -v ndk-build &>/dev/null; then
    NDK_BUILD="ndk-build"
elif [ -n "${ANDROID_NDK_HOME:-}" ]; then
    NDK_BUILD="$ANDROID_NDK_HOME/ndk-build"
elif [ -n "${ANDROID_HOME:-}" ]; then
    # Try to find NDK in the Android SDK
    NDK_DIR=$(ls -d "$ANDROID_HOME/ndk/"* 2>/dev/null | sort -V | tail -1)
    if [ -n "$NDK_DIR" ]; then
        NDK_BUILD="$NDK_DIR/ndk-build"
    else
        echo "Error: ndk-build not found. Install NDK or set ANDROID_NDK_HOME." >&2
        exit 1
    fi
else
    echo "Error: ndk-build not found. Install NDK or set ANDROID_NDK_HOME." >&2
    exit 1
fi

echo "Using ndk-build: $NDK_BUILD"

# Verify submodule exists
if [ ! -f "$NATIVE_DIR/hev-socks5-tunnel/Android.mk" ]; then
    echo "Error: hev-socks5-tunnel submodule not found." >&2
    echo "Run: git submodule update --init --recursive native/hev-socks5-tunnel" >&2
    exit 1
fi

# Build
echo "Building for ABIs: $ABIS"
cd "$SCRIPT_DIR"
"$NDK_BUILD" \
    NDK_PROJECT_PATH="$NATIVE_DIR" \
    APP_BUILD_SCRIPT="$NATIVE_DIR/jni/Android.mk" \
    APP_PLATFORM=android-21 \
    APP_ABI="$ABIS"

# Copy .so files to jniLibs
echo ""
echo "Copying libraries to jniLibs..."
for abi in $(echo "$ABIS" | tr ',' ' '); do
    src_dir="$NATIVE_DIR/libs/$abi"
    dst_dir="$JNI_LIBS_DIR/$abi"

    if [ ! -d "$src_dir" ]; then
        echo "Warning: No output for $abi" >&2
        continue
    fi

    mkdir -p "$dst_dir"
    for so in "$src_dir"/*.so; do
        if [ -f "$so" ]; then
            cp "$so" "$dst_dir/"
            echo "  $(basename "$so") → $dst_dir/"
        fi
    done
done

echo ""
echo "Build complete. Libraries are in $JNI_LIBS_DIR/"
echo "Run './gradlew build' to build the Android app."
