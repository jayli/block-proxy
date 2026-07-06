import Foundation

enum FrameType: UInt8 {
    case connect = 0x01, data = 0x02, close = 0x03, connectOK = 0x04
    case ping = 0x10, pong = 0x11
    case auth = 0x20, authOK = 0x21, authFail = 0x22, error = 0x23
    case connectFailed = 0x81
}

enum AddressType: UInt8 {
    case ipv4 = 0x01, domain = 0x03, ipv6 = 0x04
}

enum TunnelError: Error {
    case invalidFrame, frameTooLarge, authFailed, tunnelOccupied
    case connectTimeout, idleTimeout, connectionClosed
    case invalidAddressType, sendFailed
}

enum Frame: Equatable {
    case connect(reqid: UInt16, addr: FrameAddress, port: UInt16)
    case data(reqid: UInt16, payload: Data)
    case close(reqid: UInt16)
    case connectOK(reqid: UInt16)
    case connectFailed(reqid: UInt16)
    case ping
    case pong
    case auth(username: String, password: String)
    case authOK
    case authFail
    case error(message: String)
}

enum FrameAddress: Equatable {
    case ipv4(String)
    case domain(String)
    case ipv6(String)

    var displayString: String {
        switch self {
        case .ipv4(let ip):    return ip
        case .domain(let host): return host
        case .ipv6(let ip):    return ip
        }
    }
}

enum FrameCodec {
    static let maxPayloadSize = 65535
    static let dataHeaderLen = 3  // type(1) + reqid(2)
    static let maxDataChunk = maxPayloadSize - dataHeaderLen  // 65532

    // MARK: - Encode

    static func encode(_ frame: Frame) -> Data {
        // Convenience wrapper for tests and known-safe frames.
        // Production send paths call encodeChecked(_:) and handle errors.
        let payload = try! encodePayloadChecked(frame)
        var result = Data(capacity: 2 + payload.count)
        let length = UInt16(payload.count)
        result.append(UInt8(length >> 8))
        result.append(UInt8(length & 0xFF))
        result.append(payload)
        return result
    }

    /// Encode with size validation — throws if DATA payload exceeds maxDataChunk.
    static func encodeChecked(_ frame: Frame) throws -> Data {
        let payload = try encodePayloadChecked(frame)
        guard payload.count <= maxPayloadSize else {
            throw TunnelError.frameTooLarge
        }
        var result = Data(capacity: 2 + payload.count)
        let length = UInt16(payload.count)
        result.append(UInt8(length >> 8))
        result.append(UInt8(length & 0xFF))
        result.append(payload)
        return result
    }

    private static func encodePayloadChecked(_ frame: Frame) throws -> Data {
        switch frame {
        case .connect(let reqid, let addr, let port):
            var d = Data([FrameType.connect.rawValue])
            d.append(UInt8(reqid >> 8)); d.append(UInt8(reqid & 0xFF))
            switch addr {
            case .ipv4(let ip):
                d.append(AddressType.ipv4.rawValue)
                let parts = ip.split(separator: ".").compactMap { UInt8($0) }
                guard parts.count == 4 else { throw TunnelError.invalidAddressType }
                d.append(contentsOf: parts)
            case .domain(let host):
                d.append(AddressType.domain.rawValue)
                let hostBytes = Array(host.utf8)
                guard hostBytes.count <= 255 else { throw TunnelError.frameTooLarge }
                d.append(UInt8(hostBytes.count))
                d.append(contentsOf: hostBytes)
            case .ipv6(let ip):
                d.append(AddressType.ipv6.rawValue)
                d.append(contentsOf: ipv6ToBytes(ip))
            }
            d.append(UInt8(port >> 8)); d.append(UInt8(port & 0xFF))
            return d

        case .data(let reqid, let payload):
            guard payload.count <= maxDataChunk else { throw TunnelError.frameTooLarge }
            var d = Data(capacity: 3 + payload.count)
            d.append(FrameType.data.rawValue)
            d.append(UInt8(reqid >> 8)); d.append(UInt8(reqid & 0xFF))
            d.append(payload)
            return d

        case .close(let reqid):
            return Data([FrameType.close.rawValue,
                         UInt8(reqid >> 8), UInt8(reqid & 0xFF)])

        case .connectOK(let reqid):
            return Data([FrameType.connectOK.rawValue,
                         UInt8(reqid >> 8), UInt8(reqid & 0xFF)])

        case .connectFailed(let reqid):
            return Data([FrameType.connectFailed.rawValue,
                         UInt8(reqid >> 8), UInt8(reqid & 0xFF)])

        case .ping:
            return Data([FrameType.ping.rawValue])

        case .pong:
            return Data([FrameType.pong.rawValue])

        case .auth(let username, let password):
            let uBytes = Array(username.utf8)
            let pBytes = Array(password.utf8)
            guard uBytes.count <= 255, pBytes.count <= 255 else {
                throw TunnelError.frameTooLarge
            }
            var d = Data(capacity: 1 + 1 + uBytes.count + 1 + pBytes.count)
            d.append(FrameType.auth.rawValue)
            d.append(UInt8(uBytes.count))
            d.append(contentsOf: uBytes)
            d.append(UInt8(pBytes.count))
            d.append(contentsOf: pBytes)
            return d

        case .authOK:
            return Data([FrameType.authOK.rawValue])

        case .authFail:
            return Data([FrameType.authFail.rawValue])

        case .error(let message):
            let mBytes = Array(message.utf8)
            guard mBytes.count <= 255 else { throw TunnelError.frameTooLarge }
            var d = Data(capacity: 2 + mBytes.count)
            d.append(FrameType.error.rawValue)
            d.append(UInt8(mBytes.count))
            d.append(contentsOf: mBytes)
            return d
        }
    }

