#!/bin/bash
set -e

XRAY_VERSION="v25.5.16"
PLATFORM="macos"
ARCH=$(uname -m)

if [ "$ARCH" = "arm64" ]; then
    FILENAME="Xray-macos-arm64-v8a.zip"
elif [ "$ARCH" = "x86_64" ]; then
    FILENAME="Xray-macos-64.zip"
else
    echo "Unsupported architecture: $ARCH"
    exit 1
fi

URL="https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/${FILENAME}"
DEST_DIR="$(cd "$(dirname "$0")/../resources" && pwd)"

echo "Downloading xray-core ${XRAY_VERSION} for ${ARCH}..."
curl -L -o /tmp/xray.zip "$URL"

echo "Extracting..."
unzip -o /tmp/xray.zip xray -d /tmp
mv /tmp/xray "$DEST_DIR/core"
chmod +x "$DEST_DIR/core"
rm /tmp/xray.zip

echo "Done: $DEST_DIR/core"
"$DEST_DIR/core" version
