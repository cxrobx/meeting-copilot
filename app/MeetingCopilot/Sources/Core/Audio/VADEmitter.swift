import Foundation

/// Speech-boundary-driven chunk emitter. One instance per audio source
/// (mic + meeting). Consumes Float32 PCM at 16 kHz as it arrives from the
/// tap/delegate, runs Silero VAD on 30 ms windows, and emits an Int16 WAV
/// chunk when it detects a natural pause.
///
/// Replaces the fixed 3-second timer path in `AudioCaptureManager` when
/// `AppSettings.useVADEmitter` is on. Chunk emission arrives ~300 ms
/// after the speaker stops talking instead of after the next timer tick,
/// cutting perceived transcript latency from 2–4 s to 1–2 s.
///
/// Threading: all mutating state is confined to a private serial queue.
/// `ingest()` is safe to call from any thread (tap thread / SCK delegate
/// thread). Emit callbacks fire on the same serial queue — callers that
/// need main-actor work should hop there themselves.
final class VADEmitter {
    // MARK: - Config

    struct Config {
        static let sampleRate: Int = 16_000                     // Hz
        static let probeWindowMs: Int = 30                      // Silero native frame
        static let probeWindowSamples: Int =                    // 480
            sampleRate * probeWindowMs / 1000
        static let preRollMs: Int = 100                         // keep 100ms of pre-roll
        static let preRollSamples: Int =                        // 1600
            sampleRate * preRollMs / 1000
        /// Minimum silence to consider speech ended. Lower → more responsive
        /// but risks mid-sentence splits on quick breaths. 300 ms feels
        /// natural in testing (VoiceInk uses 100 ms but they're push-to-talk).
        static let defaultMinSilenceMs: Int = 300
        /// Cap a single utterance. If someone talks continuously for this
        /// long, force-emit and carry a small overlap forward so words at
        /// the boundary aren't cut in half.
        static let defaultMaxUtteranceSec: Double = 6.0
        /// Carry this much of the tail into the next emit when the
        /// max-utterance cap fires, so whisper has context continuity.
        static let maxUtteranceOverlapMs: Int = 500
        /// Speech probability threshold. Below = silence, above = speech.
        /// Matches whisper-server's config (VoiceInk's tuned value).
        static let defaultThreshold: Float = 0.50
    }

    // MARK: - State

    private enum State {
        case idle
        case speaking
        case trailingSilence(silenceSamples: Int)
    }

    private let source: TranscriptSegment.AudioSource
    private let probe: VADProbe
    private let threshold: Float
    private let minSilenceSamples: Int
    private let maxUtteranceSamples: Int
    private let maxUtteranceOverlapSamples: Int
    private let queue: DispatchQueue
    private let emitCallback: (Data, TranscriptSegment.AudioSource, AudioChunkMeta) -> Void

    // Bounded pre-roll ring (Float32). Always kept full with the most recent
    // 100ms so the start of an utterance isn't clipped by VAD's detection lag.
    private var preRoll: [Float] = []

    // Active utterance samples (Float32, grown while speaking). Converted to
    // Int16 PCM + WAV on emit.
    private var utterance: [Float] = []

    // 30ms Silero window accumulator. `probe()` fires when we fill it.
    private var probeWindow: [Float] = []

    // Wall-clock timestamp corresponding to the FIRST sample currently in
    // `utterance`. Derived from the ingest time minus the amount of audio
    // already seen — this is what makes captureStartedAt honest when the
    // emitter eventually produces a chunk.
    private var utteranceStartTime: Date?

    private var state: State = .idle
    private var sequence: Int = 0
    // True when the current utterance was seeded from a max-utterance-cap
    // carry. Cleared once the next emit completes. Passed through to the
    // server as AudioChunkMeta.isContinuation so dedup only runs on
    // chunks that actually share audio with their predecessor.
    private var pendingContinuation: Bool = false

    // MARK: - Init

