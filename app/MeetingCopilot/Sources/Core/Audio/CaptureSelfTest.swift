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

    static func run(writingTo output: URL, seconds: Double = 5) {
        let capture = AudioCaptureManager()
        appLog("[SelfTest] capture self-test for \(seconds)s → \(output.path)")
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
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
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
