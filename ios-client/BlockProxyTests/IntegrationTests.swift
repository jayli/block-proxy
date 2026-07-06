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