    // MARK: - Decode

    /// Decode a frame from a buffer that includes the 2-byte length prefix.
    static func decode(from data: Data) throws -> Frame {
        guard data.count >= 2 else { throw TunnelError.invalidFrame }
        let length = Int(data[0]) << 8 | Int(data[1])
        guard data.count >= 2 + length else { throw TunnelError.invalidFrame }
        guard length <= maxPayloadSize else { throw TunnelError.frameTooLarge }
        let payload = data.subdata(in: 2..<(2 + length))
        return try decodePayload(payload)
    }

    static func decodePayload(_ payload: Data) throws -> Frame {
        guard !payload.isEmpty else { throw TunnelError.invalidFrame }
        guard let type = FrameType(rawValue: payload[0]) else {
            throw TunnelError.invalidFrame
        }
        switch type {
        case .ping:     return .ping
        case .pong:     return .pong
        case .authOK:   return .authOK
        case .authFail: return .authFail

        case .auth:
            guard payload.count >= 2 else { throw TunnelError.invalidFrame }
            let uLen = Int(payload[1])
            guard payload.count >= 2 + uLen + 1 else { throw TunnelError.invalidFrame }
            let username = String(data: payload.subdata(in: 2..<(2 + uLen)), encoding: .utf8) ?? ""
            let pLen = Int(payload[2 + uLen])
            let pStart = 3 + uLen
            guard payload.count >= pStart + pLen else { throw TunnelError.invalidFrame }
            let password = String(data: payload.subdata(in: pStart..<(pStart + pLen)), encoding: .utf8) ?? ""
            return .auth(username: username, password: password)

        case .connect:
            guard payload.count >= 4 else { throw TunnelError.invalidFrame }
            let reqid = UInt16(payload[1]) << 8 | UInt16(payload[2])
            guard let atyp = AddressType(rawValue: payload[3]) else {
                throw TunnelError.invalidAddressType
            }
            let (addr, port) = try decodeAddress(payload: payload, atyp: atyp, offset: 4)
            return .connect(reqid: reqid, addr: addr, port: port)

        case .data:
            guard payload.count >= 3 else { throw TunnelError.invalidFrame }
            let reqid = UInt16(payload[1]) << 8 | UInt16(payload[2])
            let data = payload.subdata(in: 3..<payload.count)
            return .data(reqid: reqid, payload: data)

        case .close:
            guard payload.count >= 3 else { throw TunnelError.invalidFrame }
            let reqid = UInt16(payload[1]) << 8 | UInt16(payload[2])
            return .close(reqid: reqid)

        case .connectOK:
            guard payload.count >= 3 else { throw TunnelError.invalidFrame }
            let reqid = UInt16(payload[1]) << 8 | UInt16(payload[2])
            return .connectOK(reqid: reqid)

        case .connectFailed:
            guard payload.count >= 3 else { throw TunnelError.invalidFrame }
            let reqid = UInt16(payload[1]) << 8 | UInt16(payload[2])
            return .connectFailed(reqid: reqid)

        case .error:
            guard payload.count >= 2 else { throw TunnelError.invalidFrame }
            let msgLen = Int(payload[1])
            guard payload.count >= 2 + msgLen else { throw TunnelError.invalidFrame }
            let msg = String(data: payload.subdata(in: 2..<(2 + msgLen)), encoding: .utf8) ?? ""
            return .error(message: msg)
        }
    }

    private static func decodeAddress(payload: Data, atyp: AddressType, offset: Int)
        throws -> (FrameAddress, UInt16)
    {
        switch atyp {
        case .ipv4:
            let end = offset + 4
            guard payload.count >= end + 2 else { throw TunnelError.invalidFrame }
            let ip = "\(payload[offset]).\(payload[offset+1]).\(payload[offset+2]).\(payload[offset+3])"
            let port = UInt16(payload[end]) << 8 | UInt16(payload[end+1])
            return (.ipv4(ip), port)
        case .domain:
            guard payload.count > offset else { throw TunnelError.invalidFrame }
            let len = Int(payload[offset])
            let end = offset + 1 + len
            guard payload.count >= end + 2 else { throw TunnelError.invalidFrame }
            let host = String(data: payload.subdata(in: (offset+1)..<end), encoding: .utf8) ?? ""
            let port = UInt16(payload[end]) << 8 | UInt16(payload[end+1])
            return (.domain(host), port)
        case .ipv6:
            let end = offset + 16
            guard payload.count >= end + 2 else { throw TunnelError.invalidFrame }
            // Format as standard IPv6 string
            var parts: [String] = []
            for i in stride(from: offset, to: end, by: 2) {
                parts.append(String(format: "%02x%02x", payload[i], payload[i+1]))
            }
            let ip = parts.joined(separator: ":")
            let port = UInt16(payload[end]) << 8 | UInt16(payload[end+1])
            return (.ipv6(ip), port)
        }
    }

    private static func ipv6ToBytes(_ ip: String) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: 16)
        let parts = ip.split(separator: ":")
        for (i, part) in parts.enumerated() where i < 8 {
            if let val = UInt16(part, radix: 16) {
                bytes[i * 2] = UInt8(val >> 8)
                bytes[i * 2 + 1] = UInt8(val & 0xFF)
            }
        }
        return bytes
    }
}
