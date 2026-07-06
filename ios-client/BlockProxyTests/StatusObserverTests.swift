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
