# BlockProxy Android Client

Android tunnel client for block-proxy. Establishes 1-2 TLS tunnels to a block-proxy server and allows the server to reverse-connect into the Android device's local network.

## Prerequisites

- Android Studio Hedgehog (2023.1.1) or later
- JDK 17 (included with Android Studio)
- Android SDK with API 35 (compileSdk) and minSdk 26
- Android device or emulator (API 26+, Android 8.0+)
- `adb` installed and accessible

## Build

### Debug APK

```bash
./gradlew :app:assembleDebug
```

Output: `app/build/outputs/apk/debug/app-debug.apk`

### Release APK

```bash
./gradlew :app:assembleRelease
```

Requires signing configuration in `app/build.gradle.kts`.

## Install

```bash
# Install (first time)
adb install app/build/outputs/apk/debug/app-debug.apk

# Reinstall (upgrade)
adb install -r app/build/outputs/apk/debug/app-debug.apk

# Uninstall
adb uninstall com.blockproxy.android
```

## Test

### Run all unit tests

```bash
./gradlew :app:testDebugUnitTest
```

### Run specific test class

```bash
# Run a single test class
./gradlew :app:testDebugUnitTest --tests '*FrameCodecTest'

# Run a single test method
./gradlew :app:testDebugUnitTest --tests '*FrameCodecTest.encode*'
```

### Run integration tests

```bash
./gradlew :app:testDebugUnitTest --tests '*TunnelProtocolIntegrationTest'
```

### Test reports

HTML report: `app/build/reports/tests/testDebugUnitTest/index.html`

### Test coverage

The test suite includes:
- `FrameCodecTest` — Frame encoding/decoding (all frame types)
- `FrameExtractorTest` — TCP stream reassembly with fragmentation
- `SendQueueTest` — Serial write queue ordering and error handling
- `TunnelConnectionTest` — Connection lifecycle, auth, idle timeout
- `ReverseConnectHandlerTest` — Reverse-connect sessions, data relay, cleanup
- `TunnelClientTest` — Dual-connection management, reconnection, backoff
- `TunnelProtocolIntegrationTest` — End-to-end protocol with real sockets (no TLS)

## Architecture

```
TunnelClient (dual-connection manager)
├── TunnelConnection (single authenticated tunnel)
│   ├── TunnelSocket (transport: TLS or plain TCP)
│   ├── FrameExtractor (TCP stream → frames)
│   ├── SendQueue (serial frame writer)
│   └── FrameCodec (frame encode/decode)
├── ReverseConnectHandler (reverse-connect sessions)
│   └── RequestSession (per-request bidirectional relay)
│       └── TargetSocket (downstream TCP connection)
├── ServerConfig (server address, TLS settings)
└── TunnelCredentials (username/password)
```

## Deployment

See [deployment guide](../docs/android-client-deployment.md) for:
- Prerequisites and setup
- Server-side `tunnel_domains` configuration
- Smoke testing steps
- Common failures and troubleshooting

## Known Limitations

- Android VpnService always shows a VPN icon in the status bar (system behavior)
- Dual-connection replenishment: up to 3 attempts with 1s → 2s → 4s delays
- Network switching (WiFi ↔ mobile) causes brief tunnel disconnection
- App must be manually restarted after being killed by the system
