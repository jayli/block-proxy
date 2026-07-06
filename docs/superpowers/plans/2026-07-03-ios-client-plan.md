# iOS Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an iOS tunnel client that establishes TLS tunnels to a block-proxy server, enabling the server to reverse-connect into the iOS device's local network.

**Architecture:** SwiftUI main app controls a Network Extension (NEPacketTunnelProvider) that maintains 1–2 TLS tunnel connections via NWConnection. The extension receives reverse CONNECT requests from the server and opens TCP connections to local network targets, relaying data bidirectionally. Communication between app and extension uses App Group UserDefaults + Darwin Notification.

**Tech Stack:** Swift 5.9+, SwiftUI, Network.framework, NetworkExtension.framework, XCTest

## Global Constraints

Every task implicitly includes these requirements from [the design spec](../specs/2026-07-03-ios-client-design.md):

- iOS 17.0 minimum deployment target
- Network Extension bundle ID: `com.blockproxy.tunnel-extension`
- App Group: `group.com.blockproxy`
- Initial tunnel connect timeout: **10 seconds**
- Reverse target connect timeout: **30 seconds**
- Frame idle timeout: **60 seconds** (full-frame only; partial receives do NOT reset)
- Reconnect backoff: initial **1s**, factor **2x**, cap **60s**
- Max tunnel connections: **2**
- Max frame payload: **65535 bytes**; max DATA chunk: **65532 bytes**
- TLS minimum version: TLS 1.2; default `allowInsecure = true`
- Reverse reqid range: `0x0001–0x7FFF` (server-allocated); forward `0x8000–0xFFFE` reserved but unused in v1
- Per-connection send queue: all frames serialized, wire order = enqueue order
- `start()` must return immediately; `stop()` must complete within timeout or force-cancel
- Every reverse reqid is bound to the exact `TunnelConnection` that received its CONNECT frame. All `CONNECT_OK`, `CONNECT_FAILED`, `DATA`, and `CLOSE` responses for that reqid MUST be sent on that same tunnel connection.
- The second tunnel connection is fully active, not standby: after authentication it MUST start its own receive loop and respond to PING independently.
- Do not store tunnel passwords in App Group UserDefaults. `ServerConfig` stores non-sensitive connection settings only; credentials are loaded from Keychain at runtime.
- Keychain access group is the entitlement value `$(AppIdentifierPrefix)com.blockproxy`, not the App Group identifier `group.com.blockproxy`.
- The code snippets in this plan are implementation guides. If a snippet conflicts with these global constraints, the global constraints win.

### Frame Constants (shared across all tasks)

```swift
enum FrameType: UInt8 {
    case connect = 0x01, data = 0x02, close = 0x03, connectOK = 0x04
    case ping = 0x10, pong = 0x11
    case auth = 0x20, authOK = 0x21, authFail = 0x22, error = 0x23
    case connectFailed = 0x81
}

enum AddressType: UInt8 {
    case ipv4 = 0x01, domain = 0x03, ipv6 = 0x04
}

enum TunnelError: Error {
    case invalidFrame, frameTooLarge, authFailed, tunnelOccupied
    case connectTimeout, idleTimeout, connectionClosed
    case invalidAddressType, sendFailed
}
```

---

## Task 1: Xcode Project Skeleton & Entitlements

**Files:**
- Create: `ios-client/BlockProxy.xcodeproj` (Xcode GUI)
- Create: `ios-client/BlockProxy/App/BlockProxyApp.swift`
- Create: `ios-client/BlockProxy/BlockProxy.entitlements`
- Create: `ios-client/TunnelExtension/Info.plist`
- Create: `ios-client/TunnelExtension/TunnelExtension.entitlements`

**Interfaces:**
- Produces: Two buildable targets (main app + Network Extension) that compile and link successfully.

- [ ] **Step 1: Create Xcode project**

Open Xcode → File → New → Project → iOS App → Product Name: `BlockProxy`, Interface: SwiftUI, Language: Swift. Save to `ios-client/`.

- [ ] **Step 2: Add Network Extension target**

File → New → Target → Network Extension → Product Name: `TunnelExtension`, Provider Type: Packet Tunnel.

- [ ] **Step 3: Configure App Group**

In both targets' Signing & Capabilities, add App Group: `group.com.blockproxy`.

- [ ] **Step 4: Configure main app entitlements**

`ios-client/BlockProxy/BlockProxy.entitlements`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.application-groups</key>
    <array><string>group.com.blockproxy</string></array>
    <key>keychain-access-groups</key>
    <array><string>$(AppIdentifierPrefix)com.blockproxy</string></array>
</dict>
</plist>
```

- [ ] **Step 5: Configure extension entitlements**

`ios-client/TunnelExtension/TunnelExtension.entitlements`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.application-groups</key>
    <array><string>group.com.blockproxy</string></array>
    <key>com.apple.developer.networking.networkextension</key>
    <array><string>packet-tunnel-provider</string></array>
    <key>keychain-access-groups</key>
    <array><string>$(AppIdentifierPrefix)com.blockproxy</string></array>
</dict>
</plist>
```

- [ ] **Step 6: Set deployment target**

Both targets: General → Minimum Deployments → iOS 17.0.

- [ ] **Step 6.1: Expose resolved Keychain access group to code**

In both targets' Info.plist, add:

```xml
<key>KeychainAccessGroup</key>
<string>$(AppIdentifierPrefix)com.blockproxy</string>
```

Runtime code reads this resolved value. Do not pass the literal string `"$(AppIdentifierPrefix)com.blockproxy"` to Security.framework.

- [ ] **Step 7: Embed extension**

Main app target → General → Frameworks, Libraries, and Embedded Content → Add `TunnelExtension.appex` → Embed Without Signing.

- [ ] **Step 8: Verify build**

```bash
cd ios-client
xcodebuild -scheme BlockProxy -destination 'generic/platform=iOS' build
```
Expected: BUILD SUCCEEDED for both targets.

- [ ] **Step 9: Commit**

```bash
git add ios-client/
git commit -m "feat(ios): add Xcode project skeleton with Network Extension target"
```

---

## Task 2: Configuration Models & Persistence

**Files:**
- Create: `ios-client/BlockProxy/Models/ServerConfig.swift`
- Create: `ios-client/BlockProxy/Models/TunnelStatus.swift`
- Create: `ios-client/BlockProxy/Utils/ConfigStore.swift`
- Create: `ios-client/BlockProxy/Utils/KeychainHelper.swift`
- Create: `ios-client/BlockProxyTests/ConfigStoreTests.swift`

**Interfaces:**
- Produces: `ServerConfig` (Codable struct with all connection parameters)
- Produces: `TunnelStatus` (enum with display metadata)
- Produces: `ConfigStore.shared.load() -> ServerConfig?` and `ConfigStore.shared.save(_:)`
- Produces: `KeychainHelper.save(username:password:)` and `KeychainHelper.load() -> (String, String)?`
- Consumes: (nothing — foundational layer)

**Security requirement:** `ServerConfig` MUST NOT include password. Store username/password in Keychain only. Extension startup loads `ServerConfig` from App Group UserDefaults and credentials from Keychain, then builds an in-memory runtime configuration.

- [ ] **Step 1: Write failing tests**

`ios-client/BlockProxyTests/ConfigStoreTests.swift`:
```swift
import XCTest
@testable import BlockProxy

final class ConfigStoreTests: XCTestCase {
    let suiteName = "group.com.blockproxy.test"

    override func tearDown() {
        UserDefaults(suiteName: suiteName)?.removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    func testServerConfigRoundTrip() throws {
        let store = ConfigStore(suiteName: suiteName)
        let config = ServerConfig(
            serverHost: "192.168.1.100",
            serverPort: 8003,
            useTLS: true,
            allowInsecure: true,
            tunnelHost: nil,
            tunnelPort: nil
        )
        try store.save(config)
        let loaded = store.load()
        XCTAssertNotNil(loaded)
        XCTAssertEqual(loaded?.serverHost, "192.168.1.100")
        XCTAssertEqual(loaded?.serverPort, 8003)
        XCTAssertEqual(loaded?.useTLS, true)
        XCTAssertEqual(loaded?.allowInsecure, true)
    }

    func testLoadReturnsNilWhenEmpty() {
        let store = ConfigStore(suiteName: suiteName)
        XCTAssertNil(store.load())
    }

    func testTunnelStatusRawValues() {
        XCTAssertEqual(TunnelStatus.disconnected.rawValue, "disconnected")
        XCTAssertEqual(TunnelStatus.connected.rawValue, "connected")
        XCTAssertEqual(TunnelStatus.authFailed.rawValue, "authFailed")
        XCTAssertEqual(TunnelStatus.occupied.rawValue, "occupied")
    }

    func testTunnelStatusDisplayText() {
        XCTAssertEqual(TunnelStatus.disconnected.displayText, "已断开")
        XCTAssertEqual(TunnelStatus.connecting.displayText, "正在连接...")
        XCTAssertEqual(TunnelStatus.connected.displayText, "已连接")
        XCTAssertEqual(TunnelStatus.reconnecting.displayText, "重连中")
        XCTAssertEqual(TunnelStatus.occupied.displayText, "端口被占用")
        XCTAssertEqual(TunnelStatus.authFailed.displayText, "认证失败")
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

```bash
cd ios-client && xcodebuild test -scheme BlockProxy -destination 'platform=iOS Simulator,name=iPhone 16'
```
Expected: FAIL — `ServerConfig`, `TunnelStatus`, `ConfigStore` not defined.

- [ ] **Step 3: Implement TunnelStatus**

`ios-client/BlockProxy/Models/TunnelStatus.swift`:
```swift
import Foundation

enum TunnelStatus: String, Codable {
    case disconnected
    case connecting
    case connected
    case reconnecting
    case occupied
    case authFailed

    var displayText: String {
        switch self {
        case .disconnected:  return "已断开"
        case .connecting:    return "正在连接..."
        case .connected:     return "已连接"
        case .reconnecting:  return "重连中"
        case .occupied:      return "端口被占用"
        case .authFailed:    return "认证失败"
        }
    }

    var colorName: String {
        switch self {
        case .disconnected:  return "gray"
        case .connecting:    return "yellow"
        case .connected:     return "green"
        case .reconnecting:  return "orange"
        case .occupied:      return "red"
        case .authFailed:    return "red"
        }
    }
}
```

- [ ] **Step 4: Implement ServerConfig**

`ios-client/BlockProxy/Models/ServerConfig.swift`:
```swift
import Foundation

struct ServerConfig: Codable, Equatable {
    var serverHost: String
    var serverPort: UInt16
    var useTLS: Bool
    var allowInsecure: Bool
    var tunnelHost: String?
    var tunnelPort: UInt16?

    var effectiveHost: String { tunnelHost ?? serverHost }
    var effectivePort: UInt16 { tunnelPort ?? serverPort }
}

struct TunnelCredentials: Equatable {
    var username: String
    var password: String
}
```

- [ ] **Step 5: Implement ConfigStore**

`ios-client/BlockProxy/Utils/ConfigStore.swift`:
```swift
import Foundation

class ConfigStore {
    static let shared = ConfigStore(suiteName: "group.com.blockproxy")

    private let defaults: UserDefaults
    private let key = "server_config"

    init(suiteName: String) {
        self.defaults = UserDefaults(suiteName: suiteName)!
    }

    func save(_ config: ServerConfig) throws {
        let data = try JSONEncoder().encode(config)
        defaults.set(data, forKey: key)
    }

    func load() -> ServerConfig? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(ServerConfig.self, from: data)
    }

    func saveStatus(_ status: TunnelStatus) {
        defaults.set(status.rawValue, forKey: "tunnel_status")
        defaults.set(Date().timeIntervalSince1970, forKey: "tunnel_status_timestamp")
    }

    func loadStatus() -> TunnelStatus {
        guard let raw = defaults.string(forKey: "tunnel_status") else {
            return .disconnected
        }
        return TunnelStatus(rawValue: raw) ?? .disconnected
    }
}
```

- [ ] **Step 6: Implement KeychainHelper**

`ios-client/BlockProxy/Utils/KeychainHelper.swift`:
```swift
import Foundation
import Security

class KeychainHelper {
    private let service = "com.blockproxy.credentials"
    private let accessGroup = Bundle.main.object(forInfoDictionaryKey: "KeychainAccessGroup") as? String

