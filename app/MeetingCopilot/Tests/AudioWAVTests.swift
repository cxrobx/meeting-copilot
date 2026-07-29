import XCTest
@testable import MeetingCopilot

final class AudioWAVTests: XCTestCase {
    func testEncodesRequiredWireFormat() {
        let wav = AudioWAV.encode(float32Samples: [0, 0.5, -0.5])
        XCTAssertEqual(String(data: wav[0..<4], encoding: .ascii), "RIFF")
        XCTAssertEqual(String(data: wav[8..<12], encoding: .ascii), "WAVE")
        XCTAssertEqual(wav.count, 44 + 3 * MemoryLayout<Int16>.size)
        XCTAssertEqual(wav.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 22, as: UInt16.self) }, 1)
        XCTAssertEqual(wav.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 24, as: UInt32.self) }, 16_000)
        XCTAssertEqual(wav.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 34, as: UInt16.self) }, 16)
    }
}
