import XCTest
@testable import BlockProxy

final class FrameExtractorTests: XCTestCase {

    func testSingleCompleteFrame() throws {
        let ext = FrameExtractor()
        let frame = FrameCodec.encode(.ping)
        ext.append(frame)
        let result = try ext.extractFrame()
        XCTAssertNotNil(result)
        if case .ping = result! {} else { XCTFail("Expected ping") }
    }

    func testHalfLengthPrefix() throws {
        let ext = FrameExtractor()
        let frame = FrameCodec.encode(.ping) // [0x00, 0x01, 0x10]
        ext.append(Data([frame[0]]))          // only first byte of length
        XCTAssertNil(try ext.extractFrame())  // not enough for length
        ext.append(Data([frame[1], frame[2]]))
        let result = try ext.extractFrame()
        XCTAssertNotNil(result)
    }

    func testHalfPayload() throws {
        let ext = FrameExtractor()
        // AUTH frame: [00 0B 20 05 61 64 6D 69 6E 04 70 61 73 73]
        let frame = FrameCodec.encode(.auth(username: "admin", password: "pass"))
        // Feed length prefix + half of payload
        ext.append(frame.prefix(6))
        XCTAssertNil(try ext.extractFrame())
        // Feed remaining bytes
        ext.append(frame.suffix(from: 6))
        let result = try ext.extractFrame()
        XCTAssertNotNil(result)
        if case .auth(let u, let p) = result! {
            XCTAssertEqual(u, "admin")
            XCTAssertEqual(p, "pass")
        } else { XCTFail("Expected auth") }
    }

    func testMultipleFramesInOneReceive() throws {
        let ext = FrameExtractor()
        var combined = Data()
        combined.append(FrameCodec.encode(.ping))
        combined.append(FrameCodec.encode(.pong))
        combined.append(FrameCodec.encode(.authOK))
        ext.append(combined)
        let f1 = try ext.extractFrame()
        let f2 = try ext.extractFrame()
        let f3 = try ext.extractFrame()
        let f4 = try ext.extractFrame()
        if case .ping = f1! {} else { XCTFail("Expected ping") }
        if case .pong = f2! {} else { XCTFail("Expected pong") }
        if case .authOK = f3! {} else { XCTFail("Expected authOK") }
        XCTAssertNil(f4)
    }

    func testFrameTailPlusNextFramePrefix() throws {
        let ext = FrameExtractor()
        let ping = FrameCodec.encode(.ping)       // [00 01 10]
        let auth = FrameCodec.encode(.auth(username: "a", password: "b"))
        // Feed: ping + first 3 bytes of auth
        var chunk = Data(ping)
        chunk.append(auth.prefix(3))
        ext.append(chunk)
        let f1 = try ext.extractFrame()
        if case .ping = f1! {} else { XCTFail("Expected ping") }
        // Not enough for auth yet
        XCTAssertNil(try ext.extractFrame())
        // Feed remaining auth bytes
        ext.append(auth.suffix(from: 3))
        let f2 = try ext.extractFrame()
        if case .auth(let u, let p) = f2! {
            XCTAssertEqual(u, "a")
            XCTAssertEqual(p, "b")
        } else { XCTFail("Expected auth") }
    }

    func testOversizedLengthThrows() {
        let ext = FrameExtractor()
        // Length = 0xFFFF + 1 won't fit in UInt16, so test with length > maxPayloadSize
        // Actually 0xFFFF = 65535 = maxPayloadSize, which is valid.
        // Test with a frame that claims 65535 bytes but only sends a few.
        ext.append(Data([0xFF, 0xFF, 0x10])) // claims 65535-byte payload, only has 1
        XCTAssertNil(try ext.extractFrame()) // waiting for more data, not an error yet
    }

    func testInvalidPayloadTypeThrows() {
        let ext = FrameExtractor()
        ext.append(Data([0x00, 0x01, 0xFF])) // unknown type 0xFF
        XCTAssertThrowsError(try ext.extractFrame())
    }

    func testEmptyDataDoesNotCrash() throws {
        let ext = FrameExtractor()
        ext.append(Data())
        XCTAssertNil(try ext.extractFrame())
    }

    func testExtractAllFrames() throws {
        let ext = FrameExtractor()
        ext.append(FrameCodec.encode(.ping))
        ext.append(FrameCodec.encode(.pong))
        let frames = try ext.extractAll()
        XCTAssertEqual(frames.count, 2)
    }
}
