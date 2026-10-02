import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import CoreAudio
import CoreGraphics
import AppKit
import ObjCExceptionBridge

// MARK: - Audio Chunk Metadata

/// Metadata attached to every emitted audio chunk so the server can measure
/// true end-to-end latency (`captureEndedAt → transcript.broadcast`) and
/// detect out-of-order delivery. Emitted alongside the WAV buffer.
///
/// `isContinuation` is true when the emitter is carrying audio shared with
/// the previous chunk — always true for fixed-timer overlap (every chunk
/// after the first), true for the VAD path only when a continuous
/// speaker hit the 6s cap and we carried 500 ms forward. Server-side
/// dedup runs only on continuation chunks so legitimate repeated
/// phrases across non-adjacent utterances aren't mis-trimmed.
struct AudioChunkMeta: Sendable {
    let chunkId: String = UUID().uuidString
    let audioDurationSec: Double
    let captureStartedAt: Date
    let captureEndedAt: Date
    let sequence: Int
    let isContinuation: Bool
}

// MARK: - Audio Capture Manager

/// Manages both system audio (via ScreenCaptureKit) and microphone audio (via AVAudioEngine).
/// Produces 16kHz mono PCM chunks (4s with 1s overlap post-v2), base64-encoded for WebSocket transport.
@Observable
final class AudioCaptureManager: NSObject {
    // MARK: - Configuration

    static let sampleRate: Int = 16_000
    static let channelCount: Int = 1
    static let bitsPerSample: Int = 16
    // Must stay in lockstep with server/src/audio/chunkConfig.ts constants.
    // Shorter = lower perceived latency (timer fires every
    // chunkDurationSeconds - chunkOverlapSeconds).
    static let chunkDurationSeconds: TimeInterval = 4.0
    static let chunkOverlapSeconds: TimeInterval = 1.0

    // MARK: - Published State

    var isCapturing: Bool = false
    var currentOutputDevice: String = "Unknown"
    var currentInputDevice: String = "Unknown"
    /// The device the mic engine was pinned to (`MicDevicePicker`), or nil
    /// when it follows the system default input.
    private var pinnedMic: MicDevicePicker.InputDevice?
    var audioLevel: Float = 0.0
    /// Per-track peaks for the menu bar's level bars (see `LevelMeter`).
    let levelMeter = LevelMeter()

    // MARK: - Private State

    private var scStream: SCStream?
    private var systemAudioDelegate: SystemAudioDelegate?
    // `SystemAudioTap` is macOS 14.2+ and stored properties cannot carry
    // `@available`, so it is held type-erased and cast inside availability checks.
    private var systemTap: AnyObject?
    private var pendingTapRestart: DispatchWorkItem?
    /// Which backend is feeding the meeting track this session. Drives the
    /// silence-warning wording and whether output-device changes rebuild the tap.
    private(set) var meetingBackend: AppSettings.MeetingAudioSource = .screenCaptureKit
    // Per-second meeting peak log state. Touched only from whichever capture
    // thread is live (SCK sample queue or the tap's IO queue) — one at a time.
    // Ignored by Observation: they change ~90×/s on an audio thread.
    @ObservationIgnored private var meetingPeakWindow: Float = 0.0
    @ObservationIgnored private var meetingPeakLastFlush = Date()
    private var audioEngine: AVAudioEngine?
    private var audioConverter: AVAudioConverter?
    private var routeObserver: AudioRouteObserver?

    private var micPCMBuffer = Data()
    private var meetingPCMBuffer = Data()
    // Wall-clock timestamp of the oldest sample currently sitting in each
    // buffer. Updated on append (only when the buffer was empty) and advanced
    // by (bytesPerChunk - overlapBytes) after each emit. This is what makes
    // captureStartedAt / captureEndedAt reflect the ACTUAL audio time, not
    // the timer-fire time — which would undercount e2e latency by up to
    // one chunk's worth (3–4s) depending on buffer backlog.
    private var micBufferAudioStart: Date?
    private var meetingBufferAudioStart: Date?
    private static let bytesPerSecond: Double = Double(sampleRate) * Double(channelCount) * Double(bitsPerSample) / 8.0
    private let bufferLock = NSLock()

    private var chunkTimer: Timer?
    private var onAudioChunk: ((Data, TranscriptSegment.AudioSource, AudioChunkMeta) -> Void)?
    private var onDeviceChangeError: (() -> Void)?

    // Per-source monotonically-increasing sequence numbers for out-of-order
    // detection on the server. Reset in stopCapture().
    private var micSequence: Int = 0
    private var meetingSequence: Int = 0

    // Degraded mode buffering (up to 60s). Cap by summed audio duration
    // rather than by chunk count so variable-length VAD chunks retain the
    // right amount of history.
    private var degradedBuffer: [(Data, TranscriptSegment.AudioSource, AudioChunkMeta)] = []
    private let maxDegradedBufferDuration: TimeInterval = 60.0

    // Phase 3 VAD emitters. Non-nil when AppSettings.useVADEmitter is true
    // at startCapture time AND the Silero model loaded successfully; the
    // fixed-timer path (startChunkTimer / emitChunks) is used otherwise.
    private var micEmitter: VADEmitter?
    private var meetingEmitter: VADEmitter?
    private var vadActive: Bool = false

    // Live streaming: every source also goes out as 100 ms PCM frames, which
    // the server streams to Grok. Nil when the caller passes no onFrame or
    // AppSettings.streamAudioFrames is off; the VAD chunks flow either way.
    private var frameStreamer: AudioFrameStreamer?

    // Input device-change handling. HAL property listener fires on the main
    // queue; AirPods (re)connect typically emits 3-5 events in <100ms, so we
    // debounce so the actual mic restart only runs once per route change.
    // Cancelled by stopCapture() so it can never fire after teardown.
    private var pendingMicRestart: DispatchWorkItem?
    private static let micRestartDebounce: TimeInterval = 0.35
    private static let micRestartMaxRetries: Int = 3
    private static let micRestartInitialBackoffMs: Int = 200

    // AVAudioEngine stops itself when the audio configuration changes under
    // it (AirPods renegotiating HFP, a sample-rate change) and posts
    // AVAudioEngineConfigurationChange. Nothing restarts it for us: on
    // 2026-09-25 the mic went quiet 28 s into a meeting with no device-change
    // event, and the rest of Chris's side was lost. Registered per engine.
    private var engineConfigObserver: NSObjectProtocol?

    /// Resolve the bundled / user-installed Silero VAD model path. Same
    /// resolution order as `ProcessSupervisor.vadModelPath`: bundle →
    /// user. Returns nil if neither exists or both are too small to be
    /// real (guards against the HF 404 body that previously made it
    /// into the model dir).
    private static func resolveVADModelPath() -> String? {
        let candidates = [
            Bundle.main.resourcePath.map { "\($0)/models/ggml-silero-v5.1.2.bin" },
            NSString("~/.meeting-copilot/models/ggml-silero-v5.1.2.bin").expandingTildeInPath
        ].compactMap { $0 }
        for path in candidates {
            guard FileManager.default.fileExists(atPath: path) else { continue }
            if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
               let size = attrs[.size] as? Int, size >= 500_000 {
                return path
            }
        }
        return nil
    }

    // Lazy AVAudioConverter cache held by the mic tap closure. Rebuilt only
    // when buffer.format changes (e.g. device flips mid-stream). Lives in a
    // class so the escaping closure can mutate it without capture-by-value
    // pitfalls. Single-threaded access: the audio I/O thread.
    fileprivate final class MicConverterBox {
        var converter: AVAudioConverter?
        var inputFormat: AVAudioFormat?
    }

    // MARK: - Capture Health Watchdog State

