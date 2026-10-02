import Foundation
import Observation

/// The idle "Test audio" check: both capture tracks for a few seconds, no
/// session, nothing sent or stored, then a verdict per track. It answers
/// "will it hear this meeting?" before the meeting, which a session started
/// only to see whether it works (and then paused) answers worse.
///
/// Its own AudioCaptureManager, not the session's, and Start cancels it
/// first. Like the ship gate's self-test (CaptureSelfTest,
/// scripts/capture-selftest.sh) it plays a 7 kHz tone at -50 dBFS while it
/// listens: a process tap delivers nothing while no process makes sound
/// (gotcha #31). The tone is played by `afplay`, a separate process, because
/// the tap excludes this app's own audio (gotcha #20).
@Observable
@MainActor
final class AudioCheck {
    enum Verdict: Equatable {
        /// Non-zero audio arrived.
        case heard
        /// Buffers arrived, every sample exact zero.
        case zeros
        /// No buffers at all.
        case nothing
    }

    struct Outcome: Equatable {
        var mic: Verdict
        var meeting: Verdict
        /// Capture would not start at all (permission, device).
        var error: String? = nil

        var passed: Bool { error == nil && mic == .heard && meeting == .heard }

        /// What to do about it, one line per failing track.
        var advice: [String] {
            if let error { return ["Capture didn't start: \(error)"] }
            var lines: [String] = []
            switch mic {
            case .heard: break
            case .zeros: lines.append("Your mic sent only silence. Check Microphone access in System Settings → Privacy & Security, or pick another mic in the dashboard's Settings.")
            case .nothing: lines.append("Your mic delivered nothing. Pick another mic in the dashboard's Settings, or reconnect it.")
            }
            switch meeting {
            case .heard: break
            case .zeros: lines.append("Meeting audio came through as silence. Grant System Audio Recording in System Settings → Privacy & Security.")
            case .nothing: lines.append("No meeting audio while a test tone played. Is the Mac's output muted?")
            }
            return lines
        }
    }

    enum Phase: Equatable {
        case idle
        /// `heardMic` / `heardMeeting` tick over as each track proves itself.
        case running(heardMic: Bool, heardMeeting: Bool)
        case done(Outcome)
    }

    static let maxSeconds: Double = 20
    /// Long enough for the bars to show a few words; ends then if both are heard.
    static let minSeconds: Double = 4

    private(set) var phase: Phase = .idle
    /// The running check's capture, for the menu bar's level bars.
    private(set) var capture: AudioCaptureManager?
    private var task: Task<Void, Never>?
    private var tone: Process?
    private var toneLoop: Task<Void, Never>?

    var isRunning: Bool {
        if case .running = phase { return true }
        return false
    }

    /// The verdict from the capture counters (pure, so it is testable).
    static func outcome(micBuffers: Int, micNonZero: Int, meetingBuffers: Int, meetingNonZero: Int) -> Outcome {
        func verdict(_ buffers: Int, _ nonZero: Int) -> Verdict {
            nonZero > 0 ? .heard : buffers > 0 ? .zeros : .nothing
        }
        return Outcome(mic: verdict(micBuffers, micNonZero), meeting: verdict(meetingBuffers, meetingNonZero), error: nil)
    }

    func start() {
        guard !isRunning else { return }
        let capture = AudioCaptureManager()
        self.capture = capture
        phase = .running(heardMic: false, heardMeeting: false)
        appLog("[AudioCheck] started")
        startTone()
        task = Task { @MainActor [weak self] in
            var outcome: Outcome
            do {
                try await capture.startCapture(onChunk: { _, _, _ in }, onDeviceError: {}, onCaptureWarning: { _ in })
                let started = Date()
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    let s = capture.captureHealthSnapshot
                    let heardMic = s.micNonZero > 0, heardMeeting = s.meetingNonZero > 0
                    self?.phase = .running(heardMic: heardMic, heardMeeting: heardMeeting)
                    let elapsed = Date().timeIntervalSince(started)
                    if (heardMic && heardMeeting && elapsed >= Self.minSeconds) || elapsed >= Self.maxSeconds { break }
                }
                let s = capture.captureHealthSnapshot
                outcome = Self.outcome(micBuffers: s.micBuffers, micNonZero: s.micNonZero,
                                       meetingBuffers: s.meetingBuffers, meetingNonZero: s.meetingNonZero)
            } catch {
                outcome = Outcome(mic: .nothing, meeting: .nothing, error: error.localizedDescription)
            }
            await capture.stopCapture()
            guard let self else { return }
            self.stopTone()
            self.capture = nil
            self.task = nil
            if Task.isCancelled {
                self.phase = .idle
                return
            }
            appLog("[AudioCheck] mic=\(outcome.mic) meeting=\(outcome.meeting) error=\(outcome.error ?? "none")")
            self.phase = .done(outcome)
        }
    }

    /// Stop now (Start pressed, popover closed mid-check). Waits for capture
    /// to let go of the devices, so a session can open them next.
    func cancel() async {
        guard let task else { return }
        task.cancel()
        await task.value
        phase = .idle
    }

    /// The menu bar render test's way in (MenuBarRenderTests).
    func loadPreview(_ phase: Phase) {
        self.phase = phase
    }

    func dismissResult() {
        if case .done = phase { phase = .idle }
    }

    // MARK: Tone

    private func startTone() {
        guard let url = try? Self.toneFile() else {
            appLog("[AudioCheck] no tone file; the meeting track may read as nothing")
            return
        }
        // afplay plays one file and exits; loop it until the check ends.
        toneLoop = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/bin/afplay")
                p.arguments = [url.path]
                do { try p.run() } catch {
                    appLog("[AudioCheck] afplay failed: \(error)")
                    return
                }
                self?.tone = p
                while p.isRunning && !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 100_000_000)
                }
            }
        }
    }

    private func stopTone() {
        toneLoop?.cancel()
        toneLoop = nil
        if let tone, tone.isRunning { tone.terminate() }
        tone = nil
    }

    /// 2 s of 7 kHz at -50 dBFS, mono PCM16 (16 kHz, AudioWAV's rate; 7 kHz
    /// is under its 8 kHz limit): inaudible in practice, kept by the 16 kHz
    /// track, and non-zero on the tap. The tone scripts/capture-selftest.sh plays.
    static func toneFile() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("meeting-copilot-check-tone.wav")
        if FileManager.default.fileExists(atPath: url.path) { return url }
        let rate = 16_000, seconds = 2, freq = 7_000.0, amp = 0.003
        var pcm = Data(capacity: rate * seconds * 2)
        for i in 0..<(rate * seconds) {
            let v = Int16(amp * 32_767 * sin(2 * .pi * freq * Double(i) / Double(rate)))
            withUnsafeBytes(of: v.littleEndian) { pcm.append(contentsOf: $0) }
        }
        try AudioWAV.encode(int16PCM: pcm).write(to: url, options: .atomic)
        return url
    }
}
