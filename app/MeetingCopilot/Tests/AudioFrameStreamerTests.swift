import XCTest
@testable import MeetingCopilot

final class AudioFrameStreamerTests: XCTestCase {
    func testCutsExact100msFramesWithSourceTagAndCarriesTheRemainder() {
        var frames: [Data] = []
        let streamer = AudioFrameStreamer { frames.append($0) }

        // 1.5 frames of mic audio, then the other half: two whole frames total.
        streamer.append(Data(repeating: 0xAB, count: 4_800), source: .mic)
        XCTAssertEqual(frames.count, 1)
        streamer.append(Data(repeating: 0xCD, count: 1_600), source: .mic)
        XCTAssertEqual(frames.count, 2)

        for frame in frames {
            XCTAssertEqual(frame.count, 1 + AudioFrameStreamer.frameBytes)
            XCTAssertEqual(frame.first, AudioFrameStreamer.micTag)
        }
        // The carried half-frame comes out first, in order.
        let second = frames[1]
        XCTAssertEqual(second[second.startIndex + 1], 0xAB)
        XCTAssertEqual(second[second.startIndex + 1_600], 0xAB)
        XCTAssertEqual(second[second.startIndex + 1_601], 0xCD)
    }

    func testSourcesAreBufferedSeparately() {
        var frames: [Data] = []
        let streamer = AudioFrameStreamer { frames.append($0) }
        streamer.append(Data(count: 2_000), source: .mic)
        streamer.append(Data(count: 2_000), source: .meeting)
        XCTAssertTrue(frames.isEmpty, "neither source has a whole frame yet")
        streamer.append(Data(count: 1_200), source: .meeting)
        XCTAssertEqual(frames.map { $0.first }, [AudioFrameStreamer.meetingTag])
    }

    func testResetDropsPartialFrames() {
        var frames: [Data] = []
        let streamer = AudioFrameStreamer { frames.append($0) }
        streamer.append(Data(count: 3_000), source: .mic)
        streamer.reset()
        streamer.append(Data(count: 3_000), source: .mic)
        XCTAssertTrue(frames.isEmpty)
    }
}