    // `engine.start()` and `stream.startCapture()` both return successfully
    // even when the underlying tap never delivers a single buffer. That is
    // exactly how the 2026-07-31 session recorded a whole meeting with a dead
    // mic and no warning anywhere: `mic started` logged, then zero tap
    // callbacks for 100s. The counters below plus `checkCaptureHealth()` turn
    // that silent failure into a visible one — and, for the mic, into an
    // automatic restart attempt.
    private let captureHealth = CaptureHealth()
    /// Buffers (and non-zero buffers) per track since capture started: what
    /// the capture self-test reports (CaptureSelfTest).
    var captureHealthSnapshot: (micBuffers: Int, micNonZero: Int, meetingBuffers: Int, meetingNonZero: Int) {
        captureHealth.snapshot()
    }
    private var healthTimer: Timer?
    private var healthStartedAt: Date?
    private var micWatchdogArmedAt: Date?
    private var micWatchdogRestarts: Int = 0
    private var micLastRestartAt: Date?
    /// Buffer count at the last poll that saw it grow, and when — the stall
    /// detector's memory. A tap that delivered once and then stopped is as
    /// dead as one that never started.
    private var micLastSeenBuffers: Int = 0
    private var micLastProgressAt: Date?
    /// Same, for buffers carrying any non-zero sample. A working mic never
    /// reads exact zero (its noise floor alone is non-zero); a hijacked,
    /// denied or wedged one delivers valid-sized buffers of zeros.
    private var micLastSignalSeen: Int = 0
    private var micLastSignalAt: Date?
    private var warnedMicDead = false
    private var warnedMeetingSilent = false
    private var onCaptureWarning: ((String) -> Void)?
    /// The mic is dead after its restart ladder (message for the user), and
    /// its recovery. Separate from `onCaptureWarning` so the app can mark the
    /// mic specifically and clear the alarm when audio returns.
    var onMicDead: ((String) -> Void)?
    var onMicRecovered: (() -> Void)?

    /// How long to wait for the mic tap's FIRST buffer before treating the
    /// engine as dead. AVAudioEngine legitimately takes a beat to spin up
    /// (AirPods HFP negotiation is the slow case on this hardware), so this is
    /// deliberately generous — a false positive costs only a needless restart,
    /// while too short a window is the bug notes4chris just had to fix.
    private static let micFirstBufferGraceSec: TimeInterval = 8.0
    /// Automatic restart attempts before we stop trying and just warn.
    private static let micWatchdogMaxRestarts: Int = 2
    /// How long a mic that HAS been delivering may go without a buffer before
    /// it counts as stalled. A 4096-frame tap fires every ~0.1-0.2 s whatever
    /// the level, so 5 s of nothing is never a quiet room.
    private static let micStallGraceSec: TimeInterval = 5.0
    /// How long a delivering mic may carry nothing but exact zeros.
    private static let micZeroGraceSec: TimeInterval = 15.0
    /// Sustained delivery after a restart that earns the restart budget back,
    /// so a stall late in a long meeting still gets its own restarts.
    private static let micRestartBudgetResetSec: TimeInterval = 30.0
    /// After the restart ladder is spent, keep trying this often. A dead mic is
    /// never acceptable to leave alone for the rest of a meeting.
    private static let micPersistentRetrySec: TimeInterval = 30.0
    /// How long the meeting track may stay digitally silent before warning.
    /// Long enough to survive a genuinely quiet opening, short enough to still
    /// be actionable while the meeting is running.
    private static let meetingSilenceGraceSec: TimeInterval = 25.0
    private static let healthPollIntervalSec: TimeInterval = 1.0

    /// Output-device name fragments that indicate a virtual / aggregate
    /// device. These are the usual cause of ScreenCaptureKit handing back
    /// valid-sized buffers full of zeros (gotcha #12), so both the start-up
    /// snapshot and the silence watchdog flag them.
    private static let virtualOutputTokens = [
        "BlackHole", "Loopback", "Aggregate", "Multi-Output", "Zoom", "Muse", "Pro Tools"
    ]

    // MARK: - Start Capture

    func startCapture(
        onChunk: @escaping (Data, TranscriptSegment.AudioSource, AudioChunkMeta) -> Void,
        onFrame: ((Data) -> Void)? = nil,
        onDeviceError: @escaping () -> Void,
        onCaptureWarning: @escaping (String) -> Void
    ) async throws {
        self.onAudioChunk = onChunk
        if let onFrame, AppSettings.streamAudioFrames {
            self.frameStreamer = AudioFrameStreamer(emit: onFrame)
            appLog("[AudioCapture] streaming 100 ms frames alongside VAD chunks")
        } else {
            self.frameStreamer = nil
        }
        self.onDeviceChangeError = onDeviceError
        self.onCaptureWarning = onCaptureWarning
        self.micSequence = 0
        self.meetingSequence = 0

        // Phase 3: initialise VAD emitters if the flag is on and the Silero
        // model loads. Otherwise the timer path below drives emission.
        if AppSettings.useVADEmitter {
            let modelPath = Self.resolveVADModelPath()
            if let path = modelPath, let probe = VADProbe(modelPath: path) {
                // One probe per source — whisper_vad_context is not documented
                // as thread-safe and each state machine needs independent state.
                let secondProbe = VADProbe(modelPath: path)
                let threshold = AppSettings.vadThreshold
                let minSilenceMs = AppSettings.vadMinSilenceMs
                let maxUtterance = AppSettings.vadMaxUtteranceSec
                self.micEmitter = VADEmitter(
                    source: .mic,
                    probe: probe,
                    threshold: threshold,
                    minSilenceMs: minSilenceMs,
                    maxUtteranceSec: maxUtterance
                ) { [weak self] wav, source, meta in
                    self?.onAudioChunk?(wav, source, meta)
                }
                if let mp = secondProbe {
                    self.meetingEmitter = VADEmitter(
                        source: .meeting,
                        probe: mp,
                        threshold: threshold,
                        minSilenceMs: minSilenceMs,
                        maxUtteranceSec: maxUtterance
                    ) { [weak self] wav, source, meta in
                        self?.onAudioChunk?(wav, source, meta)
                    }
                    self.vadActive = true
                    appLog("[AudioCapture] VAD emitters active (threshold=\(threshold), silence=\(minSilenceMs)ms, cap=\(maxUtterance)s)")
                } else {
                    // Couldn't load a second probe — fall back cleanly.
                    self.micEmitter = nil
                    self.vadActive = false
                    appLog("[AudioCapture] VAD probe load failed on second source — falling back to timer path")
                }
            } else {
                self.vadActive = false
                appLog("[AudioCapture] VAD enabled but model load failed — falling back to timer path (model=\(modelPath ?? "nil"))")
            }
        } else {
            self.vadActive = false
        }

        do {
            // Start meeting (other-side) audio: process tap, or ScreenCaptureKit
            try await startMeetingAudioCapture()

            // Start microphone capture via AVAudioEngine
            try startMicrophoneCapture()

            // Set up audio device change monitoring
            routeObserver = AudioRouteObserver(
                onOutputChange: { [weak self] in self?.handleOutputDeviceChange() },
                onInputChange: { [weak self] in self?.handleInputDeviceChange() }
            )

            // Start the fixed-timer emitter ONLY when VAD is inactive.
            // The VAD path emits on speech boundaries from inside the tap
            // callbacks instead of on a wall-clock schedule.
            if !vadActive {
                startChunkTimer()
            } else {
                appLog("[AudioCapture] Skipping fixed-timer emitter — VAD path active")
            }

            // Update device names
            updateDeviceNames()

            isCapturing = true

            // Arm last: the watchdog reads `currentInputDevice` /
            // `currentOutputDevice` for its warnings and guards on
            // `isCapturing`, so both must already be settled.
            startCaptureHealthWatchdog()
        } catch {
            await stopCapture()
            throw error
        }
    }

