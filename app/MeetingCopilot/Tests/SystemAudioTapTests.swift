import XCTest
@testable import MeetingCopilot

/// Covers the process-tap meeting backend's pure decisions (gotcha #20).
///
/// Regression target: phone calls handed off from an iPhone, where the other
/// side is played by `avconferenced` — invisible to ScreenCaptureKit — so the
/// meeting track was silent. The live-audio path itself needs a real call and
/// the System Audio Recording grant; these pin the logic around it.
@available(macOS 14.2, *)
final class SystemAudioTapTests: XCTestCase {

    // MARK: - Sample-rate snapping

    func testMeasuredRatesSnapToTheHardwareRateTheyCameFrom() {
        // One-second windows land a callback or two off the true rate.
        XCTAssertEqual(SystemAudioTap.nearestStandardRate(to: 47_616), 48_000)
        XCTAssertEqual(SystemAudioTap.nearestStandardRate(to: 44_032), 44_100)
        // AirPods in call (HFP) mode.
        XCTAssertEqual(SystemAudioTap.nearestStandardRate(to: 24_064), 24_000)
        XCTAssertEqual(SystemAudioTap.nearestStandardRate(to: 15_872), 16_000)
    }

    // MARK: - Mismatch threshold

    func testCallbackJitterIsNotAMismatch() {
        // 512-frame callbacks make a 1 s window read ~1% off; never resample on that.
        XCTAssertFalse(SystemAudioTap.isRateMismatch(measured: 47_616, expected: 48_000))
        XCTAssertFalse(SystemAudioTap.isRateMismatch(measured: 44_544, expected: 48_000))
    }

    func testAirPodsCallRateSwitchIsAMismatch() {
        // 48 kHz reported, call audio actually arriving at 24 kHz or 16 kHz.
        XCTAssertTrue(SystemAudioTap.isRateMismatch(measured: 24_000, expected: 48_000))
        XCTAssertTrue(SystemAudioTap.isRateMismatch(measured: 16_000, expected: 48_000))
        // Smallest real switch, 48 → 32 kHz, still clears the threshold.
        XCTAssertTrue(SystemAudioTap.isRateMismatch(measured: 32_000, expected: 48_000))
    }

    func testUnknownExpectedRateAlwaysCountsAsMismatch() {
        XCTAssertTrue(SystemAudioTap.isRateMismatch(measured: 48_000, expected: 0))
    }

    // MARK: - Silence warning wording

    func testTapSilenceWarningPointsAtThePermissionNotRouting() {
        // A denied tap returns zeros with noErr, and the tap hears every
        // process whatever the output device — so blaming routing would send
        // the user the wrong way.
        let message = AudioCaptureManager.meetingSilenceWarning(outputDevice: "BlackHole 2ch", backend: .processTap)
        XCTAssertTrue(message.contains("System Audio Recording"))
        XCTAssertFalse(message.contains("virtual device"))
    }

    func testScreenCaptureKitSilenceWarningKeepsTheRoutingDiagnosis() {
        let message = AudioCaptureManager.meetingSilenceWarning(outputDevice: "BlackHole 2ch", backend: .screenCaptureKit)
        XCTAssertTrue(message.contains("ScreenCaptureKit"))
        XCTAssertTrue(message.contains("virtual device"))
    }

    // MARK: - Backend setting

    func testProcessTapIsTheDefaultBackend() throws {
        // Only meaningful when no override is set in the test environment.
        guard ProcessInfo.processInfo.environment["MC_MEETING_AUDIO"] == nil,
              UserDefaults.standard.object(forKey: "meetingAudioSource") == nil else {
            throw XCTSkip("meetingAudioSource is overridden in this environment")
        }
        XCTAssertEqual(AppSettings.meetingAudioSource, .processTap)
    }
}
