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
    var audioLevel: Float = 0.0

    // MARK: - Private State

    private var scStream: SCStream?
    private var systemAudioDelegate: SystemAudioDelegate?
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

    // Input device-change handling. HAL property listener fires on the main
    // queue; AirPods (re)connect typically emits 3-5 events in <100ms, so we
    // debounce so the actual mic restart only runs once per route change.
    // Cancelled by stopCapture() so it can never fire after teardown.
    private var pendingMicRestart: DispatchWorkItem?
    private static let micRestartDebounce: TimeInterval = 0.35
    private static let micRestartMaxRetries: Int = 3
    private static let micRestartInitialBackoffMs: Int = 200

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

    // MARK: - Start Capture

    func startCapture(
        onChunk: @escaping (Data, TranscriptSegment.AudioSource, AudioChunkMeta) -> Void,
        onDeviceError: @escaping () -> Void
    ) async throws {
        self.onAudioChunk = onChunk
        self.onDeviceChangeError = onDeviceError
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
            // Start system audio capture via ScreenCaptureKit
            try await startSystemAudioCapture()

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

        // Stop chunk timer
        chunkTimer?.invalidate()
        chunkTimer = nil

        // Tear down VAD emitters (after flushPendingAudio has drained them).
        micEmitter?.reset()
        meetingEmitter?.reset()
        micEmitter = nil
        meetingEmitter = nil
        vadActive = false

        // Stop system audio
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
        bufferLock.lock()
        micPCMBuffer = Data()
        meetingPCMBuffer = Data()
        micBufferAudioStart = nil
        meetingBufferAudioStart = nil
        degradedBuffer = []
        bufferLock.unlock()

        onAudioChunk = nil
        onDeviceChangeError = nil
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

        var meetingPeakWindow: Float = 0.0
        var meetingPeakLastFlush = Date()
        let delegate = SystemAudioDelegate { [weak self] pcmData, floatSamples, level in
            guard let self = self else { return }

            // VAD path: feed the raw Float32 samples directly to the emitter.
            // Skip the legacy Int16 buffer entirely — the emitter owns its
            // own pre-roll ring and will emit on speech boundaries.
            if let emitter = self.meetingEmitter {
                emitter.ingest(samples: floatSamples)
            } else {
                self.bufferLock.lock()
                if self.meetingPCMBuffer.isEmpty {
                    // Wall clock of the oldest sample = now - duration of what we're about to append.
                    let appendDuration = Double(pcmData.count) / Self.bytesPerSecond
                    self.meetingBufferAudioStart = Date().addingTimeInterval(-appendDuration)
                }
                self.meetingPCMBuffer.append(pcmData)
                self.bufferLock.unlock()
            }

            meetingPeakWindow = max(meetingPeakWindow, level)
            let now = Date()
            if now.timeIntervalSince(meetingPeakLastFlush) >= 1.0 {
                appLog("[AudioCapture] meeting peak=\(String(format: "%.4f", meetingPeakWindow))")
                meetingPeakWindow = 0.0
                meetingPeakLastFlush = now
            }

            // Update audio level on main thread
            Task { @MainActor in
                self.audioLevel = level
            }
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
        let suspiciousTokens = ["BlackHole", "Loopback", "Aggregate", "Multi-Output", "Zoom"]
        let isVirtual = suspiciousTokens.contains { outputName.localizedCaseInsensitiveContains($0) }
        appLog("[AudioCapture] ScreenCaptureKit started. output=\"\(outputName)\" virtual=\(isVirtual) input=\"\(getDefaultDeviceName(selector: kAudioHardwarePropertyDefaultInputDevice))\"")
    }

    // MARK: - Microphone (AVAudioEngine)

    private func startMicrophoneCapture() throws {
        let engine = AVAudioEngine()
        let inputNode = engine.inputNode

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

    // MARK: - Device Changes

    private func handleOutputDeviceChange() {
        let newName = getDefaultDeviceName(selector: kAudioHardwarePropertyDefaultOutputDevice)
        appLog("[AudioCapture] Output device changed -> \"\(newName)\"")
        updateDeviceNames()
        // ScreenCaptureKit handles output device changes automatically.
    }

    private func handleInputDeviceChange() {
        let newName = getDefaultDeviceName(selector: kAudioHardwarePropertyDefaultInputDevice)
        appLog("[AudioCapture] Input device changed -> \"\(newName)\"")
        updateDeviceNames()

        // Skip restart if we're not actively capturing — the next startCapture
        // will pick up the current device on its own.
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

    private func updateDeviceNames() {
        currentOutputDevice = getDefaultDeviceName(selector: kAudioHardwarePropertyDefaultOutputDevice)
        currentInputDevice = getDefaultDeviceName(selector: kAudioHardwarePropertyDefaultInputDevice)
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