    // MARK: - Flush Pending Audio

    /// Collect any in-flight VAD-buffered partial utterances. Returns an
    /// array so SessionManager can serially `await` each WebSocket send
    /// BEFORE transitioning state to `.ending` (after which onChunk
    /// would drop sends). The fire-and-forget Task path in onChunk is
    /// fine for ingest-time chunks but creates a race on stop.
    ///
    /// No-op (empty array) when the fixed-timer path is active.
    func flushPendingAudio() -> [(Data, TranscriptSegment.AudioSource, AudioChunkMeta)] {
        var out: [(Data, TranscriptSegment.AudioSource, AudioChunkMeta)] = []
        if let chunk = micEmitter?.flush() {
            out.append((chunk.wav, chunk.source, chunk.meta))
        }
        if let chunk = meetingEmitter?.flush() {
            out.append((chunk.wav, chunk.source, chunk.meta))
        }
        return out
    }

    // MARK: - Stop Capture

    func stopCapture() async {
        isCapturing = false

        // Cancel any in-flight debounced mic restart so it can't run after
        // teardown and resurrect the engine.
        pendingMicRestart?.cancel()
        pendingMicRestart = nil
        pendingTapRestart?.cancel()
        pendingTapRestart = nil

        // Stop chunk timer
        chunkTimer?.invalidate()
        chunkTimer = nil

        // Stop the capture-health watchdog. Must happen here as well as via
        // the isCapturing guard — a live Timer retains its closure and would
        // keep polling a torn-down engine until the next startCapture.
        healthTimer?.invalidate()
        healthTimer = nil
        healthStartedAt = nil
        micWatchdogArmedAt = nil
        captureHealth.resetAll()

        // Tear down VAD emitters (after flushPendingAudio has drained them).
        micEmitter?.reset()
        meetingEmitter?.reset()
        micEmitter = nil
        meetingEmitter = nil
        vadActive = false

        // Stop system audio (whichever backend was live)
        if #available(macOS 14.2, *), let tap = systemTap as? SystemAudioTap {
            tap.stop()
        }
        systemTap = nil
        if let stream = scStream {
            try? await stream.stopCapture()
            scStream = nil
        }
        systemAudioDelegate = nil

        // Stop microphone. Both removeTap AND engine.stop can raise an
        // NSException when AVAudioEngine is wedged (mid-device-change,
        // certain aggregate-device teardowns). The route-change restart
        // path below already wraps these; the user-initiated stop path
        // MUST guard them too or it'll abort the process on stop. See
        // gotcha #18 and ObjCExceptionBridge usage elsewhere in this file.
        removeEngineConfigObserver()
        if let engine = audioEngine {
            try? ObjCExceptionBridge.catching {
                engine.inputNode.removeTap(onBus: 0)
            }
            try? ObjCExceptionBridge.catching {
                engine.stop()
            }
            audioEngine = nil
        }
        audioConverter = nil

        // Clean up observer
        routeObserver = nil

        // Clear buffers
        clearBuffers()

