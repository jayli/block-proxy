import Foundation

/// Serializes frame sends on a single NWConnection to guarantee wire order.
/// All frames (CONNECT_OK, DATA, CLOSE, PONG, etc.) pass through this queue.
actor SendQueue {
    private let sender: (Data) async throws -> Void
    private var isRunning = false
    private var pending: [Data] = []

    /// - Parameter sender: closure that performs the actual send (e.g. NWConnection.sendAsync)
    init(sender: @escaping (Data) async throws -> Void) {
        self.sender = sender
    }

    func enqueue(_ frameData: Data) {
        pending.append(frameData)
        if !isRunning {
            isRunning = true
            Task { await self.drain() }
        }
    }

    private func drain() async {
        while !pending.isEmpty {
            let data = pending.removeFirst()
            do {
                try await sender(data)
            } catch {
                // Send failed — drop remaining queue to avoid cascading errors
                pending.removeAll()
                isRunning = false
                return
            }
        }
        isRunning = false
    }

    func cancel() {
        pending.removeAll()
        isRunning = false
    }
}