    func save(username: String, password: String) throws {
        let passwordData = password.data(using: .utf8)!
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: username,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        SecItemDelete(query as CFDictionary)
        var addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: username,
            kSecValueData as String: passwordData,
        ]
        if let accessGroup { addQuery[kSecAttrAccessGroup as String] = accessGroup }
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(domain: "KeychainHelper", code: Int(status))
        }
    }

    func load() -> (username: String, password: String)? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let dict = result as? [String: Any],
              let username = dict[kSecAttrAccount as String] as? String,
              let passwordData = dict[kSecValueData as String] as? Data,
              let password = String(data: passwordData, encoding: .utf8)
        else { return nil }
        return (username, password)
    }
}
```

- [ ] **Step 7: Run tests to verify pass**

```bash
cd ios-client && xcodebuild test -scheme BlockProxy -destination 'platform=iOS Simulator,name=iPhone 16'
```
Expected: All ConfigStoreTests PASS.

- [ ] **Step 8: Commit**

```bash
git add ios-client/BlockProxy/Models/ ios-client/BlockProxy/Utils/ ios-client/BlockProxyTests/
git commit -m "feat(ios): add ServerConfig, TunnelStatus, ConfigStore, KeychainHelper"
```

---

## Task 3: VPNManager

**Files:**
- Create: `ios-client/BlockProxy/Services/VPNManager.swift`
- Create: `ios-client/BlockProxyTests/VPNManagerTests.swift`

**Interfaces:**
- Consumes: `ServerConfig`, `ConfigStore.shared` (Task 2)
- Produces: `VPNManager.setupVPN()`, `startVPN(config:)`, `stopVPN()`, `loadBlockProxyManager()`

- [ ] **Step 1: Write failing tests**

`ios-client/BlockProxyTests/VPNManagerTests.swift`:
```swift
import XCTest
@testable import BlockProxy

final class VPNManagerTests: XCTestCase {
    func testProviderBundleIdentifier() {
        let expected = "com.blockproxy.tunnel-extension"
        XCTAssertEqual(VPNManager.providerBundleId, expected)
    }

