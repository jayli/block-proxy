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
