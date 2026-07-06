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