    init(
        source: TranscriptSegment.AudioSource,
        probe: VADProbe,
        threshold: Float = Config.defaultThreshold,
        minSilenceMs: Int = Config.defaultMinSilenceMs,
        maxUtteranceSec: Double = Config.defaultMaxUtteranceSec,
        onEmit: @escaping (Data, TranscriptSegment.AudioSource, AudioChunkMeta) -> Void
    ) {
        self.source = source
        self.probe = probe
        self.threshold = threshold
        self.minSilenceSamples = Config.sampleRate * minSilenceMs / 1000
        self.maxUtteranceSamples = Int(Double(Config.sampleRate) * maxUtteranceSec)
        self.maxUtteranceOverlapSamples =
            Config.sampleRate * Config.maxUtteranceOverlapMs / 1000
        self.queue = DispatchQueue(label: "meeting-copilot.vad-emitter.\(source.rawValue)")
        self.emitCallback = onEmit

        // Reserve capacity so we don't churn allocations per frame.
        self.preRoll.reserveCapacity(Config.preRollSamples + 2048)
        self.utterance.reserveCapacity(maxUtteranceSamples + 2048)
        self.probeWindow.reserveCapacity(Config.probeWindowSamples)
    }

    // MARK: - Public API

    /// Ingest Float32 PCM samples at 16 kHz. Safe to call from any thread.
    /// Work is dispatched to the emitter's serial queue so VAD + state
    /// transitions run single-threaded.
    func ingest(samples: [Float]) {
        queue.async { [weak self] in
            self?.process(samples: samples)
        }
    }

    /// Emit any in-flight utterance immediately, regardless of state.
    /// Called on session.stop so the trailing partial utterance lands
    /// instead of being discarded mid-sentence.
    ///
    /// Returns the flushed chunk (if any) rather than firing emitCallback,
    /// so SessionManager can serially await its WebSocket send before
    /// transitioning state to `.ending` (which would cause subsequent
    /// sends to be dropped). The "normal" emit path still uses
    /// emitCallback via `emit()` — only flush returns.
    struct FlushedChunk {
        let wav: Data
        let source: TranscriptSegment.AudioSource
        let meta: AudioChunkMeta
    }

    func flush() -> FlushedChunk? {
        var result: FlushedChunk?
        queue.sync { [weak self] in
            guard let self = self, !self.utterance.isEmpty else { return }
            let snapshot = self.utterance
            let startTime = self.utteranceStartTime
            self.utterance.removeAll(keepingCapacity: true)
            self.utteranceStartTime = nil
            self.state = .idle
            self.sequence += 1

            let durationSec = Double(snapshot.count) / Double(Config.sampleRate)
            let capturedStart = startTime ?? Date().addingTimeInterval(-durationSec)
            let capturedEnd = capturedStart.addingTimeInterval(durationSec)
            let wav = AudioWAV.encode(float32Samples: snapshot)
            let meta = AudioChunkMeta(
                audioDurationSec: durationSec,
                captureStartedAt: capturedStart,
                captureEndedAt: capturedEnd,
                sequence: self.sequence,
                isContinuation: self.pendingContinuation
            )
            self.pendingContinuation = false
            appLog("[VADEmitter:\(self.source.rawValue)] flush seq=\(self.sequence) duration=\(String(format: "%.2f", durationSec))s")
            result = FlushedChunk(wav: wav, source: self.source, meta: meta)
        }
        return result
    }

    /// Reset internal state without emitting. Used at session.stop after
    /// flush has drained, or when the emitter is torn down.
    func reset() {
        queue.sync { [weak self] in
            guard let self = self else { return }
            self.preRoll.removeAll(keepingCapacity: true)
            self.utterance.removeAll(keepingCapacity: true)
            self.probeWindow.removeAll(keepingCapacity: true)
            self.state = .idle
            self.sequence = 0
            self.utteranceStartTime = nil
        }
    }

    // MARK: - Core loop (runs on `queue`)

    private func process(samples: [Float]) {
        for sample in samples {
            appendToPreRoll(sample)
            if case .speaking = state { utterance.append(sample) }
            if case .trailingSilence = state { utterance.append(sample) }
            probeWindow.append(sample)

            if probeWindow.count >= Config.probeWindowSamples {
                evaluateWindow()
            }

            // Force-emit if someone's been talking without a pause for
            // maxUtteranceSec. Keep the last N samples as an overlap so
            // words at the boundary stay intact.
            if case .speaking = state, utterance.count >= maxUtteranceSamples {
                forceEmitWithCarry()
            }
        }
    }

    private func appendToPreRoll(_ sample: Float) {
        if preRoll.count >= Config.preRollSamples {
            preRoll.removeFirst()
        }
        preRoll.append(sample)
    }

