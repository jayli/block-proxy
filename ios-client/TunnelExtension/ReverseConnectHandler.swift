import Foundation
import Network

/// Manages per-reqid reverse CONNECT sessions.
/// Each session opens a TCP connection to a local target, relays data
/// bidirectionally with the tunnel, and handles CLOSE idempotently.
class ReverseConnectHandler {
    /// Callback to send a frame through the exact tunnel connection that owns a reqid.
    private let sendToTunnel: (TunnelConnection, Frame) async -> Void

    private var sessions: [UInt16: RequestSession] = [:]
    private let lock = NSLock()

    init(sendToTunnel: @escaping (TunnelConnection, Frame) async -> Void) {
        self.sendToTunnel = sendToTunnel
    }

    /// Handle a CONNECT request from the server.
    func handleConnect(connection: TunnelConnection, reqid: UInt16, addr: FrameAddress, port: UInt16) {
        Task {
            do {
                let targetConn = try await connectToTarget(
                    addr: addr, port: port, timeout: 30
                )
                let session = RequestSession(
                    tunnelConnection: connection,
                    reqid: reqid,
                    targetConnection: targetConn,
                    sendToTunnel: sendToTunnel
                )
                lock.lock()
                sessions[reqid] = session
                lock.unlock()

                // The session is registered before CONNECT_OK so immediate DATA from
                // the server can be accepted. Await send to preserve frame ordering.
                await sendToTunnel(connection, .connectOK(reqid: reqid))

                // Start bidirectional relay
                await session.startRelay()

                // Relay finished — send CLOSE if not already closed
                await session.sendCloseIfNeeded()

                lock.lock()
                sessions.removeValue(forKey: reqid)
                lock.unlock()
            } catch {
                await sendToTunnel(connection, .connectFailed(reqid: reqid))
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

    /// Close sessions owned by a disconnected tunnel connection.
    /// Must be called for every per-connection disconnect, not only on full tunnel stop.
    func closeSessions(for connection: TunnelConnection) {
        lock.lock()
        let owned = sessions.filter { _, session in
            session.tunnelConnection === connection
        }
        for reqid in owned.keys {
            sessions.removeValue(forKey: reqid)
        }
        lock.unlock()

        for session in owned.values {
            session.forceClose()
        }
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
    private let sendToTunnel: (TunnelConnection, Frame) async -> Void
    private var isClosed = false
    private let closeLock = NSLock()
    private let targetWriteQueue: SendQueue

    init(tunnelConnection: TunnelConnection, reqid: UInt16, targetConnection: NWConnection,
         sendToTunnel: @escaping (TunnelConnection, Frame) async -> Void) {
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
                    await sendToTunnel(tunnelConnection, .data(reqid: reqid, payload: chunk))
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

    func sendCloseIfNeeded() async {
        closeLock.lock()
        let wasClosed = isClosed
        isClosed = true
        closeLock.unlock()
        if !wasClosed {
            await sendToTunnel(tunnelConnection, .close(reqid: reqid))
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
