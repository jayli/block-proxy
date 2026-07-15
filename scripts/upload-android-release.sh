#!/usr/bin/env bash
set -euo pipefail

TAG="${1:-${RELEASE_TAG:-}}"
if [[ -z "$TAG" ]]; then
  echo "Usage: npm run android:release:upload -- <tag>"
  echo "   or: RELEASE_TAG=<tag> npm run android:release:upload"
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APK="$ROOT_DIR/android-client/app/build/outputs/apk/phone/debug/BlockProxyClient-android.apk"

cd "$ROOT_DIR/android-client"
./gradlew :app:assemblePhoneDebug

cd "$ROOT_DIR"
if [[ ! -f "$APK" ]]; then
  echo "APK not found: $APK"
  exit 1
fi

gh release upload "$TAG" "$APK" --clobber
