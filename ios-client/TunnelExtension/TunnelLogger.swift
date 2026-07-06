import Foundation

class TunnelLogger {
    static let shared = TunnelLogger()

    private let logURL: URL?
    private var fileHandle: FileHandle?
    private let lock = NSLock()
    private let maxBytes: UInt64 = 1_048_576
    private let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        return f
    }()

    private init() {
        guard let containerURL = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: "group.com.blockproxy")
        else {
            logURL = nil
            fileHandle = nil
            return
        }
        let logURL = containerURL.appendingPathComponent("tunnel.log")
        self.logURL = logURL
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        fileHandle = try? FileHandle(forWritingTo: logURL)
        fileHandle?.seekToEndOfFile()
    }

    func log(_ message: String, level: String = "INFO") {
        lock.lock()
        defer { lock.unlock() }
        rotateIfNeeded()
        let timestamp = dateFormatter.string(from: Date())
        let line = "[\(timestamp)] [\(level)] \(message)\n"
        fileHandle?.write(line.data(using: .utf8)!)
    }

    private func rotateIfNeeded() {
        guard let logURL else { return }
        let size = (try? FileManager.default
            .attributesOfItem(atPath: logURL.path)[.size] as? UInt64) ?? 0
        guard size >= maxBytes else { return }

        fileHandle?.closeFile()
        let oldURL = logURL.appendingPathExtension("old")
        try? FileManager.default.removeItem(at: oldURL)
        try? FileManager.default.moveItem(at: logURL, to: oldURL)
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        fileHandle = try? FileHandle(forWritingTo: logURL)
    }

    func error(_ message: String) { log(message, level: "ERROR") }
    func warn(_ message: String)  { log(message, level: "WARN") }
    func debug(_ message: String) { log(message, level: "DEBUG") }
}