        onAudioChunk = nil
        frameStreamer?.reset()
        frameStreamer = nil
        onDeviceChangeError = nil
        onCaptureWarning = nil
    }

    /// Keep NSLock acquisition out of the async stop function; Swift 6 warns
    /// because a suspension while holding a lock would be unsafe.
    private func clearBuffers() {
        bufferLock.lock()
        defer { bufferLock.unlock() }
        micPCMBuffer = Data()
        meetingPCMBuffer = Data()
        micBufferAudioStart = nil
        meetingBufferAudioStart = nil
        degradedBuffer = []
    }

    // MARK: - Degraded Mode

    /// Buffer a chunk during degraded mode for later replay.
    /// Capped by summed audio duration (not chunk count) — VAD chunks are
    /// variable-length, so a count-based cap would over- or under-retain
    /// depending on speaker cadence.
    func bufferDegradedChunk(_ data: Data, source: TranscriptSegment.AudioSource, meta: AudioChunkMeta) {
        bufferLock.lock()
        degradedBuffer.append((data, source, meta))
        var totalDuration = degradedBuffer.reduce(0.0) { $0 + $1.2.audioDurationSec }
        while totalDuration > maxDegradedBufferDuration, !degradedBuffer.isEmpty {
            let dropped = degradedBuffer.removeFirst()
            totalDuration -= dropped.2.audioDurationSec
        }
        bufferLock.unlock()
    }

    func flushDegradedBuffer() {
        bufferLock.lock()
        let buffered = degradedBuffer
        degradedBuffer = []
        bufferLock.unlock()

        for (data, source, meta) in buffered {
            onAudioChunk?(data, source, meta)
        }
    }

    // MARK: - Meeting Audio

    /// Start the meeting track on the configured backend. The process tap is
    /// the default because it is the only path that hears phone and FaceTime
    /// calls (gotcha #20); any failure to start it falls back to
    /// ScreenCaptureKit rather than failing the session.
    private func startMeetingAudioCapture() async throws {
        meetingPeakWindow = 0.0
        meetingPeakLastFlush = Date()
        if AppSettings.meetingAudioSource == .processTap {
            if #available(macOS 14.2, *) {
                do {
                    try await startProcessTapCapture()
                    meetingBackend = .processTap
                    return
                } catch {
                    appLog("[AudioCapture] process tap failed to start (\(error.localizedDescription)) — falling back to ScreenCaptureKit")
                }
            } else {
                appLog("[AudioCapture] process tap needs macOS 14.2+ — using ScreenCaptureKit")
            }
        }
        try await startSystemAudioCapture()
        meetingBackend = .screenCaptureKit
    }

    @available(macOS 14.2, *)
    private func startProcessTapCapture() async throws {
        let tap = SystemAudioTap { [weak self] samples, peak in
            self?.ingestMeetingSamples(samples, int16: nil, peak: peak)
        }
        // AudioDeviceStart blocks while macOS shows the first-run System
        // Audio Recording prompt, so keep it off the caller's thread.
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    try tap.start()
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
        systemTap = tap
        let outputName = getDefaultDeviceName(selector: kAudioHardwarePropertyDefaultOutputDevice)
        appLog("[AudioCapture] Process tap started. output=\"\(outputName)\" input=\"\(getDefaultDeviceName(selector: kAudioHardwarePropertyDefaultInputDevice))\"")
    }

    /// Single sink for meeting-track samples from either backend: feeds the
    /// VAD emitter (or the fixed-timer Int16 buffer), the health counters, the
    /// per-second peak log, and the level meter. Called on the live backend's
    /// capture thread. `int16` is ScreenCaptureKit's precomputed quantization;
    /// the tap passes nil and it is computed only if the timer path needs it.
    private func ingestMeetingSamples(_ samples: [Float], int16: Data?, peak: Float) {
        frameStreamer?.append(int16 ?? Self.quantize(samples), source: .meeting)
        if let emitter = meetingEmitter {
            emitter.ingest(samples: samples)
        } else {
            let pcmData = int16 ?? Self.quantize(samples)
            bufferLock.lock()
            if meetingPCMBuffer.isEmpty {
                // Wall clock of the oldest sample = now - duration of what we're about to append.
                let appendDuration = Double(pcmData.count) / Self.bytesPerSecond
                meetingBufferAudioStart = Date().addingTimeInterval(-appendDuration)
            }
            meetingPCMBuffer.append(pcmData)
            bufferLock.unlock()
        }

        captureHealth.recordMeeting(peak: peak)
        levelMeter.recordMeeting(peak)

        meetingPeakWindow = max(meetingPeakWindow, peak)
        let now = Date()
        if now.timeIntervalSince(meetingPeakLastFlush) >= 1.0 {
            appLog("[AudioCapture] meeting peak=\(String(format: "%.4f", meetingPeakWindow))")
            meetingPeakWindow = 0.0
            meetingPeakLastFlush = now
        }

        Task { @MainActor in
            self.audioLevel = peak
        }
    }

    private static func quantize(_ samples: [Float]) -> Data {
        var data = Data(capacity: samples.count * MemoryLayout<Int16>.size)
        for sample in samples {
            let value = Int16(sample * Float(Int16.max))
            withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
        }
        return data
    }

    // MARK: - System Audio (ScreenCaptureKit)

    private func startSystemAudioCapture() async throws {
        // Menubar apps (LSUIElement=true) need to be activated to reliably show
        // the Screen Recording permission prompt. `CGRequestScreenCaptureAccess`
        // returns synchronously with the current status AND triggers the dialog
        // if no decision has been recorded yet.
        if !CGPreflightScreenCaptureAccess() {
            await MainActor.run {
                NSApp.activate(ignoringOtherApps: true)
            }
            _ = CGRequestScreenCaptureAccess()
            // If the user must still grant permission, surface a clear error
            // instead of the generic -3801 that SCShareableContent produces.
            if !CGPreflightScreenCaptureAccess() {
                throw AudioCaptureError.screenRecordingPermissionRequired
            }
        }

        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

        guard let display = content.displays.first else {
            throw AudioCaptureError.noDisplayFound
        }

        // Two filter shapes produce different internal audio paths on macOS 14.x.
        // The display-scoped excluding-empty form goes through the display's
        // audio mix; the `including: apps` form taps per-app audio directly.
        // When something else (Rogue Amoeba ARK/ACE, BlackHole aggregate, etc.)
        // has claimed the display audio bus, the first form yields silent
        // frames but the per-app form still works. We prefer the per-app form.
        let ownPid = ProcessInfo.processInfo.processIdentifier
        let capturedApps = content.applications.filter { $0.processID != ownPid }
        let filter = SCContentFilter(
            display: display,
            including: capturedApps,
            exceptingWindows: []
        )
        appLog("[AudioCapture] Using including-apps filter, apps=\(capturedApps.count)")

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = Self.sampleRate
        config.channelCount = Self.channelCount
        // Minimize video overhead - audio only
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.showsCursor = false

        // Samples go through the same sink as the process tap: VAD emitter or
        // timer buffer, health counters, per-second peak log, level meter.
        let delegate = SystemAudioDelegate { [weak self] pcmData, floatSamples, level in
            self?.ingestMeetingSamples(floatSamples, int16: pcmData, peak: level)
        }
        self.systemAudioDelegate = delegate

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(
            delegate,
            type: .audio,
            sampleHandlerQueue: DispatchQueue(label: "com.meetingcopilot.system-audio", qos: .userInteractive)
        )

        try await stream.startCapture()
        self.scStream = stream

        // Snapshot the output device at capture start — invaluable when the
        // symptom turns out to be output routing (AirPods / aggregate device).
        let outputName = getDefaultDeviceName(selector: kAudioHardwarePropertyDefaultOutputDevice)
        let isVirtual = Self.virtualOutputTokens.contains { outputName.localizedCaseInsensitiveContains($0) }
        appLog("[AudioCapture] ScreenCaptureKit started. output=\"\(outputName)\" virtual=\(isVirtual) input=\"\(getDefaultDeviceName(selector: kAudioHardwarePropertyDefaultInputDevice))\"")
    }

    // MARK: - Microphone (AVAudioEngine)

    private func startMicrophoneCapture() throws {
        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        pinMicrophone(inputNode)

        let desiredFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(Self.sampleRate),
            channels: AVAudioChannelCount(Self.channelCount),
            interleaved: false
        )!

        // Validate the input bus has a usable format before installing a tap.
        // During input-device transitions (AirPods (re)connect, default-input
        // switch, USB mic plug/unplug) CoreAudio can briefly report a
        // zero-sample-rate / zero-channel format. Throwing here lets the
        // debounced restart path retry once the bus settles.
        let hardwareFormat = inputNode.inputFormat(forBus: 0)
        guard hardwareFormat.sampleRate > 0, hardwareFormat.channelCount > 0 else {
            appLog("[AudioCapture] mic: input bus reported invalid format (sr=\(hardwareFormat.sampleRate), ch=\(hardwareFormat.channelCount)); will retry")
            throw AudioCaptureError.microphoneUnavailable
        }

        // Lazy converter cache. The audio I/O thread is the sole accessor of
        // `box` once the tap is installed, so no synchronization is needed.
        let box = MicConverterBox()

        var micPeakWindow: Float = 0.0
        var micPeakLastFlush = Date()

        // Critical: pass `format: nil` so AVAudioEngine uses the input bus's
        // ACTUAL current format rather than whatever inputFormat(forBus:0)
        // returned a few instructions ago. The mismatch between those two —
        // routine during device transitions — is what raised the
        // AVAE_RaiseException -> std::terminate crash before this fix.
        // We additionally wrap installTap in ObjCExceptionBridge.catching as
        // a safety net; AVAudioEngine still raises NSException for some
        // malformed states (no input device at all, etc.) which Swift cannot
        // catch with do/try and would abort the process. See gotcha #18.
        do {
            try ObjCExceptionBridge.catching {
                inputNode.installTap(onBus: 0, bufferSize: 4096, format: nil) { [weak self] buffer, _ in
                    guard let self = self else { return }

                    let bufferFormat = buffer.format
                    var processBuffer: AVAudioPCMBuffer

                    let needsConversion = bufferFormat.sampleRate != desiredFormat.sampleRate ||
                                          bufferFormat.channelCount != desiredFormat.channelCount ||
                                          bufferFormat.commonFormat != desiredFormat.commonFormat

                    if needsConversion {
                        // Rebuild the converter only when the input format has actually
                        // changed (after a device flip mid-stream).
                        if box.inputFormat == nil ||
                           box.inputFormat!.sampleRate != bufferFormat.sampleRate ||
                           box.inputFormat!.channelCount != bufferFormat.channelCount ||
                           box.inputFormat!.commonFormat != bufferFormat.commonFormat {
                            box.converter = AVAudioConverter(from: bufferFormat, to: desiredFormat)
                            box.inputFormat = bufferFormat
                        }
                        guard let converter = box.converter else { return }

                        let frameCapacity = AVAudioFrameCount(
                            Double(buffer.frameLength) * desiredFormat.sampleRate / bufferFormat.sampleRate
                        )
                        guard let convertedBuffer = AVAudioPCMBuffer(pcmFormat: desiredFormat, frameCapacity: frameCapacity) else {
                            return
                        }

                        var error: NSError?
                        var inputConsumed = false
                        converter.convert(to: convertedBuffer, error: &error) { _, outStatus in
                            if inputConsumed {
                                outStatus.pointee = .noDataNow
                                return nil
                            }
                            inputConsumed = true
                            outStatus.pointee = .haveData
                            return buffer
                        }

                        if error != nil { return }
                        processBuffer = convertedBuffer
                    } else {
                        processBuffer = buffer
                    }

                    // Extract Float32 samples (used both by VAD and the
                    // fixed-timer path's Int16 quantization).
                    guard let floatData = processBuffer.floatChannelData else { return }
                    let frameCount = Int(processBuffer.frameLength)
                    var floatSamples = [Float]()
                    floatSamples.reserveCapacity(frameCount)
                    var localPeak: Float = 0.0

                    for i in 0..<frameCount {
                        let sample = floatData[0][i]
                        let clamped = max(-1.0, min(1.0, sample))
                        localPeak = max(localPeak, abs(clamped))
                        floatSamples.append(clamped)
                    }

                    self.frameStreamer?.append(Self.quantize(floatSamples), source: .mic)

                    // VAD path: feed Float32 directly; no Int16 buffer.
                    if let emitter = self.micEmitter {
                        emitter.ingest(samples: floatSamples)
                    } else {
                        // Fixed-timer path: quantize to Int16 and append.
                        var int16Data = Data(capacity: frameCount * MemoryLayout<Int16>.size)
                        for sample in floatSamples {
                            let int16Value = Int16(sample * Float(Int16.max))
                            withUnsafeBytes(of: int16Value.littleEndian) { bytes in
                                int16Data.append(contentsOf: bytes)
                            }
                        }

                        self.bufferLock.lock()
                        if self.micPCMBuffer.isEmpty {
                            let appendDuration = Double(int16Data.count) / Self.bytesPerSecond
                            self.micBufferAudioStart = Date().addingTimeInterval(-appendDuration)
                        }
                        self.micPCMBuffer.append(int16Data)
                        self.bufferLock.unlock()
                    }

                    self.captureHealth.recordMic(peak: localPeak)
                    self.levelMeter.recordMic(localPeak)

                    micPeakWindow = max(micPeakWindow, localPeak)
                    let now = Date()
                    if now.timeIntervalSince(micPeakLastFlush) >= 1.0 {
                        appLog("[AudioCapture] mic peak=\(String(format: "%.4f", micPeakWindow))")
                        micPeakWindow = 0.0
                        micPeakLastFlush = now
                    }
                }
            }
        } catch {
            appLog("[AudioCapture] mic installTap raised: \(error.localizedDescription)")
            throw AudioCaptureError.microphoneUnavailable
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            // Best-effort tap removal so the next attempt starts clean.
            try? ObjCExceptionBridge.catching { inputNode.removeTap(onBus: 0) }
            appLog("[AudioCapture] mic engine.start failed: \(error)")
            throw AudioCaptureError.microphoneUnavailable
        }

        self.audioEngine = engine
        self.audioConverter = nil  // Per-format converter now lives in the tap closure.
        removeEngineConfigObserver()
        engineConfigObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: .main
        ) { [weak self, weak engine] _ in
            // A running engine rode the change out; restarting it would only
            // risk a loop (a fresh engine can post this on start). A stopped
            // one is the silent death. The stall watchdog backs this up.
            guard let engine, !engine.isRunning else {
                appLog("[AudioCapture] mic engine configuration changed; engine still running")
                return
            }
            appLog("[AudioCapture] mic engine configuration changed and engine stopped — restarting")
            self?.scheduleMicRestart()
        }
        appLog("[AudioCapture] mic started, hardwareFormat=\(hardwareFormat.sampleRate)Hz/\(hardwareFormat.channelCount)ch")
    }

    // MARK: - Chunk Timer

    private func startChunkTimer() {
        // Fire every (chunkDuration - overlap) seconds to produce overlapping chunks
        let interval = Self.chunkDurationSeconds - Self.chunkOverlapSeconds
        // Must schedule on main RunLoop — after async ScreenCaptureKit calls,
        // execution may resume on a background thread with no active RunLoop.
        let timer = Timer(timeInterval: interval, repeats: true) { [weak self] _ in
            self?.emitChunks()
        }
        RunLoop.main.add(timer, forMode: .common)
        chunkTimer = timer
    }

    private func emitChunks() {
        let bytesPerChunk = Self.sampleRate * Self.channelCount * (Self.bitsPerSample / 8) * Int(Self.chunkDurationSeconds)
        let overlapBytes = Self.sampleRate * Self.channelCount * (Self.bitsPerSample / 8) * Int(Self.chunkOverlapSeconds)
        let advanceBytes = bytesPerChunk - overlapBytes
        let advanceSeconds = Double(advanceBytes) / Self.bytesPerSecond

        bufferLock.lock()

        // Emit meeting audio chunk
        if meetingPCMBuffer.count >= bytesPerChunk, let origin = meetingBufferAudioStart {
            let chunkData = meetingPCMBuffer.prefix(bytesPerChunk)
            let wavData = AudioWAV.encode(int16PCM: Data(chunkData))
            // Timestamps derived from the buffer's audio-time origin — NOT
            // the timer fire time. The emitted chunk covers samples
            // [origin, origin + chunkDurationSeconds]; the remaining bytes
            // in the buffer are newer than that window.
            let capturedStart = origin
            let capturedEnd = origin.addingTimeInterval(Self.chunkDurationSeconds)
            meetingPCMBuffer.removeFirst(min(advanceBytes, meetingPCMBuffer.count))
            // Advance the buffer origin by the non-overlapping prefix we just removed.
            if meetingPCMBuffer.isEmpty {
                meetingBufferAudioStart = nil
            } else {
                meetingBufferAudioStart = origin.addingTimeInterval(advanceSeconds)
            }
            meetingSequence += 1
            // Timer path: every chunk after the first carries a 1s overlap
            // from the previous one (see chunkOverlapSeconds), so mark as
            // continuation whenever we're not on the very first chunk.
            let meta = AudioChunkMeta(
                audioDurationSec: Self.chunkDurationSeconds,
                captureStartedAt: capturedStart,
                captureEndedAt: capturedEnd,
                sequence: meetingSequence,
                isContinuation: meetingSequence > 1
            )
            bufferLock.unlock()
            onAudioChunk?(wavData, .meeting, meta)
        } else {
            bufferLock.unlock()
        }

        bufferLock.lock()
        // Emit mic audio chunk
        if micPCMBuffer.count >= bytesPerChunk, let origin = micBufferAudioStart {
            let chunkData = micPCMBuffer.prefix(bytesPerChunk)
            let wavData = AudioWAV.encode(int16PCM: Data(chunkData))
            let capturedStart = origin
            let capturedEnd = origin.addingTimeInterval(Self.chunkDurationSeconds)
            micPCMBuffer.removeFirst(min(advanceBytes, micPCMBuffer.count))
            if micPCMBuffer.isEmpty {
                micBufferAudioStart = nil
            } else {
                micBufferAudioStart = origin.addingTimeInterval(advanceSeconds)
            }
            micSequence += 1
            let micMeta = AudioChunkMeta(
                audioDurationSec: Self.chunkDurationSeconds,
                captureStartedAt: capturedStart,
                captureEndedAt: capturedEnd,
                sequence: micSequence,
                isContinuation: micSequence > 1
            )
            bufferLock.unlock()
            onAudioChunk?(wavData, .mic, micMeta)
        } else {
            bufferLock.unlock()
        }
    }

    // MARK: - Capture Health Watchdog

    private func startCaptureHealthWatchdog() {
        let now = Date()
        healthStartedAt = now
        micWatchdogArmedAt = now
        micWatchdogRestarts = 0
        micLastRestartAt = nil
        micLastSeenBuffers = 0
        micLastProgressAt = now
        micLastSignalSeen = 0
        micLastSignalAt = now
        warnedMicDead = false
        warnedMeetingSilent = false
        captureHealth.resetAll()

        // Same RunLoop rationale as startChunkTimer(): after the async
        // ScreenCaptureKit calls we may resume on a thread with no RunLoop.
        let timer = Timer(timeInterval: Self.healthPollIntervalSec, repeats: true) { [weak self] _ in
            self?.checkCaptureHealth()
        }
        RunLoop.main.add(timer, forMode: .common)
        healthTimer = timer
    }

    /// Poll the capture counters and act on the two failure modes that
    /// previously went unnoticed for an entire meeting.
    ///
    /// The decisions themselves live in the pure `micVerdict` / `meetingVerdict`
    /// functions below so they can be unit-tested without timers, devices, or
    /// a live meeting; this function only performs the resulting side effects.
    private func checkCaptureHealth() {
        guard isCapturing else { return }
        let stats = captureHealth.snapshot()
        let now = Date()

        // --- Mic: no buffers at all, or buffers that stopped coming. ---
        if stats.micBuffers != micLastSeenBuffers {
            micLastSeenBuffers = stats.micBuffers
            micLastProgressAt = now
        }
        let sinceLastBuffer = now.timeIntervalSince(micLastProgressAt ?? now)
        if stats.micNonZero != micLastSignalSeen {
            micLastSignalSeen = stats.micNonZero
            micLastSignalAt = now
        }
        let sinceLastSignal = now.timeIntervalSince(micLastSignalAt ?? now)
        if let armedAt = micWatchdogArmedAt {
            switch Self.micVerdict(
                buffers: stats.micBuffers,
                elapsed: now.timeIntervalSince(armedAt),
                restartsUsed: micWatchdogRestarts,
                sinceLastBuffer: sinceLastBuffer,
                sinceLastSignal: sinceLastSignal
            ) {
            case .healthy:
                if warnedMicDead {
                    warnedMicDead = false
                    appLog("[AudioCapture] WATCHDOG mic recovered — \"\(currentInputDevice)\" delivering audio again")
                    onMicRecovered?()
                }
                if micWatchdogRestarts > 0, let last = micLastRestartAt,
                   now.timeIntervalSince(last) >= Self.micRestartBudgetResetSec {
                    micWatchdogRestarts = 0
                    micLastRestartAt = nil
                }
            case .wait:
                break
            case .restart:
                micWatchdogRestarts += 1
                micLastRestartAt = now
                if stats.micBuffers > 0 && sinceLastBuffer < Self.micStallGraceSec {
                    appLog("[AudioCapture] WATCHDOG mic delivering only digital silence for \(Int(sinceLastSignal))s — restarting engine (attempt \(micWatchdogRestarts)/\(Self.micWatchdogMaxRestarts))")
                } else if stats.micBuffers > 0 {
                    appLog("[AudioCapture] WATCHDOG mic stalled — no buffers for \(Int(sinceLastBuffer))s after \(stats.micBuffers) — restarting engine (attempt \(micWatchdogRestarts)/\(Self.micWatchdogMaxRestarts))")
                } else {
                    appLog("[AudioCapture] WATCHDOG mic delivered 0 buffers in \(Int(Self.micFirstBufferGraceSec))s — restarting engine (attempt \(micWatchdogRestarts)/\(Self.micWatchdogMaxRestarts))")
                }
                // Re-arm BEFORE restarting so the next grace window is measured
                // against the new engine rather than against capture start.
                micWatchdogArmedAt = now
                captureHealth.resetMic()
                micLastSeenBuffers = 0
                micLastProgressAt = now
                micLastSignalSeen = 0
                micLastSignalAt = now
                restartMicrophoneCapture(
                    retriesLeft: Self.micRestartMaxRetries,
                    backoffMs: Self.micRestartInitialBackoffMs
                )
            case .giveUp:
                if !warnedMicDead {
                    // Warn once; the .healthy branch clears it on recovery.
                    warnedMicDead = true
                    appLog("[AudioCapture] WATCHDOG mic dead after \(Self.micWatchdogMaxRestarts) restarts (input=\"\(currentInputDevice)\") — warning, retrying every \(Int(Self.micPersistentRetrySec))s")
                    onMicDead?(
                        "Your microphone (\"\(currentInputDevice)\") is not delivering audio, so your side of the meeting is not being heard. It may be muted or disconnected. Meeting Copilot keeps retrying; switching the input in System Settings → Sound also restarts it."
                    )
                }
                // Never stop trying: one restart every micPersistentRetrySec.
                if let last = micLastRestartAt, now.timeIntervalSince(last) >= Self.micPersistentRetrySec {
                    micLastRestartAt = now
                    micWatchdogArmedAt = now
                    captureHealth.resetMic()
                    micLastSeenBuffers = 0
                    micLastProgressAt = now
                    micLastSignalSeen = 0
                    micLastSignalAt = now
                    appLog("[AudioCapture] WATCHDOG mic still dead — retrying restart")
                    restartMicrophoneCapture(
                        retriesLeft: Self.micRestartMaxRetries,
                        backoffMs: Self.micRestartInitialBackoffMs
                    )
                }
            }
        }

        // --- Meeting: buffers arriving, but every sample is zero. ---
        if let startedAt = healthStartedAt, !warnedMeetingSilent {
            let verdict = Self.meetingVerdict(
                buffers: stats.meetingBuffers,
                nonZero: stats.meetingNonZero,
                elapsed: now.timeIntervalSince(startedAt)
            )
            if verdict == .silent {
                warnedMeetingSilent = true
                appLog("[AudioCapture] WATCHDOG meeting track silent — \(stats.meetingBuffers) buffers, all zero (output=\"\(currentOutputDevice)\")")
                onCaptureWarning?(Self.meetingSilenceWarning(outputDevice: currentOutputDevice, backend: meetingBackend))
            }
        }
    }

    /// What to do about a mic track that may not have started.
    enum MicVerdict: Equatable {
        /// Buffers are arriving — the tap is alive.
        case healthy
        /// No buffers yet, but still inside the startup grace window.
        case wait
        /// Grace elapsed with zero buffers and restarts still available.
        case restart
        /// Grace elapsed with zero buffers and the restart ladder exhausted.
        case giveUp
    }

    /// Decide whether a mic tap that reported a successful `engine.start()` is
    /// actually delivering audio.
    ///
    /// Keyed on buffer COUNT, never on peak level: a muted or quiet mic still
    /// fires the tap and logs `mic peak=0.0000`, and restarting the engine for
    /// that would be wrong. Only a total absence of callbacks means dead.
    ///
    /// A tap that delivered and then stopped (`sinceLastBuffer` past
    /// `stallGrace`) is judged like one that never started, and so is one
    /// delivering nothing but exact zeros for `zeroGrace` (a quiet room is
    /// never exact zero; see `micLastSignalAt`). Before 2026-09-25
    /// one buffer made the mic healthy for the rest of the meeting.
    ///
    /// Pure so it can be tested without timers or a real device.
    static func micVerdict(
        buffers: Int,
        elapsed: TimeInterval,
        restartsUsed: Int,
        sinceLastBuffer: TimeInterval = 0,
        sinceLastSignal: TimeInterval = 0,
        grace: TimeInterval = micFirstBufferGraceSec,
        stallGrace: TimeInterval = micStallGraceSec,
        zeroGrace: TimeInterval = micZeroGraceSec,
        maxRestarts: Int = micWatchdogMaxRestarts
    ) -> MicVerdict {
        if buffers > 0 {
            if sinceLastBuffer < stallGrace && sinceLastSignal < zeroGrace { return .healthy }
        } else if elapsed < grace {
            return .wait
        }
        return restartsUsed < maxRestarts ? .restart : .giveUp
    }

    /// What to do about a meeting track that is delivering buffers.
    enum MeetingVerdict: Equatable {
        /// Real signal has been seen.
        case healthy
        /// Nothing conclusive yet — no buffers at all, or still inside grace.
        case wait
        /// Buffers are arriving but every sample so far has been zero.
        case silent
    }

    /// Decide whether ScreenCaptureKit is delivering real audio or zeros.
    ///
    /// Requires `buffers > 0` before it will ever say `.silent`: with no
    /// buffers at all the problem is the stream, not the routing, and this
    /// watchdog has nothing useful to say about it.
    ///
    /// Pure so it can be tested without a live capture.
    static func meetingVerdict(
        buffers: Int,
        nonZero: Int,
        elapsed: TimeInterval,
        grace: TimeInterval = meetingSilenceGraceSec
    ) -> MeetingVerdict {
        if nonZero > 0 { return .healthy }
        if buffers == 0 || elapsed < grace { return .wait }
        return .silent
    }

    /// Build the user-facing warning for a digitally-silent meeting track.
    /// Naming the output device is what makes it self-diagnosing — the same
    /// reasoning behind notes4chris's `blackholeFallbackWarning`.
    ///
    /// The tap has a different failure: it hears every process whatever the
    /// output device, so routing is not the suspect — a denied System Audio
    /// Recording permission is, because macOS hands a denied tap zeros with
    /// no error (gotcha #20).
    static func meetingSilenceWarning(outputDevice: String, backend: AppSettings.MeetingAudioSource) -> String {
        if backend == .processTap {
            return "No meeting audio detected — the system audio tap is delivering silence. If you can hear the other side, Meeting Copilot is probably missing System Audio Recording permission: enable it in System Settings → Privacy & Security, then restart the session."
        }
        let base = "No meeting audio detected — ScreenCaptureKit is delivering silence."
        if Self.virtualOutputTokens.contains(where: { outputDevice.localizedCaseInsensitiveContains($0) }) {
            return "\(base) Output is \"\(outputDevice)\", a virtual device, so there is no real audio on it to capture. Switch system output to a physical device."
        }
        return "\(base) Output is \"\(outputDevice)\". If you can hear the other side, an audio-routing tool (Loopback / Audio Hijack / BlackHole) is likely intercepting it — quit it and restart the session."
    }

    // MARK: - Device Changes

    private func handleOutputDeviceChange() {
        let newName = getDefaultDeviceName(selector: kAudioHardwarePropertyDefaultOutputDevice)
        appLog("[AudioCapture] Output device changed -> \"\(newName)\"")
        updateDeviceNames()
        // ScreenCaptureKit handles output device changes automatically. The
        // tap is device-independent too, but a rebuild costs ~100 ms of audio
        // and guarantees a fresh aggregate on the new route — debounced like
        // the mic, since AirPods fire a burst of route events.
        guard isCapturing, meetingBackend == .processTap else { return }
        pendingTapRestart?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.isCapturing else { return }
            if #available(macOS 14.2, *), let tap = self.systemTap as? SystemAudioTap {
                do {
                    try tap.start()
                    appLog("[AudioCapture] process tap rebuilt after output change")
                } catch {
                    appLog("[AudioCapture] process tap rebuild failed: \(error.localizedDescription)")
                    self.onCaptureWarning?("Meeting audio stopped after the output device changed — restart the session to recover the other side of the call.")
                }
            }
        }
        pendingTapRestart = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.micRestartDebounce, execute: work)
    }

    private func handleInputDeviceChange() {
        let newName = getDefaultDeviceName(selector: kAudioHardwarePropertyDefaultInputDevice)
        appLog("[AudioCapture] Input device changed -> \"\(newName)\"")
        updateDeviceNames()

        // Skip restart if we're not actively capturing — the next startCapture
        // will pick up the current device on its own.
        guard isCapturing else { return }
        // A pinned mic doesn't move with the default input (AirPods
        // connecting), so restarting it would only risk the engine. If the
        // pinned device itself went away, the engine stops and the
        // configuration-change observer or the stall watchdog restarts it.
        if let pinned = pinnedMic, MicDevicePicker.inputDevices().contains(where: { $0.id == pinned.id }) {
            appLog("[AudioCapture] mic stays on pinned \"\(pinned.name)\"")
            return
        }
        scheduleMicRestart()
    }

    /// A restart asked for by the user (the dashboard's Restart mic button).
    /// Gives the watchdog a fresh restart budget.
    func restartMicrophone() {
        guard isCapturing else { return }
        appLog("[AudioCapture] mic restart requested by the user")
        micWatchdogRestarts = 0
        micWatchdogArmedAt = Date()
        captureHealth.resetMic()
        micLastSeenBuffers = 0
        micLastProgressAt = Date()
        micLastSignalSeen = 0
        micLastSignalAt = Date()
        scheduleMicRestart()
    }

    /// Debounced mic restart, shared by the default-input listener and the
    /// engine's configuration-change notification.
    private func scheduleMicRestart() {
        guard isCapturing else { return }
        // Coalesce burst events (AirPods reconnect fires 3-5 listener events
        // in <100ms). The work item also gets cancelled by stopCapture() so
        // it can never resurrect the engine after teardown.
        pendingMicRestart?.cancel()
        let work = DispatchWorkItem { [weak self] in
            self?.restartMicrophoneCapture(
                retriesLeft: Self.micRestartMaxRetries,
                backoffMs: Self.micRestartInitialBackoffMs
            )
        }
        pendingMicRestart = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + Self.micRestartDebounce,
            execute: work
        )
    }

    /// Tear down the current mic engine and restart it. On failure, retry
    /// with exponential backoff (200ms → 400ms → 800ms) up to
    /// `micRestartMaxRetries` times. After all retries exhausted, surface
    /// to the supervisor via `onDeviceChangeError` but keep the meeting
    /// going — ScreenCaptureKit / meeting audio is independent.
    private func restartMicrophoneCapture(retriesLeft: Int, backoffMs: Int) {
        guard isCapturing else { return }

        removeEngineConfigObserver()
        if let engine = audioEngine {
            // removeTap can raise NSException if the engine is in a wedged
            // state — catch defensively so a stale engine doesn't take down
            // the process during recovery.
            try? ObjCExceptionBridge.catching { engine.inputNode.removeTap(onBus: 0) }
            engine.stop()
            audioEngine = nil
        }
        audioConverter = nil

        do {
            try startMicrophoneCapture()
            appLog("[AudioCapture] mic restarted successfully after device change")
        } catch {
            if retriesLeft > 0 {
                let nextBackoff = min(backoffMs * 2, 1500)
                appLog("[AudioCapture] mic restart failed (retriesLeft=\(retriesLeft), backoff=\(backoffMs)ms): \(error.localizedDescription)")
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(backoffMs)) { [weak self] in
                    self?.restartMicrophoneCapture(retriesLeft: retriesLeft - 1, backoffMs: nextBackoff)
                }
            } else {
                appLog("[AudioCapture] mic restart gave up after \(Self.micRestartMaxRetries) retries: \(error.localizedDescription)")
                onDeviceChangeError?()
            }
        }
    }

    /// Point the engine's input at the preferred mic (built-in by default)
    /// before anything reads its format. A failure leaves the system default.
    private func pinMicrophone(_ inputNode: AVAudioInputNode) {
        let preference = AppSettings.micDevice
        guard let device = MicDevicePicker.choose(preference, from: MicDevicePicker.inputDevices()) else {
            pinnedMic = nil
            appLog("[AudioCapture] mic follows the system default input (preference=\(preference))")
            updateDeviceNames()
            return
        }
        guard let unit = inputNode.audioUnit else {
            pinnedMic = nil
            appLog("[AudioCapture] mic pin skipped — input node has no audio unit")
            return
        }
        var id = device.id
        let status = AudioUnitSetProperty(
            unit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &id,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )
        if status == noErr {
            pinnedMic = device
            appLog("[AudioCapture] mic pinned to \"\(device.name)\" (system default input: \"\(getDefaultDeviceName(selector: kAudioHardwarePropertyDefaultInputDevice))\")")
        } else {
            pinnedMic = nil
            appLog("[AudioCapture] mic pin to \"\(device.name)\" failed (status \(status)) — using the system default input")
        }
        updateDeviceNames()
    }

    private func removeEngineConfigObserver() {
        if let observer = engineConfigObserver {
            NotificationCenter.default.removeObserver(observer)
            engineConfigObserver = nil
        }
    }

    private func updateDeviceNames() {
        currentOutputDevice = getDefaultDeviceName(selector: kAudioHardwarePropertyDefaultOutputDevice)
        currentInputDevice = pinnedMic?.name ?? getDefaultDeviceName(selector: kAudioHardwarePropertyDefaultInputDevice)
    }

    private func getDefaultDeviceName(selector: AudioObjectPropertySelector) -> String {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var deviceID: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)

        guard AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address, 0, nil, &size, &deviceID
        ) == noErr else { return "Unknown" }

        var nameAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceNameCFString,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var nameRef: Unmanaged<CFString>?

        guard AudioObjectGetPropertyData(
            deviceID, &nameAddress, 0, nil, &nameSize, &nameRef
        ) == noErr, let name = nameRef?.takeRetainedValue() else { return "Unknown" }

        return name as String
    }
}

