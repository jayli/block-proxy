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
    /// The timeout deadline starts when waiting for the next complete frame.
    /// Partial receives do not reset it.
    private func receiveWithIdleTimeout(
        connection: NWConnection,
        timeout: TimeInterval
    ) async throws -> Frame {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0 else { throw TunnelError.idleTimeout }

            let data: Data = try await withThrowingTaskGroup(of: Data.self) { group in
                group.addTask {
                    try await connection.receiveAsync()
                }
                group.addTask {
                    try await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
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
