import AVFoundation
import XCTest
@testable import MeetingCopilot

/// The mic engine is built and released off the main thread, and a Core Audio
/// call that never returns cannot hold the app. On 2026-10-02 the main thread
/// released the old engine during a restart, deadlocked inside Core Audio, and
/// the app froze until it was force-quit.
final class MicEngineQueueTests: XCTestCase {
    private func fakeStart() -> AudioCaptureManager.MicEngineStart {
        let engine = AVAudioEngine()
        return .init(engine: engine, pinned: nil, hardwareFormat: AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!)
    }

    func testTheEngineIsBuiltOffTheMainThread() {
        let capture = AudioCaptureManager()
        var builtOnMain: Bool?
        capture.micEngineFactory = { _ in
            builtOnMain = Thread.isMainThread
            return self.fakeStart()
        }
        let opened = expectation(description: "opened")
        capture.openMic { result in
            if case .failure(let error) = result { XCTFail("\(error)") }
            opened.fulfill()
        }
        wait(for: [opened], timeout: 2)
        XCTAssertEqual(builtOnMain, false)
    }

    func testAHungCoreAudioCallTimesOutAndTheNextOpenWorks() {
        let capture = AudioCaptureManager()
        let release = DispatchSemaphore(value: 0)
        let hung = fakeStart()
        capture.micEngineFactory = { _ in
            release.wait()  // Core Audio never answers
            return .init(engine: hung.engine, pinned: nil, hardwareFormat: hung.hardwareFormat)
        }

        // The main thread keeps running: this expectation is fulfilled on it.
        let stuck = expectation(description: "stuck open reports failure")
        capture.openMic(timeout: 0.3) { result in
            guard case .failure(AudioCaptureError.microphoneStuck) = result else {
                return XCTFail("expected microphoneStuck, got \(result)")
            }
            stuck.fulfill()
        }
        wait(for: [stuck], timeout: 2)

        // A fresh thread serves the next open while the old one is still hung.
        let good = fakeStart()
        capture.micEngineFactory = { _ in good }
        let reopened = expectation(description: "reopened")
        capture.openMic(timeout: 2) { result in
            if case .failure(let error) = result { XCTFail("\(error)") }
            reopened.fulfill()
        }
        wait(for: [reopened], timeout: 3)
        XCTAssertTrue(capture.micEngineForTesting === good.engine)

        // When the hung call finally returns, its engine is discarded.
        release.signal()
        let settled = expectation(description: "late result handled")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { settled.fulfill() }
        wait(for: [settled], timeout: 2)
        XCTAssertTrue(capture.micEngineForTesting === good.engine)
    }
}
