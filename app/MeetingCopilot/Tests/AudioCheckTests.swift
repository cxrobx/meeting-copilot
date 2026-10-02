import XCTest
@testable import MeetingCopilot

/// The idle "Test audio" check (AudioCheck): verdicts from the capture
/// counters, and the tone that gives the process tap something to hear.
@MainActor
final class AudioCheckTests: XCTestCase {
    func testVerdictPerTrack() {
        let ok = AudioCheck.outcome(micBuffers: 40, micNonZero: 38, meetingBuffers: 40, meetingNonZero: 12)
        XCTAssertEqual(ok, AudioCheck.Outcome(mic: .heard, meeting: .heard))
        XCTAssertTrue(ok.passed)
        XCTAssertEqual(ok.advice, [])

        // A denied System Audio Recording grant: buffers, all zero (gotcha #20).
        let noGrant = AudioCheck.outcome(micBuffers: 40, micNonZero: 40, meetingBuffers: 40, meetingNonZero: 0)
        XCTAssertEqual(noGrant.meeting, .zeros)
        XCTAssertFalse(noGrant.passed)
        XCTAssertEqual(noGrant.advice.count, 1)
        XCTAssertTrue(noGrant.advice[0].contains("System Audio Recording"))

        // A dead mic and a tap that delivered nothing (output muted, #31).
        let dead = AudioCheck.outcome(micBuffers: 0, micNonZero: 0, meetingBuffers: 0, meetingNonZero: 0)
        XCTAssertEqual(dead, AudioCheck.Outcome(mic: .nothing, meeting: .nothing))
        XCTAssertEqual(dead.advice.count, 2)
    }

    func testCaptureErrorIsTheOnlyAdvice() {
        let failed = AudioCheck.Outcome(mic: .nothing, meeting: .nothing, error: "permission denied")
        XCTAssertFalse(failed.passed)
        XCTAssertEqual(failed.advice, ["Capture didn't start: permission denied"])
    }

    func testToneIsAQuietSevenKilohertzWav() throws {
        let url = try AudioCheck.toneFile()
        let data = try Data(contentsOf: url)
        XCTAssertEqual(String(decoding: data.prefix(4), as: UTF8.self), "RIFF")
        let samples = data.dropFirst(44).withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
        XCTAssertEqual(samples.count, 32_000, "2 s at 16 kHz")
        let peak = samples.map { abs(Int($0)) }.max() ?? 0
        XCTAssertGreaterThan(peak, 0, "non-zero, or the tap reads it as silence")
        XCTAssertLessThanOrEqual(peak, 100, "about -50 dBFS: inaudible in practice")
        // 7 kHz for 2 s: 14,000 cycles, about 28,000 sign changes.
        let crossings = zip(samples, samples.dropFirst()).filter { ($0 < 0) != ($1 < 0) }.count
        XCTAssertEqual(Double(crossings), 28_000, accuracy: 1_500)
    }
}
