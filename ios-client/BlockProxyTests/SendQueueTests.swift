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