// MARK: - Capture Health Counters

/// Thread-safe capture counters feeding the health watchdog.
///
/// Written from two different audio threads (the AVAudioEngine tap on the I/O
/// thread, the SCStream delegate on its own sample queue) and read from the
/// watchdog Timer on the main RunLoop. Cost is one uncontested lock/unlock per
/// audio buffer — comfortably inside the I/O deadline at our buffer sizes.
///
/// The distinction that matters: `buffers` counts callbacks, `nonZero` counts
/// callbacks carrying actual signal. A dead tap and a zeroed tap are different
/// failures with different fixes, and only these two counters together can
/// tell them apart.
final class CaptureHealth {
    private let lock = NSLock()
    private var micBuffers = 0
    private var micNonZero = 0
    private var meetingBuffers = 0
    private var meetingNonZero = 0

    func recordMic(peak: Float) {
        lock.lock(); defer { lock.unlock() }
        micBuffers += 1
        if peak > 0 { micNonZero += 1 }
    }

    func recordMeeting(peak: Float) {
        lock.lock(); defer { lock.unlock() }
        meetingBuffers += 1
        if peak > 0 { meetingNonZero += 1 }
    }

    /// All four counters read under one lock, so the watchdog never compares
    /// a buffer count against a non-zero count from a different instant.
    func snapshot() -> (micBuffers: Int, micNonZero: Int, meetingBuffers: Int, meetingNonZero: Int) {
        lock.lock(); defer { lock.unlock() }
        return (micBuffers, micNonZero, meetingBuffers, meetingNonZero)
    }