    func testManagerMatchByBundleId() {
        // Verify filter logic: given a list of descriptions, find BlockProxy's
        let descriptions = ["SomeVPN", "BlockProxy", "OtherVPN"]
        let found = descriptions.firstIndex(of: VPNManager.managerDescription)
        XCTAssertEqual(found, 1)
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

Expected: FAIL — `VPNManager` not defined.

- [ ] **Step 3: Implement VPNManager**

`ios-client/BlockProxy/Services/VPNManager.swift`:
```swift
import Foundation
import NetworkExtension

@MainActor
class VPNManager: ObservableObject {
    static let providerBundleId = "com.blockproxy.tunnel-extension"
    static let managerDescription = "BlockProxy"

    @Published var isSetup = false

    private var manager: NETunnelProviderManager?

    func setupVPN() async throws {
        let existing = try await loadBlockProxyManager()
        if let existing {
            self.manager = existing
            self.isSetup = true
            return
        }
        let proto = NETunnelProviderProtocol()
        proto.providerBundleIdentifier = Self.providerBundleId
        proto.serverAddress = "BlockProxy Tunnel"

        let mgr = NETunnelProviderManager()
        mgr.protocolConfiguration = proto
        mgr.localizedDescription = Self.managerDescription
        mgr.isEnabled = true
        try await mgr.saveToPreferences()
        try await mgr.loadFromPreferences()
        self.manager = mgr
        self.isSetup = true
    }

    func startVPN(config: ServerConfig) async throws {
        try ConfigStore.shared.save(config)
        let mgr = try await ensureManager()
        try mgr.connection.startVPNTunnel()
    }

    func stopVPN() async throws {
        let mgr = try await ensureManager()
        mgr.connection.stopVPNTunnel()
    }

    func loadBlockProxyManager() async throws -> NETunnelProviderManager? {
        let managers = try await NETunnelProviderManager.loadAllFromPreferences()
        return managers.first { mgr in
            let proto = mgr.protocolConfiguration as? NETunnelProviderProtocol
            return proto?.providerBundleIdentifier == Self.providerBundleId
                || mgr.localizedDescription == Self.managerDescription
        }
    }

    private func ensureManager() async throws -> NETunnelProviderManager {
        if let manager { return manager }
        if let found = try await loadBlockProxyManager() {
            self.manager = found
            return found
        }
        try await setupVPN()
        guard let manager else {
            throw NSError(domain: "VPNManager", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "Failed to create VPN manager"])
        }
        return manager
    }
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd ios-client && xcodebuild test -scheme BlockProxy -destination 'platform=iOS Simulator,name=iPhone 16'
```
Expected: All VPNManagerTests PASS.

- [ ] **Step 5: Commit**

```bash
git add ios-client/BlockProxy/Services/ ios-client/BlockProxyTests/VPNManagerTests.swift
git commit -m "feat(ios): add VPNManager with setup/start/stop and bundleId matching"
```

---

## Task 4: FrameCodec — Single Frame Encode/Decode

**Files:**
- Create: `ios-client/TunnelExtension/FrameCodec.swift`
- Create: `ios-client/BlockProxyTests/FrameCodecTests.swift`

**Interfaces:**
- Consumes: `FrameType`, `AddressType`, `TunnelError` (Global Constraints)
- Produces: `FrameCodec.encode(_:) -> Data`, `FrameCodec.decode(from:) -> Frame`
- Produces: `Frame` enum with all associated values

**Validation requirements:**
- `encodeChecked(_:)` validates every length-limited field, not only DATA: username/password/domain/error message must be <= 255 UTF-8 bytes; payload must be <= 65535 bytes.
- `encode(_:)` may be a convenience wrapper only for known-safe frames; production send paths should call `encodeChecked(_:)` and surface/drop invalid frames explicitly.
- IPv4 encode must require exactly 4 octets, each 0...255. Invalid IP strings throw instead of silently producing a malformed CONNECT frame.
- Decode must reject frames with trailing garbage inside fixed-size payloads (`PING` length other than 1, `CLOSE` length other than 3, etc.) unless compatibility testing proves the server sends such frames.

- [ ] **Step 1: Write failing tests with Python cross-validation vectors**

`ios-client/BlockProxyTests/FrameCodecTests.swift`:
```swift
import XCTest
@testable import BlockProxy

final class FrameCodecTests: XCTestCase {

    // MARK: - Encode tests with Python cross-validation

    func testEncodePing() {
        let data = FrameCodec.encode(.ping)
        // Python: encode_frame(0x10) → b'\x00\x01\x10'
        XCTAssertEqual(data, Data([0x00, 0x01, 0x10]))
    }

    func testEncodePong() {
        let data = FrameCodec.encode(.pong)
        XCTAssertEqual(data, Data([0x00, 0x01, 0x11]))
    }

    func testEncodeAuth() {
        let data = FrameCodec.encode(.auth(username: "admin", password: "pass"))
        // Python: encode_frame(0x20, username=b'admin', password=b'pass')
        // → b'\x00\x0b\x20\x05admin\x04pass'
        XCTAssertEqual(data, Data([
            0x00, 0x0B, 0x20,
            0x05, 0x61, 0x64, 0x6D, 0x69, 0x6E,
            0x04, 0x70, 0x61, 0x73, 0x73
        ]))
    }

    func testEncodeConnectOK() {
        let data = FrameCodec.encode(.connectOK(reqid: 1))
        // payload: [0x04, 0x00, 0x01] → length 3
        XCTAssertEqual(data, Data([0x00, 0x03, 0x04, 0x00, 0x01]))
    }

    func testEncodeConnectFailed() {
        let data = FrameCodec.encode(.connectFailed(reqid: 0x7FFF))
        XCTAssertEqual(data, Data([0x00, 0x03, 0x81, 0x7F, 0xFF]))
    }

    func testEncodeClose() {
        let data = FrameCodec.encode(.close(reqid: 256))
        XCTAssertEqual(data, Data([0x00, 0x03, 0x03, 0x01, 0x00]))
    }

    func testEncodeData() {
        let payload = Data([0x41, 0x42]) // "AB"
        let data = FrameCodec.encode(.data(reqid: 1, payload: payload))
        // payload: [0x02, 0x00, 0x01, 0x41, 0x42] → length 5
        XCTAssertEqual(data, Data([0x00, 0x05, 0x02, 0x00, 0x01, 0x41, 0x42]))
    }

    func testEncodeConnectDomain() {
        let data = FrameCodec.encode(.connect(reqid: 1, addr: .domain("example.com"), port: 8080))
        // [type=01][reqid=00 01][atyp=03][len=0B][example.com][port=1F 90]
        // payload length = 1+2+1+1+11+2 = 18
        var expected = Data([0x00, 0x12, 0x01, 0x00, 0x01, 0x03, 0x0B])
        expected.append(contentsOf: "example.com".utf8)
        expected.append(contentsOf: [0x1F, 0x90])
        XCTAssertEqual(data, expected)
    }

    func testEncodeConnectIPv4() {
        let data = FrameCodec.encode(.connect(
            reqid: 2, addr: .ipv4("192.168.1.1"), port: 443))
        // [01][00 02][01][C0 A8 01 01][01 BB]
        // payload length = 1+2+1+4+2 = 10
        XCTAssertEqual(data, Data([
            0x00, 0x0A, 0x01, 0x00, 0x02, 0x01,
            0xC0, 0xA8, 0x01, 0x01,
            0x01, 0xBB
        ]))
    }

    func testEncodeError() {
        let data = FrameCodec.encode(.error(message: "fail"))
        // [23][04][fail] → length 6
        var expected = Data([0x00, 0x06, 0x23, 0x04])
        expected.append(contentsOf: "fail".utf8)
        XCTAssertEqual(data, expected)
    }

    func testEncodeMaxDataChunk() {
        let payload = Data(repeating: 0xAA, count: 65532)
        let data = FrameCodec.encode(.data(reqid: 1, payload: payload))
        // length prefix = 65535 (0xFFFF)
        XCTAssertEqual(data.count, 2 + 65535)
        XCTAssertEqual(data[0], 0xFF)
        XCTAssertEqual(data[1], 0xFF)
    }

    func testEncodeDataExceedingMaxThrows() {
        let payload = Data(repeating: 0xAA, count: 65533)
        XCTAssertThrowsError(try FrameCodec.encodeChecked(.data(reqid: 1, payload: payload)))
    }

    func testEncodeRejectsTooLongAuthFields() {
        let username = String(repeating: "a", count: 256)
        XCTAssertThrowsError(try FrameCodec.encodeChecked(.auth(username: username, password: "p")))
    }

    func testEncodeRejectsInvalidIPv4() {
        XCTAssertThrowsError(try FrameCodec.encodeChecked(.connect(
            reqid: 1, addr: .ipv4("192.168.1"), port: 80)))
        XCTAssertThrowsError(try FrameCodec.encodeChecked(.connect(
            reqid: 1, addr: .ipv4("192.168.1.999"), port: 80)))
    }

    // MARK: - Decode tests

    func testDecodePing() throws {
        let frame = try FrameCodec.decode(from: Data([0x00, 0x01, 0x10]))
        if case .ping = frame {} else { XCTFail("Expected ping") }
    }

    func testDecodeAuth() throws {
        let data = Data([0x00, 0x0B, 0x20,
                         0x05, 0x61, 0x64, 0x6D, 0x69, 0x6E,
                         0x04, 0x70, 0x61, 0x73, 0x73])
        let frame = try FrameCodec.decode(from: data)
        if case .auth(let u, let p) = frame {
            XCTAssertEqual(u, "admin")
            XCTAssertEqual(p, "pass")
        } else { XCTFail("Expected auth") }
    }

    func testDecodeConnectDomain() throws {
        var data = Data([0x00, 0x12, 0x01, 0x00, 0x01, 0x03, 0x0B])
        data.append(contentsOf: "example.com".utf8)
        data.append(contentsOf: [0x1F, 0x90])
        let frame = try FrameCodec.decode(from: data)
        if case .connect(let reqid, let addr, let port) = frame {
            XCTAssertEqual(reqid, 1)
            XCTAssertEqual(port, 8080)
            if case .domain(let host) = addr {
                XCTAssertEqual(host, "example.com")
            } else { XCTFail("Expected domain address") }
        } else { XCTFail("Expected connect") }
    }

    func testDecodeConnectIPv4() throws {
        let data = Data([0x00, 0x0A, 0x01, 0x00, 0x02, 0x01,
                         0xC0, 0xA8, 0x01, 0x01, 0x01, 0xBB])
        let frame = try FrameCodec.decode(from: data)
        if case .connect(let reqid, let addr, let port) = frame {
            XCTAssertEqual(reqid, 2)
            XCTAssertEqual(port, 443)
            if case .ipv4(let ip) = addr {
                XCTAssertEqual(ip, "192.168.1.1")
            } else { XCTFail("Expected IPv4") }
        } else { XCTFail("Expected connect") }
    }

    func testDecodeData() throws {
        let data = Data([0x00, 0x05, 0x02, 0x00, 0x01, 0x41, 0x42])
        let frame = try FrameCodec.decode(from: data)
        if case .data(let reqid, let payload) = frame {
            XCTAssertEqual(reqid, 1)
            XCTAssertEqual(payload, Data([0x41, 0x42]))
        } else { XCTFail("Expected data") }
    }

    func testDecodeEmptyData() throws {
        let data = Data([0x00, 0x03, 0x02, 0x00, 0x01])
        let frame = try FrameCodec.decode(from: data)
        if case .data(let reqid, let payload) = frame {
            XCTAssertEqual(reqid, 1)
            XCTAssertEqual(payload, Data())
        } else { XCTFail("Expected data") }
    }

    func testDecodeClose() throws {
        let data = Data([0x00, 0x03, 0x03, 0x01, 0x00])
        let frame = try FrameCodec.decode(from: data)
        if case .close(let reqid) = frame {
            XCTAssertEqual(reqid, 256)
        } else { XCTFail("Expected close") }
    }

    func testDecodeError() throws {
        var data = Data([0x00, 0x06, 0x23, 0x04])
        data.append(contentsOf: "fail".utf8)
        let frame = try FrameCodec.decode(from: data)
        if case .error(let msg) = frame {
            XCTAssertEqual(msg, "fail")
        } else { XCTFail("Expected error") }
    }

    func testDecodeUnknownTypeThrows() {
        let data = Data([0x00, 0x01, 0xFF])
        XCTAssertThrowsError(try FrameCodec.decode(from: data))
    }

    // MARK: - Roundtrip

    func testRoundtripAllTypes() throws {
        let frames: [Frame] = [
            .ping, .pong, .authOK, .authFail,
            .auth(username: "user", password: "pw"),
            .connect(reqid: 42, addr: .domain("test.local"), port: 80),
            .connect(reqid: 43, addr: .ipv4("10.0.0.1"), port: 443),
            .data(reqid: 1, payload: Data(repeating: 0xBB, count: 1000)),
            .close(reqid: 99),
            .connectOK(reqid: 99),
            .connectFailed(reqid: 99),
            .error(message: "test error"),
        ]
        for original in frames {
            let encoded = FrameCodec.encode(original)
            let decoded = try FrameCodec.decode(from: encoded)
            XCTAssertEqual(original, decoded, "Roundtrip failed for \(original)")
        }
    }

    func testMaxUsernameLength() throws {
        let username = String(repeating: "a", count: 255)
        let password = String(repeating: "b", count: 255)
        let encoded = FrameCodec.encode(.auth(username: username, password: password))
        let decoded = try FrameCodec.decode(from: encoded)
        if case .auth(let u, let p) = decoded {
            XCTAssertEqual(u.count, 255)
            XCTAssertEqual(p.count, 255)
        } else { XCTFail("Expected auth") }
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

Expected: FAIL — `FrameCodec`, `Frame` not defined.

- [ ] **Step 3: Implement Frame enum and FrameCodec**

`ios-client/TunnelExtension/FrameCodec.swift`:
```swift
import Foundation

enum Frame: Equatable {
    case connect(reqid: UInt16, addr: FrameAddress, port: UInt16)
    case data(reqid: UInt16, payload: Data)
    case close(reqid: UInt16)
    case connectOK(reqid: UInt16)
    case connectFailed(reqid: UInt16)
    case ping
    case pong
    case auth(username: String, password: String)
    case authOK
    case authFail
    case error(message: String)
}

enum FrameAddress: Equatable {
    case ipv4(String)
    case domain(String)
    case ipv6(String)

    var displayString: String {
        switch self {
        case .ipv4(let ip):    return ip
        case .domain(let host): return host
        case .ipv6(let ip):    return ip
        }
    }
}

enum FrameCodec {
    static let maxPayloadSize = 65535
    static let dataHeaderLen = 3  // type(1) + reqid(2)
    static let maxDataChunk = maxPayloadSize - dataHeaderLen  // 65532

    // MARK: - Encode

    static func encode(_ frame: Frame) -> Data {
        // Convenience wrapper for tests and known-safe frames.
        // Production send paths call encodeChecked(_:) and handle errors.
        let payload = try! encodePayloadChecked(frame)
        var result = Data(capacity: 2 + payload.count)
        let length = UInt16(payload.count)
        result.append(UInt8(length >> 8))
        result.append(UInt8(length & 0xFF))
        result.append(payload)
        return result
    }

    /// Encode with size validation — throws if DATA payload exceeds maxDataChunk.
    static func encodeChecked(_ frame: Frame) throws -> Data {
        let payload = try encodePayloadChecked(frame)
        guard payload.count <= maxPayloadSize else {
            throw TunnelError.frameTooLarge
        }
        var result = Data(capacity: 2 + payload.count)
        let length = UInt16(payload.count)
        result.append(UInt8(length >> 8))
        result.append(UInt8(length & 0xFF))
        result.append(payload)
        return result
    }

    private static func encodePayloadChecked(_ frame: Frame) throws -> Data {
        switch frame {
        case .connect(let reqid, let addr, let port):
            var d = Data([FrameType.connect.rawValue])
            d.append(UInt8(reqid >> 8)); d.append(UInt8(reqid & 0xFF))
            switch addr {
            case .ipv4(let ip):
                d.append(AddressType.ipv4.rawValue)
                let parts = ip.split(separator: ".").compactMap { UInt8($0) }
                guard parts.count == 4 else { throw TunnelError.invalidAddressType }
                d.append(contentsOf: parts)
            case .domain(let host):
                d.append(AddressType.domain.rawValue)
                let hostBytes = Array(host.utf8)
                guard hostBytes.count <= 255 else { throw TunnelError.frameTooLarge }
                d.append(UInt8(hostBytes.count))
                d.append(contentsOf: hostBytes)
            case .ipv6(let ip):
                d.append(AddressType.ipv6.rawValue)
                d.append(contentsOf: ipv6ToBytes(ip))
            }
            d.append(UInt8(port >> 8)); d.append(UInt8(port & 0xFF))
            return d

        case .data(let reqid, let payload):
            guard payload.count <= maxDataChunk else { throw TunnelError.frameTooLarge }
            var d = Data(capacity: 3 + payload.count)
            d.append(FrameType.data.rawValue)
            d.append(UInt8(reqid >> 8)); d.append(UInt8(reqid & 0xFF))
            d.append(payload)
            return d

        case .close(let reqid):
            return Data([FrameType.close.rawValue,
                         UInt8(reqid >> 8), UInt8(reqid & 0xFF)])

        case .connectOK(let reqid):
            return Data([FrameType.connectOK.rawValue,
                         UInt8(reqid >> 8), UInt8(reqid & 0xFF)])

        case .connectFailed(let reqid):
            return Data([FrameType.connectFailed.rawValue,
                         UInt8(reqid >> 8), UInt8(reqid & 0xFF)])

        case .ping:
            return Data([FrameType.ping.rawValue])

        case .pong:
            return Data([FrameType.pong.rawValue])

        case .auth(let username, let password):
            let uBytes = Array(username.utf8)
            let pBytes = Array(password.utf8)
            guard uBytes.count <= 255, pBytes.count <= 255 else {
                throw TunnelError.frameTooLarge
            }
            var d = Data(capacity: 1 + 1 + uBytes.count + 1 + pBytes.count)
            d.append(FrameType.auth.rawValue)
            d.append(UInt8(uBytes.count))
            d.append(contentsOf: uBytes)
            d.append(UInt8(pBytes.count))
            d.append(contentsOf: pBytes)
            return d

        case .authOK:
            return Data([FrameType.authOK.rawValue])

        case .authFail:
            return Data([FrameType.authFail.rawValue])

        case .error(let message):
            let mBytes = Array(message.utf8)
            guard mBytes.count <= 255 else { throw TunnelError.frameTooLarge }
            var d = Data(capacity: 2 + mBytes.count)
            d.append(FrameType.error.rawValue)
            d.append(UInt8(mBytes.count))
            d.append(contentsOf: mBytes)
            return d
        }
    }

    // MARK: - Decode

    /// Decode a frame from a buffer that includes the 2-byte length prefix.
    static func decode(from data: Data) throws -> Frame {
        guard data.count >= 2 else { throw TunnelError.invalidFrame }
        let length = Int(data[0]) << 8 | Int(data[1])
        guard data.count >= 2 + length else { throw TunnelError.invalidFrame }
        guard length <= maxPayloadSize else { throw TunnelError.frameTooLarge }
        let payload = data.subdata(in: 2..<(2 + length))
        return try decodePayload(payload)
    }

    static func decodePayload(_ payload: Data) throws -> Frame {
        guard !payload.isEmpty else { throw TunnelError.invalidFrame }
        guard let type = FrameType(rawValue: payload[0]) else {
            throw TunnelError.invalidFrame
        }
        switch type {
        case .ping:     return .ping
        case .pong:     return .pong
        case .authOK:   return .authOK
        case .authFail: return .authFail

        case .auth:
            guard payload.count >= 2 else { throw TunnelError.invalidFrame }
            let uLen = Int(payload[1])
            guard payload.count >= 2 + uLen + 1 else { throw TunnelError.invalidFrame }
            let username = String(data: payload.subdata(in: 2..<(2 + uLen)), encoding: .utf8) ?? ""
            let pLen = Int(payload[2 + uLen])
            let pStart = 3 + uLen
            guard payload.count >= pStart + pLen else { throw TunnelError.invalidFrame }
            let password = String(data: payload.subdata(in: pStart..<(pStart + pLen)), encoding: .utf8) ?? ""
            return .auth(username: username, password: password)

        case .connect:
            guard payload.count >= 4 else { throw TunnelError.invalidFrame }
            let reqid = UInt16(payload[1]) << 8 | UInt16(payload[2])
            guard let atyp = AddressType(rawValue: payload[3]) else {
                throw TunnelError.invalidAddressType
            }
            let (addr, port) = try decodeAddress(payload: payload, atyp: atyp, offset: 4)
            return .connect(reqid: reqid, addr: addr, port: port)

        case .data:
            guard payload.count >= 3 else { throw TunnelError.invalidFrame }
            let reqid = UInt16(payload[1]) << 8 | UInt16(payload[2])
            let data = payload.subdata(in: 3..<payload.count)
            return .data(reqid: reqid, payload: data)

        case .close:
            guard payload.count >= 3 else { throw TunnelError.invalidFrame }
            let reqid = UInt16(payload[1]) << 8 | UInt16(payload[2])
            return .close(reqid: reqid)

        case .connectOK:
            guard payload.count >= 3 else { throw TunnelError.invalidFrame }
            let reqid = UInt16(payload[1]) << 8 | UInt16(payload[2])
            return .connectOK(reqid: reqid)

        case .connectFailed:
            guard payload.count >= 3 else { throw TunnelError.invalidFrame }
            let reqid = UInt16(payload[1]) << 8 | UInt16(payload[2])
            return .connectFailed(reqid: reqid)

        case .error:
            guard payload.count >= 2 else { throw TunnelError.invalidFrame }
            let msgLen = Int(payload[1])
            guard payload.count >= 2 + msgLen else { throw TunnelError.invalidFrame }
            let msg = String(data: payload.subdata(in: 2..<(2 + msgLen)), encoding: .utf8) ?? ""
            return .error(message: msg)
        }
    }

    private static func decodeAddress(payload: Data, atyp: AddressType, offset: Int)
        throws -> (FrameAddress, UInt16)
    {
        switch atyp {
        case .ipv4:
            let end = offset + 4
            guard payload.count >= end + 2 else { throw TunnelError.invalidFrame }
            let ip = "\(payload[offset]).\(payload[offset+1]).\(payload[offset+2]).\(payload[offset+3])"
            let port = UInt16(payload[end]) << 8 | UInt16(payload[end+1])
            return (.ipv4(ip), port)
        case .domain:
            guard payload.count > offset else { throw TunnelError.invalidFrame }
            let len = Int(payload[offset])
            let end = offset + 1 + len
            guard payload.count >= end + 2 else { throw TunnelError.invalidFrame }
            let host = String(data: payload.subdata(in: (offset+1)..<end), encoding: .utf8) ?? ""
            let port = UInt16(payload[end]) << 8 | UInt16(payload[end+1])
            return (.domain(host), port)
        case .ipv6:
            let end = offset + 16
            guard payload.count >= end + 2 else { throw TunnelError.invalidFrame }
            // Format as standard IPv6 string
            var parts: [String] = []
            for i in stride(from: offset, to: end, by: 2) {
                parts.append(String(format: "%02x%02x", payload[i], payload[i+1]))
            }
            let ip = parts.joined(separator: ":")
            let port = UInt16(payload[end]) << 8 | UInt16(payload[end+1])
            return (.ipv6(ip), port)
        }
    }

    private static func ipv6ToBytes(_ ip: String) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: 16)
        let parts = ip.split(separator: ":")
        for (i, part) in parts.enumerated() where i < 8 {
            if let val = UInt16(part, radix: 16) {
                bytes[i * 2] = UInt8(val >> 8)
                bytes[i * 2 + 1] = UInt8(val & 0xFF)
            }
        }
        return bytes
    }
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd ios-client && xcodebuild test -scheme BlockProxy -destination 'platform=iOS Simulator,name=iPhone 16'
```
Expected: All FrameCodecTests PASS.

- [ ] **Step 5: Commit**

```bash
git add ios-client/TunnelExtension/FrameCodec.swift ios-client/BlockProxyTests/FrameCodecTests.swift
git commit -m "feat(ios): implement FrameCodec with encode/decode and Python cross-validation tests"
```

---

## Task 5: FrameCodec — TCP Stream Extractor

**Files:**
- Create: `ios-client/TunnelExtension/FrameExtractor.swift`
- Create: `ios-client/BlockProxyTests/FrameExtractorTests.swift`

**Interfaces:**
- Consumes: `FrameCodec.decodePayload(_:)` (Task 4)
- Produces: `FrameExtractor` class with `append(_:)` and `extractFrame() -> Frame?`

- [ ] **Step 1: Write failing tests**

`ios-client/BlockProxyTests/FrameExtractorTests.swift`:
```swift
import XCTest
@testable import BlockProxy

final class FrameExtractorTests: XCTestCase {