    private func evaluateWindow() {
        let windowCopy = probeWindow
        probeWindow.removeAll(keepingCapacity: true)

        let probability = probe.probe(windowCopy) ?? 0
        let isSpeech = probability >= threshold

        switch state {
        case .idle:
            if isSpeech {
                // Transition to speaking. Seed the utterance with the
                // pre-roll ring, which ALREADY contains the current
                // windowCopy samples at its tail (process() appends to
                // preRoll before evaluateWindow runs). Appending
                // windowCopy separately here would double the onset
                // frame and inflate the emitted chunk's duration by
                // 30ms. Just pre-roll is enough.
                utterance.append(contentsOf: preRoll)
                utteranceStartTime = Date()
                    .addingTimeInterval(-Double(utterance.count) / Double(Config.sampleRate))
                state = .speaking
            }
            // else: stay idle

        case .speaking:
            if !isSpeech {
                // Entering trailing silence. Count samples of silence we've
                // accumulated — when we hit minSilenceSamples, emit.
                state = .trailingSilence(silenceSamples: windowCopy.count)
            }
            // else: still speaking, samples are already being accumulated

        case .trailingSilence(let accumulated):
            if isSpeech {
                // False alarm — speaker resumed. Go back to speaking.
                state = .speaking
            } else {
                let newTotal = accumulated + windowCopy.count
                if newTotal >= minSilenceSamples {
                    emitAndReset(reason: "silence")
                } else {
                    state = .trailingSilence(silenceSamples: newTotal)
                }
            }
        }
    }

    private func forceEmitWithCarry() {
        guard utterance.count > maxUtteranceOverlapSamples else {
            emitAndReset(reason: "max-utterance-no-carry")
            return
        }

        // Split: emit the leading portion, keep the trailing overlap as the
        // seed for the next utterance so continuous speakers don't lose a
        // word at the boundary.
        let emitCount = utterance.count - maxUtteranceOverlapSamples
        let emitPortion = Array(utterance.prefix(emitCount))
        let carry = Array(utterance.suffix(maxUtteranceOverlapSamples))

        let carryStartTime = (utteranceStartTime ?? Date())
            .addingTimeInterval(Double(emitCount) / Double(Config.sampleRate))

        emit(samples: emitPortion, startTime: utteranceStartTime, reason: "max-utterance")

        // Continue in speaking state with the carry already in the buffer.
        // Flag the NEXT emit as a continuation so the server's suffix/prefix
        // dedup trims the 500ms overlap. Without this flag, dedup would
        // only run when the audio actually shares text — brittle if the
        // speaker says the same word twice without carry.
        utterance = carry
        utteranceStartTime = carryStartTime
        state = .speaking
        pendingContinuation = true
    }

    private func emitAndReset(reason: String) {
        let snapshot = utterance
        let startTime = utteranceStartTime
        utterance.removeAll(keepingCapacity: true)
        utteranceStartTime = nil
        state = .idle
        emit(samples: snapshot, startTime: startTime, reason: reason)
    }

    private func emit(samples: [Float], startTime: Date?, reason: String) {
        guard !samples.isEmpty else { return }
        sequence += 1

        let durationSec = Double(samples.count) / Double(Config.sampleRate)
        let endTime = Date()
        let capturedStart = startTime ?? endTime.addingTimeInterval(-durationSec)
        let capturedEnd = capturedStart.addingTimeInterval(durationSec)

        let wav = AudioWAV.encode(float32Samples: samples)
        let meta = AudioChunkMeta(
            audioDurationSec: durationSec,
            captureStartedAt: capturedStart,
            captureEndedAt: capturedEnd,
            sequence: sequence,
            isContinuation: pendingContinuation
        )
        // Clear after building meta — the FLAG applies to THIS emit only.
        // If a max-utterance force-emit set it, the next silence-triggered
        // emit from the continuing utterance also inherits it (because the
        // carry samples ARE shared audio). Subsequent emits clear it.
        pendingContinuation = false

        appLog("[VADEmitter:\(source.rawValue)] emit seq=\(sequence) duration=\(String(format: "%.2f", durationSec))s reason=\(reason)\(meta.isContinuation ? " continuation" : "")")
        emitCallback(wav, source, meta)
    }

}
