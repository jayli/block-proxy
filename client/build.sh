#!/bin/bash
set -e

APP_NAME="BlockProxyClient"
BUNDLE_ID="com.jaylli.blockproxyclient"
VERSION="0.1.4"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="$SCRIPT_DIR/dist"
APP_DIR="$DIST_DIR/$APP_NAME.app"

# Detect architecture
ARCH=$(uname -m)
ZIP_NAME="BlockProxyClient-macos-${ARCH}.zip"

echo "==> Detected architecture: $ARCH"

echo "==> Cleaning old build..."
rm -rf "$DIST_DIR" "$SCRIPT_DIR/main.build" "$SCRIPT_DIR/main.dist"
rm -f "$DIST_DIR"/*.zip

# Find python3 from PATH
PYTHON=$(command -v python3 || true)
if [ -z "$PYTHON" ]; then
    echo "ERROR: python3 not found in PATH"
    exit 1
fi
echo "==> Using Python: $PYTHON ($($PYTHON --version))"

# Check nuitka
if ! $PYTHON -m nuitka --version &>/dev/null; then
    echo "ERROR: nuitka not installed. Run: $PYTHON -m pip install nuitka"
    exit 1
fi

echo "==> Generating geodata_tags.json..."
$PYTHON "$SCRIPT_DIR/scripts/gen_geodata_tags.py"

echo "==> Generating app.icns from app_icon.png..."
ICONSET=$(mktemp -d)/app.iconset
mkdir -p "$ICONSET"
sips -z 16 16 "$SCRIPT_DIR/icons/app_icon.png" --out "$ICONSET/icon_16x16.png" &>/dev/null
sips -z 32 32 "$SCRIPT_DIR/icons/app_icon.png" --out "$ICONSET/icon_16x16@2x.png" &>/dev/null
sips -z 32 32 "$SCRIPT_DIR/icons/app_icon.png" --out "$ICONSET/icon_32x32.png" &>/dev/null
sips -z 64 64 "$SCRIPT_DIR/icons/app_icon.png" --out "$ICONSET/icon_32x32@2x.png" &>/dev/null
sips -z 128 128 "$SCRIPT_DIR/icons/app_icon.png" --out "$ICONSET/icon_128x128.png" &>/dev/null
sips -z 256 256 "$SCRIPT_DIR/icons/app_icon.png" --out "$ICONSET/icon_128x128@2x.png" &>/dev/null
sips -z 256 256 "$SCRIPT_DIR/icons/app_icon.png" --out "$ICONSET/icon_256x256.png" &>/dev/null
sips -z 512 512 "$SCRIPT_DIR/icons/app_icon.png" --out "$ICONSET/icon_256x256@2x.png" &>/dev/null
sips -z 512 512 "$SCRIPT_DIR/icons/app_icon.png" --out "$ICONSET/icon_512x512.png" &>/dev/null
sips -z 1024 1024 "$SCRIPT_DIR/icons/app_icon.png" --out "$ICONSET/icon_512x512@2x.png" &>/dev/null
iconutil -c icns "$ICONSET" -o "$SCRIPT_DIR/icons/app.icns"
rm -rf "$(dirname "$ICONSET")"

echo "==> Building with Nuitka..."
cd "$SCRIPT_DIR"
$PYTHON -m nuitka \
    --standalone \
    --macos-create-app-bundle \
    --macos-app-name="$APP_NAME" \
    --macos-app-icon=icons/app.icns \
    --macos-app-mode=ui-element \
    --include-data-dir=icons=icons \
    --include-data-files=app.py=app.py \
    --include-data-files=autostart.py=autostart.py \
    --include-data-files=config.py=config.py \
    --include-data-files=config_window.py=config_window.py \
    --include-data-files=geodata_loader.py=geodata_loader.py \
    --include-data-files=logger.py=logger.py \
    --include-data-files=log_window.py=log_window.py \
    --include-data-files=proto_parser.py=proto_parser.py \
    --include-data-files=proxy_core.py=proxy_core.py \
    --include-data-files=routing.py=routing.py \
    --include-data-files=routing_window.py=routing_window.py \
    --include-data-files=system_proxy.py=system_proxy.py \
    --include-data-files=traffic_stats.py=traffic_stats.py \
    --include-data-files=traffic_view.py=traffic_view.py \
    --include-data-files=tunnel_client.py=tunnel_client.py \
    --include-data-dir=geodata=geodata \
    --include-package=websockets \
    --enable-plugin=no-qt \
    --output-dir="$DIST_DIR" \
    main.py

echo "==> Renaming app bundle..."
mv "$DIST_DIR/main.app" "$APP_DIR"

echo "==> Fixing executable name..."
mv "$APP_DIR/Contents/MacOS/main" "$APP_DIR/Contents/MacOS/$APP_NAME"

echo "==> Patching Info.plist..."
plutil -replace CFBundleExecutable -string "$APP_NAME" "$APP_DIR/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$APP_DIR/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$VERSION" "$APP_DIR/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP_DIR/Contents/Info.plist"
plutil -replace NSSupportsAutomaticIconComposition -bool false "$APP_DIR/Contents/Info.plist"

echo "==> Setting custom icon (bypass Liquid Glass)..."
fileicon set "$APP_DIR" "$SCRIPT_DIR/icons/app_icon.png"

echo "==> Cleaning Nuitka build artifacts..."
rm -rf "$DIST_DIR/main.build" "$DIST_DIR/main.dist"

echo "==> Packaging..."
cd "$DIST_DIR"
rm -f "$ZIP_NAME"
zip -r -q "$ZIP_NAME" "$APP_NAME.app"

echo "==> Build complete: $APP_DIR"
echo "==> Package: $DIST_DIR/$ZIP_NAME"
