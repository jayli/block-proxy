# BlockProxy Android Client

Android tunnel client for block-proxy. Establishes 1-2 TLS tunnels to a block-proxy server and allows the server to reverse-connect into the Android device's local network.

## Build

```bash
./gradlew :app:assembleDebug
```

## Install

```bash
adb install app/build/outputs/apk/debug/app-debug.apk
```
