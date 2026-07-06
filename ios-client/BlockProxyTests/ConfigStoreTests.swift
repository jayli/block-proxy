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
