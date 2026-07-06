import Foundation

/// Per-connection receive buffer that reassembles TCP byte stream into tunnel frames.
/// Each NWConnection should own one FrameExtractor instance.
class FrameExtractor {
    private var buffer = Data()

    /// Append raw bytes received from NWConnection.receive().
    func append(_ data: Data) {
        buffer.append(data)
    }

    /// Try to extract one complete frame from the buffer.
    /// Returns nil if not enough data for a complete frame.
    /// Throws TunnelError if the frame payload is invalid.
    func extractFrame() throws -> Frame? {
        guard buffer.count >= 2 else { return nil }
        let length = Int(buffer[0]) << 8 | Int(buffer[1])
        guard length <= FrameCodec.maxPayloadSize else {
            throw TunnelError.frameTooLarge
        }
        let totalLen = 2 + length
        guard buffer.count >= totalLen else { return nil }
        let payload = buffer.subdata(in: 2..<totalLen)
        buffer.removeSubrange(0..<totalLen)
        return try FrameCodec.decodePayload(payload)
    }

    /// Extract all available frames from the buffer.
    func extractAll() throws -> [Frame] {
        var frames: [Frame] = []
        while let frame = try extractFrame() {
            frames.append(frame)
        }
        return frames
    }

    var bufferedBytes: Int { buffer.count }
}