    /// Zero only the mic counters, so a restart is judged on its own merits.
    func resetMic() {
        lock.lock(); defer { lock.unlock() }
        micBuffers = 0
        micNonZero = 0
    }

    func resetAll() {
        lock.lock(); defer { lock.unlock() }
        micBuffers = 0
        micNonZero = 0
        meetingBuffers = 0
        meetingNonZero = 0
    }
}

// MARK: - Level Meter

/// The loudest sample on each track since the menu bar last looked. Written
/// from the two capture threads, drained about four times a second by the
/// popover's level bars — and only while the popover is open. Kept apart from
/// `audioLevel` on purpose: that one is observed, so publishing both tracks
/// through it would re-render SwiftUI ~90 times a second.
final class LevelMeter: @unchecked Sendable {
    private let lock = NSLock()
    private var mic: Float = 0
    private var meeting: Float = 0

    func recordMic(_ peak: Float) {
        lock.lock(); defer { lock.unlock() }
        mic = max(mic, peak)
    }

    func recordMeeting(_ peak: Float) {
        lock.lock(); defer { lock.unlock() }
        meeting = max(meeting, peak)
    }

    /// The peaks since the last drain, then zero.
    func drain() -> (mic: Float, meeting: Float) {
        lock.lock(); defer { lock.unlock() }
        let peaks = (mic: mic, meeting: meeting)
        mic = 0
        meeting = 0
        return peaks
    }
}

