import AVFoundation
import AppKit
import Foundation

/// `--capture-selftest <out.json>`: start both capture tracks for a few
/// seconds, write how many buffers each delivered, and exit. No server, no
/// session, nothing stored but the counts.
///
/// It has to run as the app, launched through LaunchServices
/// (`open -n … --args --capture-selftest`), so it runs under the app's own
/// signature, hardened runtime, entitlements and privacy grants. That is the
/// point: a signing or entitlement change that would leave a meeting with a
/// dead track fails here, before install (scripts/capture-selftest.sh, run by
/// ship.sh). Run from a terminal, macOS would judge the terminal's grants.
@MainActor
enum CaptureSelfTest {
    static let flag = "--capture-selftest"

    static func requestedOutput(_ arguments: [String] = CommandLine.arguments) -> URL? {
        guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
        return URL(fileURLWithPath: arguments[index + 1])
    }

    /// `--capture-selftest-seconds N` (2–120): how long to wait for both tracks
    /// before calling it a failure. The test ends as soon as both deliver.
    static func requestedSeconds(_ arguments: [String] = CommandLine.arguments) -> Double {
        guard let index = arguments.firstIndex(of: "--capture-selftest-seconds"), index + 1 < arguments.count,
              let seconds = Double(arguments[index + 1]), (2...120).contains(seconds) else { return 20 }
        return seconds
    }

    /// `--capture-selftest-meeting-signal`: the meeting track must carry sound,
    /// not just buffers (the caller plays some).
    static func requestedMeetingSignal(_ arguments: [String] = CommandLine.arguments) -> Bool {
        arguments.contains("--capture-selftest-meeting-signal")
    }

    /// Runs until the mic has delivered a non-zero buffer and the meeting track
    /// a buffer (or, with `needMeetingSignal`, a non-zero one), for at least 2 s,
    /// or until `seconds` pass, and reports how long each track took.
    ///
    /// The meeting track needs something playing: a Core Audio process tap
    /// delivers no buffers at all while no process makes sound (measured
    /// 2026-10-02: 0 buffers in 20 s silent, the first within 0.3 s once a
    /// sound played). scripts/capture-selftest.sh plays a near-silent tone.
    static func run(writingTo output: URL, seconds: Double = 20, needMeetingSignal: Bool = false) {
        let capture = AudioCaptureManager()
        appLog("[SelfTest] capture self-test, up to \(Int(seconds))s → \(output.path)")
        Task { @MainActor in
            var result: [String: Any] = [
                "micAuthorization": authorizationName(AVCaptureDevice.authorizationStatus(for: .audio)),
            ]
            var warnings: [String] = []
            do {
                try await capture.startCapture(
                    onChunk: { _, _, _ in },
                    onDeviceError: { warnings.append("mic device error") },
                    onCaptureWarning: { warnings.append($0) }
                )
                let started = Date()
                var micFirst: Double?
                var meetingFirst: Double?
                while true {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    let elapsed = Date().timeIntervalSince(started)
                    let now = capture.captureHealthSnapshot
                    if micFirst == nil, now.micNonZero > 0 { micFirst = elapsed }
                    if meetingFirst == nil, (needMeetingSignal ? now.meetingNonZero : now.meetingBuffers) > 0 {
                        meetingFirst = elapsed
                    }
                    if (micFirst != nil && meetingFirst != nil && elapsed >= 2) || elapsed >= seconds { break }
                }
                result["seconds"] = (Date().timeIntervalSince(started) * 10).rounded() / 10
                if let micFirst { result["micFirstAfter"] = (micFirst * 10).rounded() / 10 }
                if let meetingFirst { result["meetingFirstAfter"] = (meetingFirst * 10).rounded() / 10 }
                let health = capture.captureHealthSnapshot
                result["micBuffers"] = health.micBuffers
                result["micNonZero"] = health.micNonZero
                result["meetingBuffers"] = health.meetingBuffers
                result["meetingNonZero"] = health.meetingNonZero
                result["meetingBackend"] = String(describing: capture.meetingBackend)
                await capture.stopCapture()
            } catch {
                result["error"] = String(describing: error)
            }
            result["warnings"] = warnings
            let data = (try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])) ?? Data()
            try? data.write(to: output)
            appLog("[SelfTest] \(String(decoding: data, as: UTF8.self))")
            exit(0)
        }
    }

    private static func authorizationName(_ status: AVAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }
}
