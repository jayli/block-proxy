#!/usr/bin/env bash
# Build and install the debug APK that matches the connected Android target.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

ADB="${ADB:-}"
if [ -z "$ADB" ]; then
    if [ -x "$HOME/Library/Android/sdk/platform-tools/adb" ]; then
        ADB="$HOME/Library/Android/sdk/platform-tools/adb"
    elif command -v adb >/dev/null 2>&1; then
        ADB="$(command -v adb)"
    else
        echo "Error: adb not found. Set ADB=/path/to/adb or add adb to PATH." >&2
        exit 1
    fi
fi

SERIAL="${ADB_SERIAL:-${1:-}}"

adb_target() {
    if [ -n "$SERIAL" ]; then
        "$ADB" -s "$SERIAL" "$@"
    else
        "$ADB" "$@"
    fi
}

device_abi=""
if adb_target get-state >/dev/null 2>&1; then
    device_abi="$(adb_target shell getprop ro.product.cpu.abi 2>/dev/null | tr -d '\r' || true)"
fi

host_arch="$(uname -m)"
selector="${device_abi:-$host_arch}"

case "$selector" in
    x86|x86_64|i386|i686|amd64)
        flavor="Emulator"
        apk="app/build/outputs/apk/emulator/debug/BlockProxyClient-android-emulator.apk"
        ;;
    arm64-v8a|armeabi-v7a|armeabi|arm64|aarch64|armv7l)
        flavor="Phone"
        apk="app/build/outputs/apk/phone/debug/BlockProxyClient-android.apk"
        ;;
    *)
        echo "Error: unsupported Android ABI or host architecture: $selector" >&2
        echo "Device ABI: ${device_abi:-unavailable}; host arch: $host_arch" >&2
        exit 1
        ;;
esac

if [ -n "$device_abi" ]; then
    echo "Target ABI: $device_abi -> ${flavor}Debug"
else
    echo "Target ABI unavailable; host arch: $host_arch -> ${flavor}Debug"
fi

./gradlew ":app:assemble${flavor}Debug"

if ! adb_target get-state >/dev/null 2>&1; then
    echo "Error: no Android device is available for install." >&2
    echo "Built APK: $SCRIPT_DIR/$apk" >&2
    exit 1
fi

adb_target install -r "$apk"
