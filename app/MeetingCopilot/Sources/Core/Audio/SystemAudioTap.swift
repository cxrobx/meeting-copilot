import Foundation
import CoreAudio
import AudioToolbox
import AVFoundation

/// Meeting-side audio from a Core Audio process tap (macOS 14.2+).
///
/// Why this exists: ScreenCaptureKit's per-app filter (gotcha #12's
/// workaround) only sees *applications*. Calls handed off from an iPhone and
/// FaceTime calls are played by system daemons — `avconferenced` and
/// `callservicesd` — that never appear in `SCShareableContent.applications`,
/// so the other side of a phone call was silently missing. A global tap sees
/// every process's output, daemons included. Verified 2026-09-21 on a live
/// Continuity call (macOS 14.5, AirPods): the remote party on the tap, the
/// user on the mic, no bleed between them. See gotcha #20.
///
/// Shape: a mono global tap that excludes our own process → a private,
/// TAP-ONLY aggregate device → an IOProc that resamples to 16 kHz mono
/// Float32 (invariant #4). Tap-only on purpose: an aggregate that also lists
/// the output device picks up that device's INPUT streams whenever it has any
/// (headsets, the Teams/Zoom virtual devices), which would leak the user's
/// own mic into the meeting track.
///
/// Permission: "System Audio Recording" (`NSAudioCaptureUsageDescription`).
/// macOS prompts the first time the aggregate starts, and `AudioDeviceStart`
/// blocks while that prompt is up — call `start()` off the main thread.
/// There is no API to read the grant, and a denied tap delivers zero-filled
/// buffers with `noErr`, so a silent track is the only symptom; the capture
/// watchdog in `AudioCaptureManager` turns that into a warning.
///
/// Nothing is written to disk (invariant #1): samples go straight to the
/// handler.
///
/// Thread model: `start()` / `stop()` are called serially by
/// `AudioCaptureManager`. Everything the IOProc touches (`converter`,
/// `sourceRate`, the rate-tracking window) is either set before
/// `AudioDeviceStart` or mutated only on `ioQueue`, where the IOProc runs.
@available(macOS 14.2, *)
final class SystemAudioTap: @unchecked Sendable {
    /// Receives 16 kHz mono Float32 samples (clamped to ±1) and their peak.
    typealias SampleHandler = (_ samples: [Float], _ peak: Float) -> Void