// MARK: - System Audio Delegate

private class SystemAudioDelegate: NSObject, SCStreamOutput {
    // Delivers BOTH the quantized Int16 bytes (for the legacy timer path)
    // and the raw Float32 samples (for the VAD path). The Int16 conversion
    // is cheap (~5 µs per frame) so we compute it unconditionally; callers
    // pick whichever they need based on VAD state.
    private let onPCMData: (Data, [Float], Float) -> Void

    init(onPCMData: @escaping (Data, [Float], Float) -> Void) {
        self.onPCMData = onPCMData
        super.init()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard sampleBuffer.isValid, sampleBuffer.numSamples > 0 else { return }
        guard let blockBuffer = sampleBuffer.dataBuffer else { return }

        let length = CMBlockBufferGetDataLength(blockBuffer)
        var rawData = Data(count: length)
        rawData.withUnsafeMutableBytes { rawBufferPointer in
            guard let baseAddress = rawBufferPointer.baseAddress else { return }
            CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: baseAddress)
        }

        // Convert Float32 to Int16 PCM (and keep the Float32 for VAD).
        let floatCount = length / MemoryLayout<Float32>.size
        var int16Data = Data(capacity: floatCount * MemoryLayout<Int16>.size)
        var floatSamples = [Float]()
        floatSamples.reserveCapacity(floatCount)
        var peakLevel: Float = 0.0

