import Foundation
import Network

/// Manages 1–2 tunnel connections to the block-proxy server.
/// Handles reconnection with exponential backoff and connection replenishment.
actor ConnectionRegistry {
    private var connections: [UInt32: TunnelConnection] = [:]

    func add(_ connection: TunnelConnection) {
        connections[connection.id] = connection
    }

    func remove(id: UInt32) {
        connections.removeValue(forKey: id)
    }

    func isEmpty() -> Bool {
        connections.isEmpty
    }

    func snapshot() -> [TunnelConnection] {
        Array(connections.values)
    }

    func removeAll() -> [TunnelConnection] {
        let all = Array(connections.values)
        connections.removeAll()
        return all
    }
}

class TunnelClient {
    private let config: ServerConfig
    private let credentials: TunnelCredentials
    private let registry = ConnectionRegistry()
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
    /// Callback when a tunnel connection drops; used to close only sessions bound to that connection.
    var onConnectionDisconnect: ((TunnelConnection) -> Void)?

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
        let allConns = await registry.removeAll()
        for conn in allConns {
            conn.close()
        }
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
        await registry.add(conn1)
        onStatusChange?(.connected, "")
        Task { await conn1.receiveLoop() }

        // Try second connection (best-effort)
        Task {
            do {
                let conn2 = try await createAndAuthConnection()
                await registry.add(conn2)
                Task { await conn2.receiveLoop() }
            } catch {
                // Second connection failure is not fatal
            }
        }

        // Stay in this serve cycle until all tunnel connections are gone.
        while isRunning && !Task.isCancelled {
            if await registry.isEmpty() { throw TunnelError.connectionClosed }
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
        Task {
            await registry.remove(id: connection.id)
            onConnectionDisconnect?(connection)

            if await registry.isEmpty() {
                onStatusChange?(.disconnected, "")
            } else {
                // Try to replenish the lost connection
                for attempt in 1...3 {
                    do {
                        let conn = try await createAndAuthConnection()
                        await registry.add(conn)
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
