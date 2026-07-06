import Foundation
import Network

extension NWConnection {
    /// Connect with a timeout. Throws connectTimeout if not ready within the given duration.
    func connectAsync(timeout: TimeInterval) async throws {
        final class ResumeBox: @unchecked Sendable {
            private let lock = NSLock()
            private var didResume = false
            func resumeOnce(_ body: () -> Void) {
                lock.lock()
                defer { lock.unlock() }
                guard !didResume else { return }
                didResume = true
                body()
            }
        }

        let box = ResumeBox()
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                    self.stateUpdateHandler = { state in
                        switch state {
                        case .ready:
                            box.resumeOnce {
                                self.stateUpdateHandler = nil
                                cont.resume()
                            }
                        case .failed(let error):
                            box.resumeOnce {
                                self.stateUpdateHandler = nil
                                cont.resume(throwing: error)
                            }
                        case .cancelled:
                            box.resumeOnce {
                                self.stateUpdateHandler = nil
                                cont.resume(throwing: TunnelError.connectionClosed)
                            }
                        default:
                            break
                        }
                    }
                    self.start(queue: .global())
                }
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                self.cancel()
                throw TunnelError.connectTimeout
            }
            try await group.next()
            group.cancelAll()
        }
    }

    /// Receive data with async/await. Throws CancellationError on task cancellation.
    func receiveAsync() async throws -> Data {
        try await withCheckedThrowingContinuation { cont in
            self.receive(minimumIncompleteLength: 1, maximumLength: 65536) {
                data, _, _, error in
                if let error {
                    cont.resume(throwing: error)
                } else if let data, !data.isEmpty {
                    cont.resume(returning: data)
                } else {
                    // EOF or zero-length read
                    cont.resume(throwing: TunnelError.connectionClosed)
                }
            }
        }
    }

    /// Send data with async/await.
    func sendAsync(_ data: Data) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            self.send(content: data, completion: .contentProcessed { error in
                if let error {
                    cont.resume(throwing: error)
                } else {
                    cont.resume()
                }
            })
        }
    }
}