    static let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: Double(AudioCaptureManager.sampleRate),
        channels: AVAudioChannelCount(AudioCaptureManager.channelCount),
        interleaved: false
    )!

    private let onSamples: SampleHandler
    private let ioQueue = DispatchQueue(label: "com.meetingcopilot.system-tap", qos: .userInteractive)

    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?

    private var sourceRate: Double = 0
    private var sourceFormat: AVAudioFormat?
    private var converter: AVAudioConverter?

    // Measured-vs-reported sample-rate check. AirPods drop from 48 kHz to a
    // call rate (16/24 kHz) when a call starts WITHOUT the default output
    // device changing, and resampling from the wrong rate would hand whisper
    // sped-up or slowed-down audio. The reported rate is re-read once a second;
    // the measured rate is the backstop if the report never moves.
    private var windowStartNs: UInt64 = 0
    private var framesInWindow = 0
    private var rateMismatchStreak = 0

    init(onSamples: @escaping SampleHandler) {
        self.onSamples = onSamples
    }

    deinit {
        stop()
    }

    // MARK: - Lifecycle

    func start() throws {
        stop()
        do {
            try build()
        } catch {
            stop()
            throw error
        }
    }

    func stop() {
        if let procID = ioProcID {
            AudioDeviceStop(aggregateID, procID)
            AudioDeviceDestroyIOProcID(aggregateID, procID)
            ioProcID = nil
        }
        if aggregateID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }

    private func build() throws {
        // Excluding ourselves mirrors ScreenCaptureKit's
        // `excludesCurrentProcessAudio`. Best effort: if the lookup fails the
        // tap still works, it just also hears anything this process plays.
        let own = Self.processObject(for: getpid())
        let description = CATapDescription(monoGlobalTapButExcludeProcesses: own.map { [$0] } ?? [])
        description.name = "Meeting Copilot"
        description.uuid = UUID()
        description.isPrivate = true
        // Never .mutedWhenTapped: tapping avconferenced that way muted the call
        // itself and made the remote party hear themselves (FineTune #113).
        description.muteBehavior = .unmuted

        try Self.check(AudioHardwareCreateProcessTap(description, &tapID), "create process tap")

        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Meeting Copilot System Audio",
            kAudioAggregateDeviceUIDKey: "com.christopherrobinson.meeting-copilot.tap.\(UUID().uuidString)",
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapUIDKey: description.uuid.uuidString,
                kAudioSubTapDriftCompensationKey: true,
            ]],
        ]
        try Self.check(
            AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID),
            "create aggregate device"
        )

        guard let rate = reportedRate(), rate > 0 else {
            throw SystemAudioTapError.noSampleRate
        }
        configure(rate: rate)
        // A rebuild (output-device change) must not judge its first window
        // against the previous aggregate's clock.
        windowStartNs = 0
        framesInWindow = 0
        rateMismatchStreak = 0

        try Self.check(
            AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, ioQueue) { [weak self] _, inputData, _, _, _ in
                self?.process(inputData)
            },
            "create IOProc"
        )
        try Self.check(AudioDeviceStart(aggregateID, ioProcID), "start aggregate device")
        appLog("[SystemAudioTap] started rate=\(Int(rate))Hz excludedOwnProcess=\(own != nil)")
    }

    // MARK: - IO

    private func process(_ inputData: UnsafePointer<AudioBufferList>) {
        let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
        // Tap-only aggregate ⇒ exactly one input stream. `last` is still the
        // right pick if a subdevice ever sneaks in: taps follow subdevices.
        guard let buffer = buffers.last, let data = buffer.mData else { return }
        let channels = Int(max(buffer.mNumberChannels, 1))
        let frames = Int(buffer.mDataByteSize) / (MemoryLayout<Float>.size * channels)
        guard frames > 0 else { return }

        trackRate(frames: frames)
        guard let format = sourceFormat,
              let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let mono = input.floatChannelData?[0] else { return }
        input.frameLength = AVAudioFrameCount(frames)

        // The tap is mono by construction; downmix anyway rather than trust it.
        let source = data.assumingMemoryBound(to: Float.self)
        if channels == 1 {
            mono.update(from: source, count: frames)
        } else {
            for frame in 0..<frames {
                var sum: Float = 0
                for channel in 0..<channels { sum += source[frame * channels + channel] }
                mono[frame] = sum / Float(channels)
            }
        }

        let output: AVAudioPCMBuffer
        if let converter {
            let capacity = AVAudioFrameCount((Double(frames) * Self.targetFormat.sampleRate / sourceRate).rounded(.up))
            guard let converted = AVAudioPCMBuffer(pcmFormat: Self.targetFormat, frameCapacity: capacity) else { return }
            var error: NSError?
            var consumed = false
            converter.convert(to: converted, error: &error) { _, status in
                if consumed {
                    status.pointee = .noDataNow
                    return nil
                }
                consumed = true
                status.pointee = .haveData
                return input
            }
            if error != nil { return }
            output = converted
        } else {
            output = input
        }

        guard let samples = output.floatChannelData?[0] else { return }
        let count = Int(output.frameLength)
        guard count > 0 else { return }
        var clamped = [Float](repeating: 0, count: count)
        var peak: Float = 0
        for i in 0..<count {
            let sample = max(-1.0, min(1.0, samples[i]))
            clamped[i] = sample
            peak = max(peak, abs(sample))
        }
        onSamples(clamped, peak)
    }

    /// Runs on `ioQueue`. Re-reads the reported rate once a second and, as a
    /// backstop, snaps to the measured rate after two consecutive windows that
    /// disagree by more than 25%.
    private func trackRate(frames: Int) {
        let now = DispatchTime.now().uptimeNanoseconds
        if windowStartNs == 0 { windowStartNs = now }
        framesInWindow += frames
        let elapsed = Double(now - windowStartNs) / 1_000_000_000
        guard elapsed >= 1.0 else { return }
        let measured = Double(framesInWindow) / elapsed
        framesInWindow = 0
        windowStartNs = now

        if let reported = reportedRate(), reported > 0, reported != sourceRate {
            appLog("[SystemAudioTap] reported rate changed \(Int(sourceRate))Hz → \(Int(reported))Hz")
            configure(rate: reported)
            rateMismatchStreak = 0
            return
        }
        rateMismatchStreak = Self.isRateMismatch(measured: measured, expected: sourceRate) ? rateMismatchStreak + 1 : 0
        if rateMismatchStreak >= 2 {
            let snapped = Self.nearestStandardRate(to: measured)
            appLog("[SystemAudioTap] RATE MISMATCH reported=\(Int(sourceRate))Hz measured=\(Int(measured))Hz — resampling from \(Int(snapped))Hz")
            configure(rate: snapped)
            rateMismatchStreak = 0
        }
    }

    private func configure(rate: Double) {
        sourceRate = rate
        sourceFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)
        converter = rate == Self.targetFormat.sampleRate
            ? nil
            : sourceFormat.flatMap { AVAudioConverter(from: $0, to: Self.targetFormat) }
    }

    private func reportedRate() -> Double? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var rate: Float64 = 0
        var size = UInt32(MemoryLayout<Float64>.size)
        guard AudioObjectGetPropertyData(aggregateID, &address, 0, nil, &size, &rate) == noErr else { return nil }
        return rate
    }

    // MARK: - Pure helpers (unit-tested)

    static let standardRates: [Double] = [8_000, 11_025, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000]

    /// The standard hardware rate closest to a measured frames-per-second.
    static func nearestStandardRate(to measured: Double) -> Double {
        standardRates.min { abs($0 - measured) < abs($1 - measured) } ?? measured
    }

    /// True when a measured rate is too far from the expected one to be jitter.
    /// 25% sits well above one-callback edge jitter (512 frames ≈ 1% at 48 kHz)
    /// and well below the smallest real switch (48 → 32 kHz is 33%).
    static func isRateMismatch(measured: Double, expected: Double) -> Bool {
        guard expected > 0 else { return true }
        return abs(measured - expected) / expected > 0.25
    }

    // MARK: - Core Audio plumbing

    private static func processObject(for pid: pid_t) -> AudioObjectID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var pid = pid
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address,
            UInt32(MemoryLayout<pid_t>.size), &pid, &size, &object
        )
        return status == noErr && object != kAudioObjectUnknown ? object : nil
    }

    private static func check(_ status: OSStatus, _ step: String) throws {
        guard status == noErr else { throw SystemAudioTapError.coreAudio(step: step, status: status) }
    }
}

enum SystemAudioTapError: Error, LocalizedError {
    case coreAudio(step: String, status: OSStatus)
    case noSampleRate

    var errorDescription: String? {
        switch self {
        case .coreAudio(let step, let status): return "System audio tap: \(step) failed (OSStatus \(status))"
        case .noSampleRate: return "System audio tap: aggregate device reported no sample rate"
        }
    }
}