    func testSingleCompleteFrame() throws {
        let ext = FrameExtractor()
        let frame = FrameCodec.encode(.ping)
        ext.append(frame)
        let result = try ext.extractFrame()
        XCTAssertNotNil(result)
        if case .ping = result! {} else { XCTFail("Expected ping") }
    }

    func testHalfLengthPrefix() throws {
        let ext = FrameExtractor()
        let frame = FrameCodec.encode(.ping) // [0x00, 0x01, 0x10]
        ext.append(Data([frame[0]]))          // only first byte of length
        XCTAssertNil(try ext.extractFrame())  // not enough for length
        ext.append(Data([frame[1], frame[2]]))
        let result = try ext.extractFrame()
        XCTAssertNotNil(result)
    }

    func testHalfPayload() throws {
        let ext = FrameExtractor()
        // AUTH frame: [00 0B 20 05 61 64 6D 69 6E 04 70 61 73 73]
        let frame = FrameCodec.encode(.auth(username: "admin", password: "pass"))
        // Feed length prefix + half of payload
        ext.append(frame.prefix(6))
        XCTAssertNil(try ext.extractFrame())
        // Feed remaining bytes
        ext.append(frame.suffix(from: 6))
        let result = try ext.extractFrame()
        XCTAssertNotNil(result)
        if case .auth(let u, let p) = result! {
            XCTAssertEqual(u, "admin")
            XCTAssertEqual(p, "pass")
        } else { XCTFail("Expected auth") }
    }

    func testMultipleFramesInOneReceive() throws {
        let ext = FrameExtractor()
        var combined = Data()
        combined.append(FrameCodec.encode(.ping))
        combined.append(FrameCodec.encode(.pong))
        combined.append(FrameCodec.encode(.authOK))
        ext.append(combined)
        let f1 = try ext.extractFrame()
        let f2 = try ext.extractFrame()
        let f3 = try ext.extractFrame()
        let f4 = try ext.extractFrame()
        if case .ping = f1! {} else { XCTFail("Expected ping") }
        if case .pong = f2! {} else { XCTFail("Expected pong") }
        if case .authOK = f3! {} else { XCTFail("Expected authOK") }
        XCTAssertNil(f4)
    }

    func testFrameTailPlusNextFramePrefix() throws {
        let ext = FrameExtractor()
        let ping = FrameCodec.encode(.ping)       // [00 01 10]
        let auth = FrameCodec.encode(.auth(username: "a", password: "b"))
        // Feed: ping + first 3 bytes of auth
        var chunk = Data(ping)
        chunk.append(auth.prefix(3))
        ext.append(chunk)
        let f1 = try ext.extractFrame()
        if case .ping = f1! {} else { XCTFail("Expected ping") }
        // Not enough for auth yet
        XCTAssertNil(try ext.extractFrame())
        // Feed remaining auth bytes
        ext.append(auth.suffix(from: 3))
        let f2 = try ext.extractFrame()
        if case .auth(let u, let p) = f2! {
            XCTAssertEqual(u, "a")
            XCTAssertEqual(p, "b")
        } else { XCTFail("Expected auth") }
    }

    func testOversizedLengthThrows() {
        let ext = FrameExtractor()
        // Length = 0xFFFF + 1 won't fit in UInt16, so test with length > maxPayloadSize
        // Actually 0xFFFF = 65535 = maxPayloadSize, which is valid.
        // Test with a frame that claims 65535 bytes but only sends a few.
        ext.append(Data([0xFF, 0xFF, 0x10])) // claims 65535-byte payload, only has 1
        XCTAssertNil(try ext.extractFrame()) // waiting for more data, not an error yet
    }

    func testInvalidPayloadTypeThrows() {
        let ext = FrameExtractor()
        ext.append(Data([0x00, 0x01, 0xFF])) // unknown type 0xFF
        XCTAssertThrowsError(try ext.extractFrame())
    }

    func testEmptyDataDoesNotCrash() throws {
        let ext = FrameExtractor()
        ext.append(Data())
        XCTAssertNil(try ext.extractFrame())
    }

    func testExtractAllFrames() throws {
        let ext = FrameExtractor()
        ext.append(FrameCodec.encode(.ping))
        ext.append(FrameCodec.encode(.pong))
        let frames = try ext.extractAll()
        XCTAssertEqual(frames.count, 2)
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

Expected: FAIL — `FrameExtractor` not defined.

- [ ] **Step 3: Implement FrameExtractor**

`ios-client/TunnelExtension/FrameExtractor.swift`:
```swift
import Foundation

/// Per-connection receive buffer that reassembles TCP byte stream into tunnel frames.
/// Each NWConnection should own one FrameExtractor instance.
class FrameExtractor {
    private var buffer = Data()

    /// Append raw bytes received from NWConnection.receive().
    func append(_ data: Data) {
        buffer.append(data)
    }

    /// Try to extract one complete frame from the buffer.
    /// Returns nil if not enough data for a complete frame.
    /// Throws TunnelError if the frame payload is invalid.
    func extractFrame() throws -> Frame? {
        guard buffer.count >= 2 else { return nil }
        let length = Int(buffer[0]) << 8 | Int(buffer[1])
        guard length <= FrameCodec.maxPayloadSize else {
            throw TunnelError.frameTooLarge
        }
        let totalLen = 2 + length
        guard buffer.count >= totalLen else { return nil }
        let payload = buffer.subdata(in: 2..<totalLen)
        buffer.removeSubrange(0..<totalLen)
        return try FrameCodec.decodePayload(payload)
    }

    /// Extract all available frames from the buffer.
    func extractAll() throws -> [Frame] {
        var frames: [Frame] = []
        while let frame = try extractFrame() {
            frames.append(frame)
        }
        return frames
    }

    var bufferedBytes: Int { buffer.count }
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd ios-client && xcodebuild test -scheme BlockProxy -destination 'platform=iOS Simulator,name=iPhone 16'
```
Expected: All FrameExtractorTests PASS.

- [ ] **Step 5: Commit**

```bash
git add ios-client/TunnelExtension/FrameExtractor.swift ios-client/BlockProxyTests/FrameExtractorTests.swift
git commit -m "feat(ios): implement FrameExtractor for TCP stream reassembly"
```

---

## Task 6: NWConnection Async Wrapper & SendQueue

**Files:**
- Create: `ios-client/TunnelExtension/NWConnectionAsync.swift`
- Create: `ios-client/TunnelExtension/SendQueue.swift`
- Create: `ios-client/BlockProxyTests/SendQueueTests.swift`

**Interfaces:**
- Consumes: `FrameCodec.encode(_:)` (Task 4)
- Produces: `NWConnection.receiveAsync() async throws -> Data`
- Produces: `NWConnection.sendAsync(_:) async throws`
- Produces: `NWConnection.connectAsync(timeout:) async throws`
- Produces: `SendQueue` actor with `enqueue(_:)`

- [ ] **Step 1: Write failing tests for SendQueue**

`ios-client/BlockProxyTests/SendQueueTests.swift`:
```swift
import XCTest
import Network
@testable import BlockProxy

final class SendQueueTests: XCTestCase {

    func testEnqueueOrderPreserved() async throws {
        // Use a mock that records send order
        var sentFrames: [Data] = []
        let queue = SendQueue { data in
            sentFrames.append(data)
        }
        let f1 = FrameCodec.encode(.ping)
        let f2 = FrameCodec.encode(.pong)
        let f3 = FrameCodec.encode(.authOK)
        await queue.enqueue(f1)
        await queue.enqueue(f2)
        await queue.enqueue(f3)
        // Wait for all to be processed
        try await Task.sleep(nanoseconds: 100_000_000) // 100ms
        XCTAssertEqual(sentFrames.count, 3)
        XCTAssertEqual(sentFrames[0], f1)
        XCTAssertEqual(sentFrames[1], f2)
        XCTAssertEqual(sentFrames[2], f3)
    }

    func testConcurrentEnqueueSerialized() async throws {
        var sendCount = 0
        var maxConcurrent = 0
        var currentConcurrent = 0
        let lock = NSLock()
        let queue = SendQueue { _ in
            lock.lock()
            currentConcurrent += 1
            maxConcurrent = max(maxConcurrent, currentConcurrent)
            lock.unlock()
            try? await Task.sleep(nanoseconds: 10_000_000) // 10ms simulated send
            lock.lock()
            currentConcurrent -= 1
            sendCount += 1
            lock.unlock()
        }
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<20 {
                group.addTask {
                    await queue.enqueue(FrameCodec.encode(.ping))
                }
            }
        }
        try await Task.sleep(nanoseconds: 500_000_000) // 500ms
        XCTAssertEqual(sendCount, 20)
        XCTAssertEqual(maxConcurrent, 1, "Sends must be serialized")
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

Expected: FAIL — `SendQueue` not defined.

- [ ] **Step 3: Implement NWConnection async extensions**

`ios-client/TunnelExtension/NWConnectionAsync.swift`:
```swift
import Foundation
import Network

extension NWConnection {
    /// Connect with a timeout. Throws connectTimeout if not ready within the given duration.
    func connectAsync(timeout: TimeInterval) async throws {
        final class ResumeBox: @unchecked Sendable {
            private let lock = NSLock()
            private var didResume = false
            func resumeOnce(_ body: () -> Void) {
                lock.lock()
                defer { lock.unlock() }
                guard !didResume else { return }
                didResume = true
                body()
            }
        }

        let box = ResumeBox()
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                    self.stateUpdateHandler = { state in
                        switch state {
                        case .ready:
                            box.resumeOnce {
                                self.stateUpdateHandler = nil
                                cont.resume()
                            }
                        case .failed(let error):
                            box.resumeOnce {
                                self.stateUpdateHandler = nil
                                cont.resume(throwing: error)
                            }
                        case .cancelled:
                            box.resumeOnce {
                                self.stateUpdateHandler = nil
                                cont.resume(throwing: TunnelError.connectionClosed)
                            }
                        default:
                            break
                        }
                    }
                    self.start(queue: .global())
                }
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                self.cancel()
                throw TunnelError.connectTimeout
            }
            try await group.next()
            group.cancelAll()
        }
    }

    /// Receive data with async/await. Throws CancellationError on task cancellation.
    func receiveAsync() async throws -> Data {
        try await withCheckedThrowingContinuation { cont in
            self.receive(minimumIncompleteLength: 1, maximumLength: 65536) {
                data, _, _, error in
                if let error {
                    cont.resume(throwing: error)
                } else if let data, !data.isEmpty {
                    cont.resume(returning: data)
                } else {
                    // EOF or zero-length read
                    cont.resume(throwing: TunnelError.connectionClosed)
                }
            }
        }
    }

    /// Send data with async/await.
    func sendAsync(_ data: Data) async throws {
        try await withCheckedThrowingContinuation { cont in
            self.send(content: data, completion: .contentProcessed { error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume()
                }
            })
        }
    }
}
```

- [ ] **Step 4: Implement SendQueue actor**

`ios-client/TunnelExtension/SendQueue.swift`:
```swift
import Foundation

