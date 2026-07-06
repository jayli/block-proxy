import XCTest
@testable import BlockProxy

final class FrameCodecTests: XCTestCase {

    // MARK: - Encode tests with Python cross-validation

    func testEncodePing() {
        let data = FrameCodec.encode(.ping)
        // Python: encode_frame(0x10) → b'\x00\x01\x10'
        XCTAssertEqual(data, Data([0x00, 0x01, 0x10]))
    }

    func testEncodePong() {
        let data = FrameCodec.encode(.pong)
        XCTAssertEqual(data, Data([0x00, 0x01, 0x11]))
    }

    func testEncodeAuth() {
        let data = FrameCodec.encode(.auth(username: "admin", password: "pass"))
        // Python: encode_frame(0x20, username=b'admin', password=b'pass')
        // → b'\x00\x0b\x20\x05admin\x04pass'
        XCTAssertEqual(data, Data([
            0x00, 0x0B, 0x20,
            0x05, 0x61, 0x64, 0x6D, 0x69, 0x6E,
            0x04, 0x70, 0x61, 0x73, 0x73
        ]))
    }

    func testEncodeConnectOK() {
        let data = FrameCodec.encode(.connectOK(reqid: 1))
        // payload: [0x04, 0x00, 0x01] → length 3
        XCTAssertEqual(data, Data([0x00, 0x03, 0x04, 0x00, 0x01]))
    }

    func testEncodeConnectFailed() {
        let data = FrameCodec.encode(.connectFailed(reqid: 0x7FFF))
        XCTAssertEqual(data, Data([0x00, 0x03, 0x81, 0x7F, 0xFF]))
    }

    func testEncodeClose() {
        let data = FrameCodec.encode(.close(reqid: 256))
        XCTAssertEqual(data, Data([0x00, 0x03, 0x03, 0x01, 0x00]))
    }

    func testEncodeData() {
        let payload = Data([0x41, 0x42]) // "AB"
        let data = FrameCodec.encode(.data(reqid: 1, payload: payload))
        // payload: [0x02, 0x00, 0x01, 0x41, 0x42] → length 5
        XCTAssertEqual(data, Data([0x00, 0x05, 0x02, 0x00, 0x01, 0x41, 0x42]))
    }

    func testEncodeConnectDomain() {
        let data = FrameCodec.encode(.connect(reqid: 1, addr: .domain("example.com"), port: 8080))
        // [type=01][reqid=00 01][atyp=03][len=0B][example.com][port=1F 90]
        // payload length = 1+2+1+1+11+2 = 18
        var expected = Data([0x00, 0x12, 0x01, 0x00, 0x01, 0x03, 0x0B])
        expected.append(contentsOf: "example.com".utf8)
        expected.append(contentsOf: [0x1F, 0x90])
        XCTAssertEqual(data, expected)
    }

    func testEncodeConnectIPv4() {
        let data = FrameCodec.encode(.connect(
            reqid: 2, addr: .ipv4("192.168.1.1"), port: 443))
        // [01][00 02][01][C0 A8 01 01][01 BB]
        // payload length = 1+2+1+4+2 = 10
        XCTAssertEqual(data, Data([
            0x00, 0x0A, 0x01, 0x00, 0x02, 0x01,
            0xC0, 0xA8, 0x01, 0x01,
            0x01, 0xBB
        ]))
    }

    func testEncodeError() {
        let data = FrameCodec.encode(.error(message: "fail"))
        // [23][04][fail] → length 6
        var expected = Data([0x00, 0x06, 0x23, 0x04])
        expected.append(contentsOf: "fail".utf8)
        XCTAssertEqual(data, expected)
    }

    func testEncodeMaxDataChunk() {
        let payload = Data(repeating: 0xAA, count: 65532)
        let data = FrameCodec.encode(.data(reqid: 1, payload: payload))
        // length prefix = 65535 (0xFFFF)
        XCTAssertEqual(data.count, 2 + 65535)
        XCTAssertEqual(data[0], 0xFF)
        XCTAssertEqual(data[1], 0xFF)
    }

    func testEncodeDataExceedingMaxThrows() {
        let payload = Data(repeating: 0xAA, count: 65533)
        XCTAssertThrowsError(try FrameCodec.encodeChecked(.data(reqid: 1, payload: payload)))
    }

    func testEncodeRejectsTooLongAuthFields() {
        let username = String(repeating: "a", count: 256)
        XCTAssertThrowsError(try FrameCodec.encodeChecked(.auth(username: username, password: "p")))
    }

    func testEncodeRejectsInvalidIPv4() {
        XCTAssertThrowsError(try FrameCodec.encodeChecked(.connect(
            reqid: 1, addr: .ipv4("192.168.1"), port: 80)))
        XCTAssertThrowsError(try FrameCodec.encodeChecked(.connect(
            reqid: 1, addr: .ipv4("192.168.1.999"), port: 80)))
    }

    // MARK: - Decode tests

