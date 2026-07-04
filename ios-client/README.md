# iOS Client Command-Line Guide

This guide describes how to build, sign, install, and start the iOS client after the design and implementation plans are complete:

- `docs/plans/2026-07-03-ios-client-design.md`
- `docs/plans/2026-07-03-ios-client-plan.md`

The iOS client is a Swift + Network Extension app. Xcode must be installed because the project depends on Apple signing, entitlements, iOS SDKs, `xcodebuild`, and device tooling. Day-to-day operations can still be done from the command line.

## What Cannot Be Fully Automated

Some steps still require Apple or device UI:

- Apple Developer account setup and capability approval may require the Apple Developer Portal or Xcode account login.
- The first VPN permission prompt must be accepted on the iPhone.
- Trusting a development certificate may require interaction on the iPhone.

Everything else should be scriptable once signing and device trust are ready.

## Required Tools

```bash
sudo xcode-select --switch /Applications/Xcode.app
xcodebuild -version
xcrun devicectl list devices
```

Install XcodeGen if the project uses `project.yml` to generate the Xcode project:

```bash
brew install xcodegen
```

## Apple Developer Setup

Use one Apple Developer Team for both targets.

Recommended identifiers:

```text
App Bundle ID:       com.yourname.blockproxy
Extension Bundle ID: com.yourname.blockproxy.tunnel-extension
App Group:           group.com.yourname.blockproxy
```

Required capabilities:

- Main app target:
  - App Groups
  - Keychain Sharing
- Tunnel extension target:
  - Network Extensions: Packet Tunnel Provider
  - App Groups
  - Keychain Sharing

The App Group and Keychain access group must be shared by both targets so the app can pass configuration and credentials to the extension.

## Expected Project Layout

After implementation, the directory should look roughly like this:

```text
ios-client/
  README.md
  project.yml
  BlockProxy.xcodeproj/
  BlockProxy/
    App/
    Models/
    Services/
    Utils/
    Views/
    BlockProxy.entitlements
  TunnelExtension/
    PacketTunnelProvider.swift
    TunnelClient.swift
    FrameCodec.swift
    TunnelConfig.swift
    TunnelExtension.entitlements
```

If `project.yml` is the source of truth, regenerate the Xcode project after changing targets, entitlements, or build settings:

```bash
xcodegen generate --spec ios-client/project.yml
```

## Build From Command Line

Find the device UDID:

```bash
xcrun devicectl list devices
```

Build for a real iPhone:

```bash
xcodebuild \
  -project ios-client/BlockProxy.xcodeproj \
  -scheme BlockProxy \
  -configuration Debug \
  -destination 'platform=iOS,id=<DEVICE_UDID>' \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<TEAM_ID> \
  build
```

If the build output location is customized, adjust the install path below. Otherwise inspect the build products:

```bash
xcodebuild \
  -project ios-client/BlockProxy.xcodeproj \
  -scheme BlockProxy \
  -configuration Debug \
  -showBuildSettings | rg 'TARGET_BUILD_DIR|WRAPPER_NAME'
```

## Install To iPhone

Install the built app:

```bash
xcrun devicectl device install app \
  --device <DEVICE_UDID> \
  <TARGET_BUILD_DIR>/BlockProxy.app
```

Launch the app:

```bash
xcrun devicectl device process launch \
  --device <DEVICE_UDID> \
  com.yourname.blockproxy
```

On first launch, configure the server and start the tunnel from the app UI. iOS will show a system VPN permission dialog. Accept it on the device.

## Runtime Configuration

The app should collect at least:

- Server address
- Tunnel server port, default `8003`
- Username
- Password
- TLS enabled
- `allowInsecure`, default `true`

`allowInsecure=true` means TLS still encrypts tunnel traffic but does not require the server certificate chain to be trusted by iOS. This is the default for personal sideloading and private deployments.

## Starting The Tunnel

The main app starts the VPN through `NETunnelProviderManager` and `startVPNTunnel()`.

The system then starts the Packet Tunnel Provider extension, whose `startTunnel()` should:

1. Apply the empty-route VPN settings.
2. Load configuration from App Group storage and Keychain.
3. Start `TunnelClient`.
4. Return from `startTunnel()` without waiting for the tunnel to connect.

The connected/reconnecting/auth failed state is reported asynchronously through App Group status and provider messages.

## Stopping The Tunnel

When the user disables the tunnel or iOS stops the extension, `stopTunnel()` should:

1. Stop the reconnect loop.
2. Close all tunnel and target connections.
3. Cancel relay tasks if graceful shutdown times out.
4. Call the `stopTunnel()` completion handler after cleanup or timeout.

## Debugging

Main app logs are visible when launching from Xcode or device logs.

For the extension:

```bash
xcrun devicectl device log stream --device <DEVICE_UDID>
```

You can also open Xcode only for debugging:

1. Run or launch the app.
2. Start the VPN from the app.
3. In Xcode, use Debug > Attach to Process.
4. Select the tunnel extension process.

## Server-Side Requirements

The iPhone must be able to reach the block-proxy tunnel port, usually `8003`.

The block-proxy server must also route matching requests into the tunnel. In the web admin UI, add the target domains to the tunnel domain list:

```text
tunnel_domains: ["example.com"]
```

If testing by IP address, make sure the server rule path can match that target. If `tunnel_domains` does not match, the iOS tunnel may be connected but requests will not call `TunnelManager.forward()`.

## End-To-End Smoke Test

1. Start block-proxy server with tunnel enabled.
2. Add a test domain to `tunnel_domains`.
3. Build and install the iOS app.
4. Configure server address, port, username, password, TLS, and `allowInsecure=true`.
5. Start the tunnel and accept iOS VPN permission.
6. Confirm server shows one or two tunnel connections.
7. From an external client through block-proxy, access the configured domain.
8. Confirm the request reaches a TCP service on the iPhone-side LAN.

## Common Failure Modes

| Symptom | Check |
|---|---|
| Build fails with entitlement errors | Confirm App IDs, provisioning profiles, App Groups, and Network Extension capability. |
| App installs but VPN cannot start | Confirm the Packet Tunnel Provider extension is embedded and signed. |
| Tunnel connects but traffic does not go through it | Confirm server `tunnel_domains` matches the target. |
| TLS fails | Keep `allowInsecure=true` for private deployments, or install/trust the server certificate. |
| Works on WiFi but fails on cellular | Check server reachability, carrier NAT behavior, idle timeout, and reconnect logs. |
| Multiple VPN configs cause wrong tunnel to start | Ensure `VPNManager` selects the manager by provider bundle ID, not `first`. |