/// Serializes frame sends on a single NWConnection to guarantee wire order.
/// All frames (CONNECT_OK, DATA, CLOSE, PONG, etc.) pass through this queue.
actor SendQueue {
    private let sender: (Data) async throws -> Void
    private var isRunning = false
    private var pending: [Data] = []

    /// - Parameter sender: closure that performs the actual send (e.g. NWConnection.sendAsync)
    init(sender: @escaping (Data) async throws -> Void) {
        self.sender = sender
    }

    func enqueue(_ frameData: Data) {
        pending.append(frameData)
        if !isRunning {
            isRunning = true
            Task { await self.drain() }
        }
    }

    private func drain() async {
        while !pending.isEmpty {
            let data = pending.removeFirst()
            do {
                try await sender(data)
            } catch {
                // Send failed — drop remaining queue to avoid cascading errors
                pending.removeAll()
                isRunning = false
                return
            }
        }
        isRunning = false
    }

    func cancel() {
        pending.removeAll()
        isRunning = false
    }
}
```

- [ ] **Step 5: Run tests to verify pass**

```bash
cd ios-client && xcodebuild test -scheme BlockProxy -destination 'platform=iOS Simulator,name=iPhone 16'
```
Expected: All SendQueueTests PASS.

- [ ] **Step 6: Commit**

```bash
git add ios-client/TunnelExtension/NWConnectionAsync.swift ios-client/TunnelExtension/SendQueue.swift ios-client/BlockProxyTests/SendQueueTests.swift
git commit -m "feat(ios): add NWConnection async wrappers and SendQueue actor"
```

---

## Task 7: TunnelClient — Connection, Authentication & Receive Loop

**Files:**
- Create: `ios-client/TunnelExtension/TunnelClient.swift`
- Create: `ios-client/TunnelExtension/TunnelConnection.swift`
- Create: `ios-client/BlockProxyTests/TunnelConnectionTests.swift`

**Interfaces:**
- Consumes: `FrameCodec`, `FrameExtractor`, `SendQueue`, `NWConnection` async extensions (Tasks 4–6)
- Consumes: `ServerConfig` (Task 2)
- Produces: `TunnelConnection` class (one per TLS connection)
- Produces: `TunnelClient` class (manages 1–2 connections, reconnection)

**State isolation requirement:** `TunnelClient.connections`, replenish state, and status callbacks are touched from receive-loop tasks and reconnect tasks. Implement this state behind an actor or a private serial queue. The snippet below shows control flow; production code must not mutate the dictionary concurrently from arbitrary Tasks.

- [ ] **Step 1: Write failing tests for authentication flow**

`ios-client/BlockProxyTests/TunnelConnectionTests.swift`:
```swift
import XCTest
import Network
@testable import BlockProxy

final class TunnelConnectionTests: XCTestCase {

    func testAuthSuccess() async throws {
        // Start a local TCP server that speaks tunnel protocol
        let listener = try NWListener(using: .tcp, on: .any)
        let authOKFrame = FrameCodec.encode(.authOK)
        let port = try await startListener(listener) { connection in
            // Read AUTH frame
            let data = try await connection.receiveAsync()
            let ext = FrameExtractor()
            ext.append(data)
            let frame = try ext.extractFrame()
            if case .auth(let u, let p) = frame {
                XCTAssertEqual(u, "admin")
                XCTAssertEqual(p, "pass")
            }
            // Send AUTH_OK
            try await connection.sendAsync(authOKFrame)
        }

        let conn = TunnelConnection(
            host: "127.0.0.1", port: port,
            username: "admin", password: "pass",
            useTLS: false, allowInsecure: true
        )
        try await conn.connect(timeout: 5)
        try await conn.authenticate()
        XCTAssertTrue(conn.isAuthenticated)
        conn.close()
        listener.cancel()
    }

    func testAuthFail() async throws {
        let listener = try NWListener(using: .tcp, on: .any)
        let authFailFrame = FrameCodec.encode(.authFail)
        let port = try await startListener(listener) { connection in
            _ = try await connection.receiveAsync()
            try await connection.sendAsync(authFailFrame)
        }

        let conn = TunnelConnection(
            host: "127.0.0.1", port: port,
            username: "bad", password: "bad",
            useTLS: false, allowInsecure: true
        )
        try await conn.connect(timeout: 5)
        do {
            try await conn.authenticate()
            XCTFail("Should throw authFailed")
        } catch TunnelError.authFailed {}
        conn.close()
        listener.cancel()
    }

    func testAuthOccupied() async throws {
        let listener = try NWListener(using: .tcp, on: .any)
        let errorFrame = FrameCodec.encode(.error(message: "Tunnel connection limit (2)"))
        let port = try await startListener(listener) { connection in
            _ = try await connection.receiveAsync()
            try await connection.sendAsync(errorFrame)
        }

        let conn = TunnelConnection(
            host: "127.0.0.1", port: port,
            username: "a", password: "b",
            useTLS: false, allowInsecure: true
        )
        try await conn.connect(timeout: 5)
        do {
            try await conn.authenticate()
            XCTFail("Should throw tunnelOccupied")
        } catch TunnelError.tunnelOccupied {}
        conn.close()
        listener.cancel()
    }

