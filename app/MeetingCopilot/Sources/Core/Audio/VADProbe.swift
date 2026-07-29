import Foundation
import CWhisperVAD

/// Thin Swift wrapper around whisper.cpp's Silero VAD C API.
///
/// - Loads the Silero model file once via `whisper_vad_init_from_file_with_params`.
/// - Exposes `probe(_:)` that runs detection on a Float32 PCM window and
///   returns the mean speech probability for that window.
/// - One instance per audio source (mic + meeting each get their own),
///   because the underlying `whisper_vad_context` is not documented as
///   thread-safe and each state machine needs independent state.
///
/// Input format: Float32 at 16 kHz. The caller is responsible for slicing
/// windows of the right size — Silero's native window is 30 ms = 480
/// samples, but whisper.cpp's VAD accepts larger windows too (it chunks
/// internally). We feed 30 ms windows so the state machine's timing is
/// tight.
final class VADProbe {
    private let ctx: OpaquePointer

    /// Initialises a VAD context from the given model file path.
    /// Returns nil if the model file can't be loaded (missing, corrupt,
    /// wrong format). Call site should fall back to the fixed-timer
    /// emitter in that case and log the failure.
    // The Silero model is under 1 MB and runs comfortably in realtime on CPU.
    // whisper.cpp 1.8.3 can abort (rather than return an error) while building
    // the mixed Metal/CPU VAD graph on pre-M5 Apple Silicon, so CPU is the
    // reliable production default.
    init?(modelPath: String, useGPU: Bool = false, threadCount: Int32 = 2) {
        guard FileManager.default.fileExists(atPath: modelPath) else {
            appLog("[VADProbe] model not found at \(modelPath)")
            return nil
        }

        var params = whisper_vad_default_context_params()
        params.use_gpu = useGPU
        params.n_threads = threadCount

        guard let ctx = modelPath.withCString({ cpath in
            whisper_vad_init_from_file_with_params(cpath, params)
        }) else {
            appLog("[VADProbe] whisper_vad_init_from_file_with_params returned null for \(modelPath)")
            return nil
        }
        self.ctx = ctx
        appLog("[VADProbe] loaded \(modelPath) (gpu=\(useGPU), threads=\(threadCount))")
    }

    deinit {
        whisper_vad_free(ctx)
    }

    /// Run VAD on a Float32 window and return the mean speech probability
    /// across all frames Silero produced for that window. Caller typically
    /// feeds 30 ms (480 samples) and gets back one probability value.
    ///
    /// Returns `nil` if detection failed (whisper.cpp returned false).
    func probe(samples: UnsafePointer<Float>, count: Int) -> Float? {
        let ok = whisper_vad_detect_speech(ctx, samples, Int32(count))
        guard ok else { return nil }

        let n = Int(whisper_vad_n_probs(ctx))
        guard n > 0, let probsPtr = whisper_vad_probs(ctx) else { return 0 }

        var sum: Float = 0
        for i in 0..<n {
            sum += probsPtr[i]
        }
        return sum / Float(n)
    }

    /// Convenience overload for Swift arrays.
    func probe(_ samples: [Float]) -> Float? {
        samples.withUnsafeBufferPointer { buf in
            guard let base = buf.baseAddress else { return nil }
            return probe(samples: base, count: buf.count)
        }
    }
}
