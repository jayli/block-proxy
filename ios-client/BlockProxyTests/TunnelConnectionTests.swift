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