        rawData.withUnsafeBytes { rawBufferPointer in
            let floatBuffer = rawBufferPointer.bindMemory(to: Float32.self)
            for i in 0..<floatCount {
                let sample = floatBuffer[i]
                let clamped = max(-1.0, min(1.0, sample))
                peakLevel = max(peakLevel, abs(clamped))
                floatSamples.append(clamped)
                let int16Value = Int16(clamped * Float32(Int16.max))
                withUnsafeBytes(of: int16Value.littleEndian) { bytes in
                    int16Data.append(contentsOf: bytes)
                }
            }
        }

        onPCMData(int16Data, floatSamples, peakLevel)
    }
}

// MARK: - Audio Route Observer

private class AudioRouteObserver {
    private var outputListenerBlock: AudioObjectPropertyListenerBlock?
    private var inputListenerBlock: AudioObjectPropertyListenerBlock?

    init(onOutputChange: @escaping () -> Void, onInputChange: @escaping () -> Void) {
        var outputAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        outputListenerBlock = { _, _ in
            onOutputChange()
        }

        AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &outputAddress,
            DispatchQueue.main,
            outputListenerBlock!
        )

        var inputAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        inputListenerBlock = { _, _ in
            onInputChange()
        }

        AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &inputAddress,
            DispatchQueue.main,
            inputListenerBlock!
        )
    }

    deinit {
        var outputAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        if let block = outputListenerBlock {
            AudioObjectRemovePropertyListenerBlock(
                AudioObjectID(kAudioObjectSystemObject),
                &outputAddress,
                DispatchQueue.main,
                block
            )
        }

        var inputAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        if let block = inputListenerBlock {
            AudioObjectRemovePropertyListenerBlock(
                AudioObjectID(kAudioObjectSystemObject),
                &inputAddress,
                DispatchQueue.main,
                block
            )
        }
    }
}

// MARK: - Errors

enum AudioCaptureError: Error, LocalizedError {
    case noDisplayFound
    case microphoneUnavailable
    case screenCapturePermissionDenied
    case screenRecordingPermissionRequired

    var errorDescription: String? {
        switch self {
        case .noDisplayFound: return "No display found for screen capture"
        case .microphoneUnavailable: return "Microphone is not available"
        case .screenCapturePermissionDenied: return "Screen recording permission not granted"
        case .screenRecordingPermissionRequired:
            return "Screen Recording permission is required. After enabling Meeting Copilot in System Settings → Privacy & Security → Screen Recording, quit and relaunch the app."
        }
    }
}