    func testDecodePing() throws {
        let frame = try FrameCodec.decode(from: Data([0x00, 0x01, 0x10]))
        if case .ping = frame {} else { XCTFail("Expected ping") }
    }

    func testDecodeAuth() throws {
        let data = Data([0x00, 0x0B, 0x20,
                         0x05, 0x61, 0x64, 0x6D, 0x69, 0x6E,
                         0x04, 0x70, 0x61, 0x73, 0x73])
        let frame = try FrameCodec.decode(from: data)
        if case .auth(let u, let p) = frame {
            XCTAssertEqual(u, "admin")
            XCTAssertEqual(p, "pass")
        } else { XCTFail("Expected auth") }
    }

    func testDecodeConnectDomain() throws {
        var data = Data([0x00, 0x12, 0x01, 0x00, 0x01, 0x03, 0x0B])
        data.append(contentsOf: "example.com".utf8)
        data.append(contentsOf: [0x1F, 0x90])
        let frame = try FrameCodec.decode(from: data)
        if case .connect(let reqid, let addr, let port) = frame {
            XCTAssertEqual(reqid, 1)
            XCTAssertEqual(port, 8080)
            if case .domain(let host) = addr {
                XCTAssertEqual(host, "example.com")
            } else { XCTFail("Expected domain address") }
        } else { XCTFail("Expected connect") }
    }

    func testDecodeConnectIPv4() throws {
        let data = Data([0x00, 0x0A, 0x01, 0x00, 0x02, 0x01,
                         0xC0, 0xA8, 0x01, 0x01, 0x01, 0xBB])
        let frame = try FrameCodec.decode(from: data)
        if case .connect(let reqid, let addr, let port) = frame {
            XCTAssertEqual(reqid, 2)
            XCTAssertEqual(port, 443)
            if case .ipv4(let ip) = addr {
                XCTAssertEqual(ip, "192.168.1.1")
            } else { XCTFail("Expected IPv4") }
        } else { XCTFail("Expected connect") }
    }

    func testDecodeData() throws {
        let data = Data([0x00, 0x05, 0x02, 0x00, 0x01, 0x41, 0x42])
        let frame = try FrameCodec.decode(from: data)
        if case .data(let reqid, let payload) = frame {
            XCTAssertEqual(reqid, 1)
            XCTAssertEqual(payload, Data([0x41, 0x42]))
        } else { XCTFail("Expected data") }
    }

    func testDecodeEmptyData() throws {
        let data = Data([0x00, 0x03, 0x02, 0x00, 0x01])
        let frame = try FrameCodec.decode(from: data)
        if case .data(let reqid, let payload) = frame {
            XCTAssertEqual(reqid, 1)
            XCTAssertEqual(payload, Data())
        } else { XCTFail("Expected data") }
    }

    func testDecodeClose() throws {
        let data = Data([0x00, 0x03, 0x03, 0x01, 0x00])
        let frame = try FrameCodec.decode(from: data)
        if case .close(let reqid) = frame {
            XCTAssertEqual(reqid, 256)
        } else { XCTFail("Expected close") }
    }

    func testDecodeError() throws {
        var data = Data([0x00, 0x06, 0x23, 0x04])
        data.append(contentsOf: "fail".utf8)
        let frame = try FrameCodec.decode(from: data)
        if case .error(let msg) = frame {
            XCTAssertEqual(msg, "fail")
        } else { XCTFail("Expected error") }
    }

    func testDecodeUnknownTypeThrows() {
        let data = Data([0x00, 0x01, 0xFF])
        XCTAssertThrowsError(try FrameCodec.decode(from: data))
    }

    // MARK: - Roundtrip

    func testRoundtripAllTypes() throws {
        let frames: [Frame] = [
            .ping, .pong, .authOK, .authFail,
            .auth(username: "user", password: "pw"),
            .connect(reqid: 42, addr: .domain("test.local"), port: 80),
            .connect(reqid: 43, addr: .ipv4("10.0.0.1"), port: 443),
            .data(reqid: 1, payload: Data(repeating: 0xBB, count: 1000)),
            .close(reqid: 99),
            .connectOK(reqid: 99),
            .connectFailed(reqid: 99),
            .error(message: "test error"),
        ]
        for original in frames {
            let encoded = FrameCodec.encode(original)
            let decoded = try FrameCodec.decode(from: encoded)
            XCTAssertEqual(original, decoded, "Roundtrip failed for \(original)")
        }
    }

    func testMaxUsernameLength() throws {
        let username = String(repeating: "a", count: 255)
        let password = String(repeating: "b", count: 255)
        let encoded = FrameCodec.encode(.auth(username: username, password: password))
        let decoded = try FrameCodec.decode(from: encoded)
        if case .auth(let u, let p) = decoded {
            XCTAssertEqual(u.count, 255)
            XCTAssertEqual(p.count, 255)
        } else { XCTFail("Expected auth") }
    }
}