    // Helper: start listener and return port
    private func startListener(
        _ listener: NWListener,
        handler: @escaping (NWConnection) async throws -> Void
    ) async throws -> UInt16 {
        try await withCheckedThrowingContinuation { cont in
            listener.newConnectionHandler = { connection in
                connection.start(queue: .global())
                Task { try await handler(connection) }
            }
            listener.stateUpdateHandler = { state in
                if case .ready = state {
                    let port = listener.port!.rawValue
                    cont.resume(returning: port)
                }
            }
            listener.start(queue: .global())
        }
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

Expected: FAIL — `TunnelConnection` not defined.

- [ ] **Step 3: Implement TunnelConnection**

`ios-client/TunnelExtension/TunnelConnection.swift`:
```swift
import Foundation
import Network

/// Represents a single TLS tunnel connection to the block-proxy server.
/// Each connection has its own FrameExtractor, SendQueue, and receive loop.
class TunnelConnection {
    let id: UInt32
    private let host: String
    private let port: UInt16
    private let username: String
    private let password: String
    private let useTLS: Bool
    private let allowInsecure: Bool

    private var connection: NWConnection?
    private var sendQueue: SendQueue?
    private let extractor = FrameExtractor()

    private(set) var isAuthenticated = false
    private var isClosed = false

    /// Callback when a frame is received (after authentication).
    var onFrame: ((TunnelConnection, Frame) -> Void)?
    /// Callback when this connection is lost.
    var onDisconnect: ((TunnelConnection) -> Void)?

    private static var nextId: UInt32 = 0
    private static let idLock = NSLock()

    init(host: String, port: UInt16, username: String, password: String,
         useTLS: Bool, allowInsecure: Bool) {
        Self.idLock.lock()
        Self.nextId += 1
        self.id = Self.nextId
        Self.idLock.unlock()
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.useTLS = useTLS
        self.allowInsecure = allowInsecure
    }

    /// Establish NWConnection with timeout.
    func connect(timeout: TimeInterval) async throws {
        let nwHost = NWEndpoint.Host(host)
        let nwPort = NWEndpoint.Port(rawValue: port)!
        let params: NWParameters
        if useTLS {
            let tlsOptions = NWProtocolTLS.Options()
            sec_protocol_options_set_min_tls_protocol_version(
                tlsOptions.securityProtocolOptions,
                .TLSv12
            )
            if allowInsecure {
                sec_protocol_options_set_verify_block(
                    tlsOptions.securityProtocolOptions,
                    { _, _, completion in completion(true) },
                    .global()
                )
            }
            params = NWParameters(tls: tlsOptions, tcp: NWProtocolTCP.Options())
        } else {
            params = .tcp
        }
        if let tcp = params.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
            tcp.noDelay = true
            tcp.enableKeepalive = true
        }
        params.requiredInterfaceType = nil
        params.prohibitExpensivePaths = false

        let conn = NWConnection(host: nwHost, port: nwPort, using: params)
        self.connection = conn

        self.sendQueue = SendQueue { [weak conn] data in
            try await conn?.sendAsync(data)
        }

        try await conn.connectAsync(timeout: timeout)
    }

    /// Send AUTH frame and wait for response.
    func authenticate() async throws {
        guard let connection else { throw TunnelError.connectionClosed }
        let authFrame = FrameCodec.encode(.auth(username: username, password: password))
        try await connection.sendAsync(authFrame)

        let data = try await connection.receiveAsync()
        extractor.append(data)
        guard let frame = try extractor.extractFrame() else {
            throw TunnelError.invalidFrame
        }
        switch frame {
        case .authOK:
            isAuthenticated = true
        case .authFail:
            throw TunnelError.authFailed
        case .error:
            throw TunnelError.tunnelOccupied
        default:
            throw TunnelError.invalidFrame
        }
    }

    /// Start the receive loop. Must be called after authenticate().
    /// This method runs until the connection is closed or an error occurs.
    func receiveLoop() async {
        guard let connection else { return }
        while !isClosed {
            do {
                let frame = try await receiveWithIdleTimeout(
                    connection: connection,
                    timeout: 60
                )
                handleFrame(frame)
            } catch {
                break
            }
        }
        close()
        onDisconnect?(self)
    }

    /// Receive a single frame with 60-second idle timeout.
    /// The timeout is reset only after a complete frame is decoded.
    private func receiveWithIdleTimeout(
        connection: NWConnection,
        timeout: TimeInterval
    ) async throws -> Frame {
        while true {
            let data: Data = try await withThrowingTaskGroup(of: Data.self) { group in
                group.addTask {
                    try await connection.receiveAsync()
                }
                group.addTask {
                    try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                    throw TunnelError.idleTimeout
                }
                let result = try await group.next()!
                group.cancelAll()
                return result
            }
            extractor.append(data)
            // Try to extract a complete frame
            if let frame = try extractor.extractFrame() {
                return frame
            }
            // Partial receive — do NOT reset idle timeout; continue waiting
        }
    }

    private func handleFrame(_ frame: Frame) {
        switch frame {
        case .ping:
            // Reply PONG on this same connection
            Task { await send(.pong) }
        default:
            onFrame?(self, frame)
        }
    }

    /// Enqueue a frame for sending via the send queue (preserves wire order).
    func send(_ frame: Frame) async {
        do {
            let data = try FrameCodec.encodeChecked(frame)
            await sendQueue?.enqueue(data)
        } catch {
            // Logging is wired in Task 13. Until then, invalid outbound frames are dropped.
        }
    }

    func close() {
        guard !isClosed else { return }
        isClosed = true
        isAuthenticated = false
        Task { await sendQueue?.cancel() }
        connection?.cancel()
    }
}
```

- [ ] **Step 4: Implement TunnelClient skeleton (start/stop lifecycle)**

`ios-client/TunnelExtension/TunnelClient.swift`:
```swift
import Foundation
import Network

/// Manages 1–2 tunnel connections to the block-proxy server.
/// Handles reconnection with exponential backoff and connection replenishment.
class TunnelClient {
    private let config: ServerConfig
    private let credentials: TunnelCredentials
    private var connections: [UInt32: TunnelConnection] = [:]
    private var isRunning = false
    private var runTask: Task<Void, Never>?

    /// Callback for status changes (called from background tasks).
    var onStatusChange: ((TunnelStatus, String) -> Void)?
    /// Callback for reverse CONNECT requests.
    var onReverseConnect: ((TunnelConnection, UInt16, FrameAddress, UInt16) -> Void)?
    /// Callback for DATA received for a reqid.
    var onData: ((UInt16, Data) -> Void)?
    /// Callback for CLOSE received for a reqid.
    var onClose: ((UInt16) -> Void)?

    init(config: ServerConfig, credentials: TunnelCredentials) {
        self.config = config
        self.credentials = credentials
    }

    /// Start the background reconnection loop. Returns immediately.
    func start() {
        guard !isRunning else { return }
        isRunning = true
        runTask = Task { await runLoop() }
    }

    /// Stop all connections and the reconnection loop.
    /// Waits up to `timeout` seconds for cleanup.
    func stop(timeout: TimeInterval = 5) async {
        isRunning = false
        runTask?.cancel()
        let allConns = connections.values
        for conn in allConns {
            conn.close()
        }
        connections.removeAll()
        // Wait for cleanup with timeout
        try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
    }

    private func runLoop() async {
        var backoff: UInt64 = 1  // seconds
        while isRunning && !Task.isCancelled {
            do {
                onStatusChange?(.connecting, "")
                try await connectAndServe()
                backoff = 1  // reset on success
            } catch TunnelError.tunnelOccupied {
                onStatusChange?(.occupied, "")
                break  // non-retryable
            } catch TunnelError.authFailed {
                onStatusChange?(.authFailed, "")
                break  // non-retryable
            } catch {
                if !isRunning { break }
                onStatusChange?(.reconnecting, "\(backoff)s")
                try? await Task.sleep(nanoseconds: backoff * 1_000_000_000)
                backoff = min(backoff * 2, 60)
            }
        }
    }

    private func connectAndServe() async throws {
        // Establish first connection (mandatory)
        let conn1 = try await createAndAuthConnection()
        connections[conn1.id] = conn1
        onStatusChange?(.connected, "")
        Task { await conn1.receiveLoop() }

        // Try second connection (best-effort)
        Task {
            do {
                let conn2 = try await createAndAuthConnection()
                connections[conn2.id] = conn2
                Task { await conn2.receiveLoop() }
            } catch {
                // Second connection failure is not fatal
            }
        }

        // Stay in this serve cycle until all tunnel connections are gone.
        while isRunning && !Task.isCancelled {
            if connections.isEmpty { throw TunnelError.connectionClosed }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
    }

    private func createAndAuthConnection() async throws -> TunnelConnection {
        let conn = TunnelConnection(
            host: config.effectiveHost,
            port: config.effectivePort,
            username: credentials.username,
            password: credentials.password,
            useTLS: config.useTLS,
            allowInsecure: config.allowInsecure
        )
        conn.onFrame = { [weak self] connection, frame in
            self?.handleFrame(connection: connection, frame: frame)
        }
        conn.onDisconnect = { [weak self] connection in
            self?.handleDisconnect(connection)
        }
        try await conn.connect(timeout: 10)
        try await conn.authenticate()
        return conn
    }

    private func handleFrame(connection: TunnelConnection, frame: Frame) {
        switch frame {
        case .connect(let reqid, let addr, let port):
            onReverseConnect?(connection, reqid, addr, port)
        case .data(let reqid, let payload):
            onData?(reqid, payload)
        case .close(let reqid):
            onClose?(reqid)
        case .error:
            // Post-auth ERROR: log and ignore (per spec)
            break
        default:
            break
        }
    }

    private func handleDisconnect(_ connection: TunnelConnection) {
        connections.removeValue(forKey: connection.id)
        if connections.isEmpty {
            onStatusChange?(.disconnected, "")
        } else {
            // Try to replenish the lost connection
            Task {
                for attempt in 1...3 {
                    do {
                        let conn = try await createAndAuthConnection()
                        connections[conn.id] = conn
                        Task { await conn.receiveLoop() }
                        return
                    } catch {
                        try? await Task.sleep(nanoseconds: UInt64(attempt * 2) * 1_000_000_000)
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 5: Run tests to verify pass**

```bash
cd ios-client && xcodebuild test -scheme BlockProxy -destination 'platform=iOS Simulator,name=iPhone 16'
```
Expected: All TunnelConnectionTests PASS.

- [ ] **Step 6: Commit**

```bash
git add ios-client/TunnelExtension/TunnelConnection.swift ios-client/TunnelExtension/TunnelClient.swift ios-client/BlockProxyTests/TunnelConnectionTests.swift
git commit -m "feat(ios): implement TunnelConnection with AUTH flow and TunnelClient with dual-connection reconnection"
```

---

## Task 8: Reverse CONNECT Session & Bidirectional Relay

**Files:**
- Create: `ios-client/TunnelExtension/ReverseConnectHandler.swift`
- Create: `ios-client/BlockProxyTests/ReverseConnectTests.swift`

**Interfaces:**
- Consumes: `TunnelConnection.send(_:)`, `FrameCodec` (Tasks 4, 7)
- Produces: `ReverseConnectHandler` class — manages per-reqid sessions and relay tasks

- [ ] **Step 1: Write failing tests**

`ios-client/BlockProxyTests/ReverseConnectTests.swift`:
```swift
import XCTest
import Network
@testable import BlockProxy

final class ReverseConnectTests: XCTestCase {

    func testConnectOKSentOnSuccess() async throws {
        // Start a mock target TCP server
        let listener = try NWListener(using: .tcp, on: .any)
        var targetReceivedData = Data()
        let port = try await startTargetServer(listener) { connection in
            // Echo back any received data
            let data = try await connection.receiveAsync()
            targetReceivedData = data
            try await connection.sendAsync(Data([0x42, 0x43])) // "BC"
        }

        var sentFrames: [Frame] = []
        let mockConnection = TunnelConnection(
            host: "127.0.0.1", port: 1,
            username: "u", password: "p",
            useTLS: false, allowInsecure: true
        )
        let handler = ReverseConnectHandler { _, frame in
            sentFrames.append(frame)
        }

        handler.handleConnect(connection: mockConnection, reqid: 1, addr: .ipv4("127.0.0.1"), port: port)

        // Wait for connection + CONNECT_OK
        try await Task.sleep(nanoseconds: 500_000_000)

        // Verify CONNECT_OK was sent
        XCTAssertTrue(sentFrames.contains { frame in
            if case .connectOK(let reqid) = frame { return reqid == 1 }
            return false
        })

        handler.closeSession(reqid: 1)
        listener.cancel()
    }

    func testConnectFailedOnUnreachable() async throws {
        var sentFrames: [Frame] = []
        let mockConnection = TunnelConnection(
            host: "127.0.0.1", port: 1,
            username: "u", password: "p",
            useTLS: false, allowInsecure: true
        )
        let handler = ReverseConnectHandler { _, frame in
            sentFrames.append(frame)
        }

        // Port 1 is almost certainly unreachable
        handler.handleConnect(connection: mockConnection, reqid: 2, addr: .ipv4("127.0.0.1"), port: 1)

        try await Task.sleep(nanoseconds: 2_000_000_000)

        XCTAssertTrue(sentFrames.contains { frame in
            if case .connectFailed(let reqid) = frame { return reqid == 2 }
            return false
        })
    }

    func testCloseIdempotent() async throws {
        var closeCount = 0
        let handler = ReverseConnectHandler { _, frame in
            if case .close = frame { closeCount += 1 }
        }
        handler.closeSession(reqid: 99)
        handler.closeSession(reqid: 99)
        handler.closeSession(reqid: 99)
        // No active session, so no CLOSE frames should be sent
        XCTAssertEqual(closeCount, 0)
    }

    private func startTargetServer(
        _ listener: NWListener,
        handler: @escaping (NWConnection) async throws -> Void
    ) async throws -> UInt16 {
        try await withCheckedThrowingContinuation { cont in
            listener.newConnectionHandler = { connection in
                connection.start(queue: .global())
                Task { try await handler(connection) }
            }
            listener.stateUpdateHandler = { state in
                if case .ready = state {
                    cont.resume(returning: listener.port!.rawValue)
                }
            }
            listener.start(queue: .global())
        }
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

Expected: FAIL — `ReverseConnectHandler` not defined.

- [ ] **Step 3: Implement ReverseConnectHandler**

`ios-client/TunnelExtension/ReverseConnectHandler.swift`:
```swift
import Foundation
import Network

/// Manages per-reqid reverse CONNECT sessions.
/// Each session opens a TCP connection to a local target, relays data
/// bidirectionally with the tunnel, and handles CLOSE idempotently.
class ReverseConnectHandler {
    /// Callback to send a frame through the exact tunnel connection that owns a reqid.
    private let sendToTunnel: (TunnelConnection, Frame) -> Void

    private var sessions: [UInt16: RequestSession] = [:]
    private let lock = NSLock()

    init(sendToTunnel: @escaping (TunnelConnection, Frame) -> Void) {
        self.sendToTunnel = sendToTunnel
    }

    /// Handle a CONNECT request from the server.
    func handleConnect(connection: TunnelConnection, reqid: UInt16, addr: FrameAddress, port: UInt16) {
        Task {
            do {
                let targetConn = try await connectToTarget(
                    addr: addr, port: port, timeout: 30
                )
                sendToTunnel(connection, .connectOK(reqid: reqid))

                let session = RequestSession(
                    tunnelConnection: connection,
                    reqid: reqid,
                    targetConnection: targetConn,
                    sendToTunnel: sendToTunnel
                )
                lock.lock()
                sessions[reqid] = session
                lock.unlock()

                // Start bidirectional relay
                await session.startRelay()

                // Relay finished — send CLOSE if not already closed
                session.sendCloseIfNeeded()

                lock.lock()
                sessions.removeValue(forKey: reqid)
                lock.unlock()
            } catch {
                sendToTunnel(connection, .connectFailed(reqid: reqid))
            }
        }
    }

    /// Handle DATA frame from tunnel — write to target.
    func handleData(reqid: UInt16, data: Data) {
        lock.lock()
        let session = sessions[reqid]
        lock.unlock()
        session?.writeToTarget(data)
    }

    /// Handle CLOSE frame from tunnel.
    func handleClose(reqid: UInt16) {
        lock.lock()
        let session = sessions[reqid]
        lock.unlock()
        session?.closeFromTunnel()
    }

    /// Force-close a session (e.g. when tunnel connection drops).
    func closeSession(reqid: UInt16) {
        lock.lock()
        let session = sessions.removeValue(forKey: reqid)
        lock.unlock()
        session?.forceClose()
    }

    /// Close all active sessions (e.g. on full disconnect).
    func closeAll() {
        lock.lock()
        let all = sessions
        sessions.removeAll()
        lock.unlock()
        for session in all.values {
            session.forceClose()
        }
    }

    private func connectToTarget(
        addr: FrameAddress, port: UInt16, timeout: TimeInterval
    ) async throws -> NWConnection {
        let host: NWEndpoint.Host
        switch addr {
        case .ipv4(let ip):
            guard let ipv4 = IPv4Address(ip) else { throw TunnelError.invalidAddressType }
            host = .ipv4(ipv4)
        case .ipv6(let ip):
            guard let ipv6 = IPv6Address(ip) else { throw TunnelError.invalidAddressType }
            host = .ipv6(ipv6)
        case .domain(let name):
            host = .name(name, nil)
        }
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = nil
        let conn = NWConnection(host: host, port: NWEndpoint.Port(rawValue: port)!, using: params)
        try await conn.connectAsync(timeout: timeout)
        return conn
    }
}

/// Per-reqid session holding the target connection and relay tasks.
class RequestSession {
    let tunnelConnection: TunnelConnection
    let reqid: UInt16
    private let targetConnection: NWConnection
    private let sendToTunnel: (TunnelConnection, Frame) -> Void
    private var isClosed = false
    private let closeLock = NSLock()
    private let targetWriteQueue: SendQueue

    init(tunnelConnection: TunnelConnection, reqid: UInt16, targetConnection: NWConnection,
         sendToTunnel: @escaping (TunnelConnection, Frame) -> Void) {
        self.tunnelConnection = tunnelConnection
        self.reqid = reqid
        self.targetConnection = targetConnection
        self.sendToTunnel = sendToTunnel
        self.targetWriteQueue = SendQueue { data in
            try await targetConnection.sendAsync(data)
        }
    }

    func startRelay() async {
        // Tunnel -> target is driven by handleData()/handleClose().
        // This method waits for target -> tunnel to end, then caller sends CLOSE if needed.
        await relayTargetToTunnel()
    }

    /// Read from target TCP connection, send as DATA frames through tunnel.
    private func relayTargetToTunnel() async {
        do {
            while true {
                let data = try await targetConnection.receiveAsync()
                if data.isEmpty { break }
                // Slice into max DATA chunks
                var offset = 0
                while offset < data.count {
                    let end = min(offset + FrameCodec.maxDataChunk, data.count)
                    let chunk = data.subdata(in: offset..<end)
                    sendToTunnel(tunnelConnection, .data(reqid: reqid, payload: chunk))
                    offset = end
                    // Yield for fair scheduling across multiple reqids
                    if end < data.count { await Task.yield() }
                }
            }
        } catch {
            // Target closed or error — relay ends
        }
    }

    /// Write DATA from tunnel to target (called by ReverseConnectHandler.handleData).
    func writeToTarget(_ data: Data) {
        closeLock.lock()
        let closed = isClosed
        closeLock.unlock()
        if closed { return }  // Gracefully discard late DATA after CLOSE

        Task { await targetWriteQueue.enqueue(data) }
    }

    /// Handle CLOSE from tunnel side.
    func closeFromTunnel() {
        closeLock.lock()
        guard !isClosed else {
            closeLock.unlock()
            return
        }
        isClosed = true
        closeLock.unlock()
        targetConnection.cancel()
    }

    func sendCloseIfNeeded() {
        closeLock.lock()
        let wasClosed = isClosed
        isClosed = true
        closeLock.unlock()
        if !wasClosed {
            sendToTunnel(tunnelConnection, .close(reqid: reqid))
        }
        targetConnection.cancel()
    }

    func forceClose() {
        closeLock.lock()
        isClosed = true
        closeLock.unlock()
        targetConnection.cancel()
    }
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd ios-client && xcodebuild test -scheme BlockProxy -destination 'platform=iOS Simulator,name=iPhone 16'
```
Expected: All ReverseConnectTests PASS.

- [ ] **Step 5: Commit**

```bash
git add ios-client/TunnelExtension/ReverseConnectHandler.swift ios-client/BlockProxyTests/ReverseConnectTests.swift
git commit -m "feat(ios): implement ReverseConnectHandler with per-reqid sessions and bidirectional relay"
```

---

## Task 9: PacketTunnelProvider Integration

**Files:**
- Create: `ios-client/TunnelExtension/PacketTunnelProvider.swift`

**Interfaces:**
- Consumes: `TunnelClient` (Task 7), `ReverseConnectHandler` (Task 8), `ConfigStore` (Task 2)
- Produces: `PacketTunnelProvider` class (NEPacketTunnelProvider subclass)

- [ ] **Step 1: Implement PacketTunnelProvider**

`ios-client/TunnelExtension/PacketTunnelProvider.swift`:
```swift
import NetworkExtension

class PacketTunnelProvider: NEPacketTunnelProvider {
    private var tunnelClient: TunnelClient?
    private var reverseHandler: ReverseConnectHandler?

    override func startTunnel(options: [String: NSObject]?,
                              completionHandler: @escaping (Error?) -> Void) {
        // Empty route table: VPN is for process keepalive only
        let settings = NEPacketTunnelNetworkSettings(
            tunnelRemoteAddress: "127.0.0.1"
        )
        settings.ipv4Settings = NEIPv4Settings(
            addresses: ["10.0.0.2"],
            subnetMasks: ["255.255.255.0"]
        )
        settings.ipv4Settings?.includedRoutes = []
        settings.ipv4Settings?.excludedRoutes = [NEIPv4Route.default()]

        setTunnelNetworkSettings(settings) { [weak self] error in
            guard let self, error == nil else {
                return completionHandler(error)
            }
            guard let config = ConfigStore.shared.load() else {
                return completionHandler(NSError(
                    domain: "PacketTunnelProvider", code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "No configuration found"]
                ))
            }
            guard let loadedCredentials = KeychainHelper().load() else {
                return completionHandler(NSError(
                    domain: "PacketTunnelProvider", code: -2,
                    userInfo: [NSLocalizedDescriptionKey: "No credentials found"]
                ))
            }
            let credentials = TunnelCredentials(
                username: loadedCredentials.username,
                password: loadedCredentials.password
            )

            let client = TunnelClient(config: config, credentials: credentials)
            let handler = ReverseConnectHandler { connection, frame in
                Task { await connection.send(frame) }
            }

            client.onStatusChange = { [weak self] status, detail in
                ConfigStore.shared.saveStatus(status)
                self?.notifyStatusChange()
            }
            client.onReverseConnect = { connection, reqid, addr, port in
                handler.handleConnect(connection: connection, reqid: reqid, addr: addr, port: port)
            }
            client.onData = { reqid, data in
                handler.handleData(reqid: reqid, data: data)
            }
            client.onClose = { reqid in
                handler.handleClose(reqid: reqid)
            }

            self.tunnelClient = client
            self.reverseHandler = handler
            client.start()
            completionHandler(nil)
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason,
                             completionHandler: @escaping () -> Void) {
        Task {
            reverseHandler?.closeAll()
            await tunnelClient?.stop(timeout: 5)
            ConfigStore.shared.saveStatus(.disconnected)
            completionHandler()
        }
    }

    override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)?) {
        // Respond with current status
        let status = ConfigStore.shared.loadStatus()
        let data = try? JSONEncoder().encode(status)
        completionHandler?(data)
    }

    private func notifyStatusChange() {
        // Post Darwin Notification for main app
        let name = "com.blockproxy.statusChanged" as CFString
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(name),
            nil, nil, true
        )
    }
}
```

- [ ] **Step 2: Verify build**

```bash
cd ios-client && xcodebuild -scheme BlockProxy -destination 'generic/platform=iOS' build
```
Expected: BUILD SUCCEEDED.

- [ ] **Step 3: Commit**

```bash
git add ios-client/TunnelExtension/PacketTunnelProvider.swift
git commit -m "feat(ios): integrate PacketTunnelProvider with TunnelClient and ReverseConnectHandler"
```

---

## Task 10: Cross-Process State Communication

**Files:**
- Create: `ios-client/BlockProxy/Services/StatusObserver.swift`
- Create: `ios-client/BlockProxyTests/StatusObserverTests.swift`

**Interfaces:**
- Consumes: `ConfigStore.loadStatus()` (Task 2), Darwin Notification
- Produces: `StatusObserver` class (listens for Extension status updates)

- [ ] **Step 1: Write failing tests**

`ios-client/BlockProxyTests/StatusObserverTests.swift`:
```swift
import XCTest
@testable import BlockProxy

final class StatusObserverTests: XCTestCase {
    func testDarwinNotificationName() {
        XCTAssertEqual(StatusObserver.notificationName, "com.blockproxy.statusChanged")
    }

    func testInitialStatus() {
        let observer = StatusObserver()
        XCTAssertEqual(observer.status, .disconnected)
    }
}
```

- [ ] **Step 2: Run tests to verify failure**

Expected: FAIL — `StatusObserver` not defined.

- [ ] **Step 3: Implement StatusObserver**

`ios-client/BlockProxy/Services/StatusObserver.swift`:
```swift
import Foundation

@MainActor
class StatusObserver: ObservableObject {
    static let notificationName = "com.blockproxy.statusChanged"

    @Published var status: TunnelStatus = .disconnected

    private var observer: NSObjectProtocol?

    init() {
        refreshStatus()
        startObserving()
    }

    deinit {
        if let observer {
            CFNotificationCenterRemoveObserver(
                CFNotificationCenterGetDarwinNotifyCenter(),
                Unmanaged.passUnretained(self as AnyObject).toOpaque(),
                nil, nil
            )
            _ = observer // prevent premature dealloc
        }
    }

    func refreshStatus() {
        status = ConfigStore.shared.loadStatus()
    }

    /// Query Extension for current status via IPC.
    func queryExtension(session: NETunnelProviderSession?) async {
        guard let session else { return }
        let queryData = "status".data(using: .utf8)!
        session.sendProviderMessage(queryData) { [weak self] response in
            guard let data = response,
                  let status = try? JSONDecoder().decode(TunnelStatus.self, from: data)
            else { return }
            Task { @MainActor in
                self?.status = status
            }
        }
    }

    private func startObserving() {
        let name = Self.notificationName as CFString
        let callback: CFNotificationCallback = { _, observer, _, _, _ in
            guard let observer else { return }
            let self_ = Unmanaged<StatusObserver>
                .fromOpaque(observer).takeUnretainedValue()
            Task { @MainActor in
                self_.refreshStatus()
            }
        }
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(),
            callback, name, nil, .deliverImmediately
        )
    }
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd ios-client && xcodebuild test -scheme BlockProxy -destination 'platform=iOS Simulator,name=iPhone 16'
```
Expected: All StatusObserverTests PASS.

- [ ] **Step 5: Commit**

```bash
git add ios-client/BlockProxy/Services/StatusObserver.swift ios-client/BlockProxyTests/StatusObserverTests.swift
git commit -m "feat(ios): add StatusObserver with Darwin Notification and IPC query"
```

---

## Task 11: SwiftUI Main Interface

**Files:**
- Create: `ios-client/BlockProxy/App/BlockProxyApp.swift`
- Create: `ios-client/BlockProxy/App/ContentView.swift`
- Create: `ios-client/BlockProxy/ViewModels/TunnelViewModel.swift`
- Create: `ios-client/BlockProxy/Views/StatusView.swift`

**Interfaces:**
- Consumes: `VPNManager` (Task 3), `StatusObserver` (Task 10), `ServerConfig` (Task 2)
- Produces: Complete SwiftUI app entry and main interface

- [ ] **Step 1: Implement BlockProxyApp**

`ios-client/BlockProxy/App/BlockProxyApp.swift`:
```swift
import SwiftUI

@main
struct BlockProxyApp: App {
    @StateObject private var vpnManager = VPNManager()
    @StateObject private var statusObserver = StatusObserver()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(vpnManager)
                .environmentObject(statusObserver)
        }
    }
}
```

- [ ] **Step 2: Implement TunnelViewModel**

`ios-client/BlockProxy/ViewModels/TunnelViewModel.swift`:
```swift
import SwiftUI

@MainActor
class TunnelViewModel: ObservableObject {
    @Published var isEnabled = false
    @Published var isSetup = false
    @Published var errorMessage: String?

    private let vpnManager: VPNManager
    private let statusObserver: StatusObserver

    init(vpnManager: VPNManager, statusObserver: StatusObserver) {
        self.vpnManager = vpnManager
        self.statusObserver = statusObserver
    }

    func setup() async {
        do {
            try await vpnManager.setupVPN()
            isSetup = true
        } catch {
            errorMessage = "VPN 配置失败: \(error.localizedDescription)"
        }
    }

    func toggle() async {
        if isEnabled {
            await stop()
        } else {
            await start()
        }
    }

    private func start() async {
        guard let config = ConfigStore.shared.load() else {
            errorMessage = "请先配置服务器信息"
            return
        }
        do {
            try await vpnManager.startVPN(config: config)
            isEnabled = true
            errorMessage = nil
        } catch {
            errorMessage = "启动失败: \(error.localizedDescription)"
        }
    }

    private func stop() async {
        do {
            try await vpnManager.stopVPN()
            isEnabled = false
        } catch {
            errorMessage = "停止失败: \(error.localizedDescription)"
        }
    }
}
```

- [ ] **Step 3: Implement StatusView**

`ios-client/BlockProxy/Views/StatusView.swift`:
```swift
import SwiftUI

struct StatusView: View {
    let status: TunnelStatus

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(color)
                .frame(width: 12, height: 12)
            Text(status.displayText)
                .font(.headline)
        }
        .padding()
        .background(Color(.systemBackground))
        .cornerRadius(12)
        .shadow(radius: 1)
    }

    private var color: Color {
        switch status {
        case .disconnected:  return .gray
        case .connecting:    return .yellow
        case .connected:     return .green
        case .reconnecting:  return .orange
        case .occupied:      return .red
        case .authFailed:    return .red
        }
    }
}
```

- [ ] **Step 4: Implement ContentView**

`ios-client/BlockProxy/App/ContentView.swift`:
```swift
import SwiftUI

struct ContentView: View {
    @EnvironmentObject var vpnManager: VPNManager
    @EnvironmentObject var statusObserver: StatusObserver

    var body: some View {
        ContentBody(vpnManager: vpnManager, statusObserver: statusObserver)
    }
}

private struct ContentBody: View {
    @ObservedObject var vpnManager: VPNManager
    @ObservedObject var statusObserver: StatusObserver
    @State private var showConfig = false
    @StateObject private var viewModel: TunnelViewModel

    init(vpnManager: VPNManager, statusObserver: StatusObserver) {
        self.vpnManager = vpnManager
        self.statusObserver = statusObserver
        _viewModel = StateObject(wrappedValue: TunnelViewModel(
            vpnManager: vpnManager,
            statusObserver: statusObserver
        ))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                StatusView(status: statusObserver.status)
                    .padding(.top, 40)

                Toggle("启用隧道", isOn: Binding(
                    get: { viewModel.isEnabled },
                    set: { _ in Task { await viewModel.toggle() } }
                ))
                .padding(.horizontal)

                if let error = viewModel.errorMessage {
                    Text(error)
                        .foregroundColor(.red)
                        .font(.caption)
                }

                Spacer()
            }
            .navigationTitle("BlockProxy")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("配置") { showConfig = true }
                }
            }
            .sheet(isPresented: $showConfig) {
                ConfigView()
            }
            .task {
                await viewModel.setup()
            }
        }
    }
}
```

- [ ] **Step 5: Verify build**

```bash
cd ios-client && xcodebuild -scheme BlockProxy -destination 'generic/platform=iOS' build
```
Expected: BUILD SUCCEEDED.

- [ ] **Step 6: Commit**

```bash
git add ios-client/BlockProxy/App/ ios-client/BlockProxy/ViewModels/ ios-client/BlockProxy/Views/
git commit -m "feat(ios): add SwiftUI main interface with status display and toggle"
```

---

## Task 12: Configuration UI & First Launch Flow

**Files:**
- Create: `ios-client/BlockProxy/Views/ConfigView.swift`

**Interfaces:**
- Consumes: `ServerConfig`, `ConfigStore` (Task 2)
- Produces: `ConfigView` — configuration form with validation

- [ ] **Step 1: Implement ConfigView**

`ios-client/BlockProxy/Views/ConfigView.swift`:
```swift
import SwiftUI

struct ConfigView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var serverHost = ""
    @State private var serverPort = "8003"
    @State private var username = ""
    @State private var password = ""
    @State private var useTLS = true
    @State private var allowInsecure = true
    @State private var tunnelHost = ""
    @State private var tunnelPort = ""
    @State private var showPassword = false
    @State private var validationError: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("服务器") {
                    TextField("服务器地址", text: $serverHost)
                        .textContentType(.URL)
                        .autocapitalization(.none)
                    TextField("端口", text: $serverPort)
                        .keyboardType(.numberPad)
                }

                Section("安全") {
                    Toggle("启用 TLS", isOn: $useTLS)
                    if useTLS {
                        Toggle("允许不安全证书", isOn: $allowInsecure)
                    }
                }

                Section("认证") {
                    TextField("用户名", text: $username)
                        .autocapitalization(.none)
                    if showPassword {
                        TextField("密码", text: $password)
                    } else {
                        SecureField("密码", text: $password)
                    }
                    Toggle("显示密码", isOn: $showPassword)
                }

                Section("隧道（可选覆盖）") {
                    TextField("隧道地址", text: $tunnelHost)
                        .autocapitalization(.none)
                    TextField("隧道端口", text: $tunnelPort)
                        .keyboardType(.numberPad)
                }

                if let error = validationError {
                    Section {
                        Text(error).foregroundColor(.red)
                    }
                }
            }
            .navigationTitle("配置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                        .disabled(!isValid)
                }
            }
            .onAppear(perform: load)
        }
    }

    private var isValid: Bool {
        !serverHost.isEmpty &&
        UInt16(serverPort) != nil &&
        !username.isEmpty &&
        !password.isEmpty
    }

    private func load() {
        if let config = ConfigStore.shared.load() {
            serverHost = config.serverHost
            serverPort = "\(config.serverPort)"
            useTLS = config.useTLS
            allowInsecure = config.allowInsecure
            tunnelHost = config.tunnelHost ?? ""
            tunnelPort = config.tunnelPort.map { "\($0)" } ?? ""
        }
        if let credentials = KeychainHelper().load() {
            username = credentials.username
            password = credentials.password
        }
    }

    private func save() {
        guard let port = UInt16(serverPort) else {
            validationError = "端口无效"
            return
        }
        let config = ServerConfig(
            serverHost: serverHost,
            serverPort: port,
            useTLS: useTLS,
            allowInsecure: allowInsecure,
            tunnelHost: tunnelHost.isEmpty ? nil : tunnelHost,
            tunnelPort: tunnelPort.isEmpty ? nil : UInt16(tunnelPort)
        )
        do {
            try ConfigStore.shared.save(config)
            // Also save credentials to Keychain
            try KeychainHelper().save(username: username, password: password)
            dismiss()
        } catch {
            validationError = "保存失败: \(error.localizedDescription)"
        }
    }
}
```

- [ ] **Step 2: Verify build**

```bash
cd ios-client && xcodebuild -scheme BlockProxy -destination 'generic/platform=iOS' build
```
Expected: BUILD SUCCEEDED.

- [ ] **Step 3: Commit**

```bash
git add ios-client/BlockProxy/Views/ConfigView.swift
git commit -m "feat(ios): add configuration form with validation and persistence"
```

---

## Task 13: Logging & Deployment Documentation

**Files:**
- Create: `ios-client/TunnelExtension/TunnelLogger.swift`
- Create: `docs/ios-client-deployment.md`

**Interfaces:**
- Produces: `TunnelLogger` for extension-side logging to App Group shared directory
- Produces: Deployment documentation

- [ ] **Step 1: Implement TunnelLogger**

`ios-client/TunnelExtension/TunnelLogger.swift`:
```swift
import Foundation

class TunnelLogger {
    static let shared = TunnelLogger()

    private let fileHandle: FileHandle?
    private let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        return f
    }()

    private init() {
        guard let containerURL = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: "group.com.blockproxy")
        else {
            fileHandle = nil
            return
        }
        let logURL = containerURL.appendingPathComponent("tunnel.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        fileHandle = try? FileHandle(forWritingTo: logURL)
        fileHandle?.seekToEndOfFile()
    }

    func log(_ message: String, level: String = "INFO") {
        let timestamp = dateFormatter.string(from: Date())
        let line = "[\(timestamp)] [\(level)] \(message)\n"
        fileHandle?.write(line.data(using: .utf8)!)
    }

    func error(_ message: String) { log(message, level: "ERROR") }
    func warn(_ message: String)  { log(message, level: "WARN") }
    func debug(_ message: String) { log(message, level: "DEBUG") }
}
```

- [ ] **Step 2: Write deployment documentation**

`docs/ios-client-deployment.md`:
```markdown
# iOS 客户端部署指南

## 前置条件

1. Apple Developer 账号已启用 Network Extensions capability
2. 创建 App ID: `com.blockproxy` 和 `com.blockproxy.tunnel-extension`
3. 创建 App Group: `group.com.blockproxy`
4. 生成包含 Network Extension entitlement 的 Provisioning Profile

## 构建与安装

### Xcode 直连安装
1. 连接 iOS 设备
2. 在 Xcode 中选择目标设备
3. 配置签名（Team + Provisioning Profile）
4. 点击 Run 安装

### TestFlight 分发
1. Archive 项目
2. 上传到 App Store Connect
3. 添加内部/外部测试员
4. 通过 TestFlight App 安装

## 首次使用

1. 打开 BlockProxy App
2. 点击右上角"配置"
3. 填写服务器地址、端口、用户名、密码
4. 默认 TLS 开启，`allowInsecure=true`（加密但不校验证书链）
5. 返回主界面，打开"启用隧道"开关
6. 系统弹出 VPN 配置授权对话框，点击"允许"

## 服务端配置

**重要**: block-proxy 服务端必须配置 `tunnel_domains` 才能将请求路由到 iOS tunnel。

在 block-proxy 管理页面（端口 8003）的"隧道域名列表"中，添加需要回程到 iOS 内网的域名或 IP。
如果未配置，tunnel 虽然连接成功，但请求不会进入 tunnel 回程通道。

## TLS 说明

- 默认 `allowInsecure=true`: TLS 加密传输但不校验服务端证书链
- 适用于个人侧载场景，避免自签名证书配置
- 如需严格校验，关闭 `allowInsecure` 并确保服务端证书可信

## 已知限制

- iOS 系统强制在状态栏显示 VPN 图标（系统行为，无法关闭）
- Network Extension 内存限制约 15MB（隧道协议轻量，通常不会触发）
- WiFi/蜂窝切换时 tunnel 会短暂断开并重连（非无缝迁移）
- Extension 被系统终止后需用户手动重新启动
```

- [ ] **Step 3: Commit**

```bash
git add ios-client/TunnelExtension/TunnelLogger.swift docs/ios-client-deployment.md
git commit -m "feat(ios): add TunnelLogger and deployment documentation"
```

---

## Task 14: End-to-End Integration Test

**Files:**
- Create: `ios-client/BlockProxyTests/IntegrationTests.swift`

**Interfaces:**
- Consumes: All previous tasks
- Produces: Integration test verifying full CONNECT → CONNECT_OK → DATA → CLOSE cycle

- [ ] **Step 1: Write integration test**

`ios-client/BlockProxyTests/IntegrationTests.swift`:
```swift
import XCTest
import Network
@testable import BlockProxy

final class IntegrationTests: XCTestCase {

    /// Full cycle: mock server sends CONNECT → iOS connects target → CONNECT_OK →
    /// DATA relay → CLOSE
    func testFullReverseConnectCycle() async throws {
        // 1. Start mock target server
        let targetListener = try NWListener(using: .tcp, on: .any)
        var targetReceived = Data()
        let targetPort = try await startServer(targetListener) { conn in
            // Wait for data, echo response
            let data = try await conn.receiveAsync()
            targetReceived = data
            try await conn.sendAsync(Data([0x52, 0x45, 0x53])) // "RES"
        }

        // 2. Create ReverseConnectHandler
        var tunnelFrames: [Frame] = []
        let mockConnection = TunnelConnection(
            host: "127.0.0.1", port: 1,
            username: "u", password: "p",
            useTLS: false, allowInsecure: true
        )
        let handler = ReverseConnectHandler { _, frame in
            tunnelFrames.append(frame)
        }

        // 3. Simulate CONNECT from server
        handler.handleConnect(connection: mockConnection, reqid: 42, addr: .ipv4("127.0.0.1"), port: targetPort)

        // 4. Wait for CONNECT_OK
        try await Task.sleep(nanoseconds: 1_000_000_000)
        XCTAssertTrue(tunnelFrames.contains {
            if case .connectOK(let r) = $0 { return r == 42 }
            return false
        }, "Should send CONNECT_OK")

        // 5. Simulate DATA from server → target
        handler.handleData(reqid: 42, data: Data([0x48, 0x45, 0x4C, 0x4C, 0x4F])) // "HELLO"

        // 6. Wait for relay
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertEqual(targetReceived, Data([0x48, 0x45, 0x4C, 0x4C, 0x4F]))

        // 7. Verify target response was relayed back as DATA
        let dataFrames = tunnelFrames.compactMap { frame -> Data? in
            if case .data(let r, let d) = frame, r == 42 { return d }
            return nil
        }
        XCTAssertTrue(dataFrames.contains(Data([0x52, 0x45, 0x53])))

        // 8. Cleanup
        handler.closeSession(reqid: 42)
        targetListener.cancel()
    }

    func testDualConnectionIndependent() async throws {
        // Verify two TunnelConnections maintain independent state
        let conn1 = TunnelConnection(
            host: "127.0.0.1", port: 1,
            username: "a", password: "b",
            useTLS: false, allowInsecure: true
        )
        let conn2 = TunnelConnection(
            host: "127.0.0.1", port: 1,
            username: "a", password: "b",
            useTLS: false, allowInsecure: true
        )
        XCTAssertNotEqual(conn1.id, conn2.id)
    }

    func testReconnectBackoff() {
        // Verify backoff calculation
        var backoff: UInt64 = 1
        let values = (0..<7).map { _ -> UInt64 in
            let v = backoff
            backoff = min(backoff * 2, 60)
            return v
        }
        XCTAssertEqual(values, [1, 2, 4, 8, 16, 32, 60])
    }

    private func startServer(
        _ listener: NWListener,
        handler: @escaping (NWConnection) async throws -> Void
    ) async throws -> UInt16 {
        try await withCheckedThrowingContinuation { cont in
            listener.newConnectionHandler = { conn in
                conn.start(queue: .global())
                Task { try await handler(conn) }
            }
            listener.stateUpdateHandler = { state in
                if case .ready = state {
                    cont.resume(returning: listener.port!.rawValue)
                }
            }
            listener.start(queue: .global())
        }
    }
}
```

- [ ] **Step 2: Run tests**

```bash
cd ios-client && xcodebuild test -scheme BlockProxy -destination 'platform=iOS Simulator,name=iPhone 16'
```
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add ios-client/BlockProxyTests/IntegrationTests.swift
git commit -m "test(ios): add end-to-end integration tests for reverse CONNECT cycle"
```

---

## Task 15: On-Device Verification Checklist

These are manual verification steps that must be performed on a real iOS device. They cannot be automated.

- [ ] **Step 1: Build and install on device**

Connect iOS device, select in Xcode, build and run. Verify app launches.

- [ ] **Step 2: Verify VPN authorization**

First toggle should trigger system VPN authorization dialog. Accept it.

- [ ] **Step 3: Verify empty route table**

After VPN starts, verify Safari and other apps work normally (no traffic interception).

- [ ] **Step 4: Verify tunnel connection**

Configure a running block-proxy server. Toggle ON. Verify status shows "已连接".

- [ ] **Step 5: Verify PING/PONG**

Check server logs — should show PING/PONG exchanges with iOS client.

- [ ] **Step 6: Verify reverse CONNECT**

From an external machine, access a domain configured in `tunnel_domains` that resolves to an IP on iOS's local network. Verify the request is proxied through the tunnel.

- [ ] **Step 7: Verify dual connections**

Check server logs — should show 2 authenticated tunnel connections from iOS.

- [ ] **Step 8: Verify reconnection**

Kill the block-proxy server, wait 5 seconds, restart it. Verify iOS client auto-reconnects.

- [ ] **Step 9: Verify background survival**

Lock the device, wait 10 minutes, unlock. Verify tunnel is still connected (or auto-recovered).

- [ ] **Step 10: Verify WiFi/cellular switch**

Start on WiFi, switch to cellular. Verify tunnel reconnects within seconds.

- [ ] **Step 11: Verify auth failure display**

Configure wrong credentials, toggle ON. Verify status shows "认证失败" (not reconnecting).

- [ ] **Step 12: Commit any fixes**

If any issues were found and fixed during manual testing:
```bash
git add -A && git commit -m "fix(ios): address on-device verification findings"
```
