import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import CoreAudio
import CoreGraphics
import AppKit

// MARK: - Audio Chunk Metadata

/// Metadata attached to every emitted audio chunk so the server can measure
/// true end-to-end latency (`captureEndedAt → transcript.broadcast`) and
/// detect out-of-order delivery. Emitted alongside the WAV buffer.
struct AudioChunkMeta: Sendable {
    let audioDurationSec: Double
    let captureStartedAt: Date
    let captureEndedAt: Date
    let sequence: Int
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

    // Degraded mode buffering (up to 60s)
    private var degradedBuffer: [(Data, TranscriptSegment.AudioSource, AudioChunkMeta)] = []
    private let maxDegradedBufferDuration: TimeInterval = 60.0

    // MARK: - Start Capture

    func startCapture(
        onChunk: @escaping (Data, TranscriptSegment.AudioSource, AudioChunkMeta) -> Void,
        onDeviceError: @escaping () -> Void
    ) async throws {
        self.onAudioChunk = onChunk
        self.onDeviceChangeError = onDeviceError
        self.micSequence = 0
        self.meetingSequence = 0

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

            // Start chunk timer
            startChunkTimer()

            // Update device names
            updateDeviceNames()

            isCapturing = true
        } catch {
            await stopCapture()
            throw error
        }
    }

    // MARK: - Stop Capture

    func stopCapture() async {
        isCapturing = false

        // Stop chunk timer
        chunkTimer?.invalidate()
        chunkTimer = nil

        // Stop system audio
        if let stream = scStream {
            try? await stream.stopCapture()
            scStream = nil
        }
        systemAudioDelegate = nil

        // Stop microphone
        if let engine = audioEngine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
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
    func bufferDegradedChunk(_ data: Data, source: TranscriptSegment.AudioSource, meta: AudioChunkMeta) {
        bufferLock.lock()
        degradedBuffer.append((data, source, meta))
        // Drop oldest chunks when buffer exceeds max duration to preserve recent context
        let maxChunks = Int(maxDegradedBufferDuration / (Self.chunkDurationSeconds - Self.chunkOverlapSeconds))
        while degradedBuffer.count > maxChunks {
            degradedBuffer.removeFirst()
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
        let delegate = SystemAudioDelegate { [weak self] pcmData, level in
            guard let self = self else { return }
            self.bufferLock.lock()
            if self.meetingPCMBuffer.isEmpty {
                // Wall clock of the oldest sample = now - duration of what we're about to append.
                let appendDuration = Double(pcmData.count) / Self.bytesPerSecond
                self.meetingBufferAudioStart = Date().addingTimeInterval(-appendDuration)
            }
            self.meetingPCMBuffer.append(pcmData)
            self.bufferLock.unlock()

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
        let hardwareFormat = inputNode.inputFormat(forBus: 0)

        let desiredFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(Self.sampleRate),
            channels: AVAudioChannelCount(Self.channelCount),
            interleaved: false
        )!

        let needsConversion = hardwareFormat.sampleRate != Double(Self.sampleRate) ||
                              hardwareFormat.channelCount != AVAudioChannelCount(Self.channelCount)

        var converter: AVAudioConverter?
        if needsConversion {
            converter = AVAudioConverter(from: hardwareFormat, to: desiredFormat)
        }

        let captureFormat = (needsConversion && converter != nil) ? hardwareFormat : desiredFormat

        var micPeakWindow: Float = 0.0
        var micPeakLastFlush = Date()
        inputNode.installTap(onBus: 0, bufferSize: 4096, format: captureFormat) { [weak self] buffer, _ in
            guard let self = self else { return }

            var processBuffer: AVAudioPCMBuffer

            if let converter = converter {
                let frameCapacity = AVAudioFrameCount(
                    Double(buffer.frameLength) * desiredFormat.sampleRate / captureFormat.sampleRate
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

            // Convert Float32 to Int16 PCM
            guard let floatData = processBuffer.floatChannelData else { return }
            let frameCount = Int(processBuffer.frameLength)
            var int16Data = Data(capacity: frameCount * MemoryLayout<Int16>.size)
            var localPeak: Float = 0.0

            for i in 0..<frameCount {
                let sample = floatData[0][i]
                let clamped = max(-1.0, min(1.0, sample))
                localPeak = max(localPeak, abs(clamped))
                let int16Value = Int16(clamped * Float(Int16.max))
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

            micPeakWindow = max(micPeakWindow, localPeak)
            let now = Date()
            if now.timeIntervalSince(micPeakLastFlush) >= 1.0 {
                appLog("[AudioCapture] mic peak=\(String(format: "%.4f", micPeakWindow))")
                micPeakWindow = 0.0
                micPeakLastFlush = now
            }
        }

        engine.prepare()
        try engine.start()
        self.audioEngine = engine
        self.audioConverter = converter
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
            let wavData = createWAVData(pcmData: Data(chunkData))
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
            let meta = AudioChunkMeta(
                audioDurationSec: Self.chunkDurationSeconds,
                captureStartedAt: capturedStart,
                captureEndedAt: capturedEnd,
                sequence: meetingSequence
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
            let wavData = createWAVData(pcmData: Data(chunkData))
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
                sequence: micSequence
            )
            bufferLock.unlock()
            onAudioChunk?(wavData, .mic, micMeta)
        } else {
            bufferLock.unlock()
        }
    }

    // MARK: - WAV Encoding

    private func createWAVData(pcmData: Data) -> Data {
        let sampleRate = Self.sampleRate
        let channels = Self.channelCount
        let bitsPerSample = Self.bitsPerSample
        let byteRate = sampleRate * channels * (bitsPerSample / 8)
        let blockAlign = channels * (bitsPerSample / 8)
        let dataSize = UInt32(pcmData.count)
        let fileSize = 36 + dataSize

        var header = Data()

        // RIFF header
        header.append(contentsOf: "RIFF".utf8)
        header.append(contentsOf: withUnsafeBytes(of: fileSize.littleEndian) { Array($0) })
        header.append(contentsOf: "WAVE".utf8)

        // fmt chunk
        header.append(contentsOf: "fmt ".utf8)
        header.append(contentsOf: withUnsafeBytes(of: UInt32(16).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt16(channels).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt32(sampleRate).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt32(byteRate).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt16(blockAlign).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt16(bitsPerSample).littleEndian) { Array($0) })

        // data chunk
        header.append(contentsOf: "data".utf8)
        header.append(contentsOf: withUnsafeBytes(of: dataSize.littleEndian) { Array($0) })

        var fileData = header
        fileData.append(pcmData)
        return fileData
    }

    // MARK: - Device Changes

    private func handleOutputDeviceChange() {
        print("[AudioCapture] Output device changed")
        updateDeviceNames()
        // ScreenCaptureKit handles device changes automatically
    }

    private func handleInputDeviceChange() {
        print("[AudioCapture] Input device changed")
        updateDeviceNames()

        // Attempt to restart microphone capture
        if let engine = audioEngine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }

        do {
            try startMicrophoneCapture()
        } catch {
            print("[AudioCapture] Failed to re-acquire microphone: \(error)")
            onDeviceChangeError?()
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
    private let onPCMData: (Data, Float) -> Void

    init(onPCMData: @escaping (Data, Float) -> Void) {
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

        // Convert Float32 to Int16 PCM
        let floatCount = length / MemoryLayout<Float32>.size
        var int16Data = Data(capacity: floatCount * MemoryLayout<Int16>.size)
        var peakLevel: Float = 0.0

        rawData.withUnsafeBytes { rawBufferPointer in
            let floatBuffer = rawBufferPointer.bindMemory(to: Float32.self)
            for i in 0..<floatCount {
                let sample = floatBuffer[i]
                let clamped = max(-1.0, min(1.0, sample))
                peakLevel = max(peakLevel, abs(clamped))
                let int16Value = Int16(clamped * Float32(Int16.max))
                withUnsafeBytes(of: int16Value.littleEndian) { bytes in
                    int16Data.append(contentsOf: bytes)
                }
            }
        }

        onPCMData(int16Data, peakLevel)
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
