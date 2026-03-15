import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import CoreAudio

// MARK: - Audio Capture Manager

/// Manages both system audio (via ScreenCaptureKit) and microphone audio (via AVAudioEngine).
/// Produces 16kHz mono PCM chunks (10s with 2s overlap), base64-encoded for WebSocket transport.
@Observable
final class AudioCaptureManager: NSObject {
    // MARK: - Configuration

    static let sampleRate: Int = 16_000
    static let channelCount: Int = 1
    static let bitsPerSample: Int = 16
    static let chunkDurationSeconds: TimeInterval = 10.0
    static let chunkOverlapSeconds: TimeInterval = 2.0

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
    private let bufferLock = NSLock()

    private var chunkTimer: Timer?
    private var onAudioChunk: ((Data, TranscriptSegment.AudioSource) -> Void)?
    private var onDeviceChangeError: (() -> Void)?

    // Degraded mode buffering (up to 60s)
    private var degradedBuffer: [(Data, TranscriptSegment.AudioSource)] = []
    private let maxDegradedBufferDuration: TimeInterval = 60.0

    // MARK: - Start Capture

    func startCapture(
        onChunk: @escaping (Data, TranscriptSegment.AudioSource) -> Void,
        onDeviceError: @escaping () -> Void
    ) async throws {
        self.onAudioChunk = onChunk
        self.onDeviceChangeError = onDeviceError

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
        degradedBuffer = []
        bufferLock.unlock()

        onAudioChunk = nil
        onDeviceChangeError = nil
    }

    // MARK: - Degraded Mode

    /// Buffer a chunk during degraded mode for later replay.
    func bufferDegradedChunk(_ data: Data, source: TranscriptSegment.AudioSource) {
        bufferLock.lock()
        degradedBuffer.append((data, source))
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

        for (data, source) in buffered {
            onAudioChunk?(data, source)
        }
    }

    // MARK: - System Audio (ScreenCaptureKit)

    private func startSystemAudioCapture() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

        guard let display = content.displays.first else {
            throw AudioCaptureError.noDisplayFound
        }

        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])

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

        let delegate = SystemAudioDelegate { [weak self] pcmData, level in
            guard let self = self else { return }
            self.bufferLock.lock()
            self.meetingPCMBuffer.append(pcmData)
            self.bufferLock.unlock()
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

            for i in 0..<frameCount {
                let sample = floatData[0][i]
                let clamped = max(-1.0, min(1.0, sample))
                let int16Value = Int16(clamped * Float(Int16.max))
                withUnsafeBytes(of: int16Value.littleEndian) { bytes in
                    int16Data.append(contentsOf: bytes)
                }
            }

            self.bufferLock.lock()
            self.micPCMBuffer.append(int16Data)
            self.bufferLock.unlock()
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

        bufferLock.lock()

        // Emit meeting audio chunk
        if meetingPCMBuffer.count >= bytesPerChunk {
            let chunkData = meetingPCMBuffer.prefix(bytesPerChunk)
            let wavData = createWAVData(pcmData: Data(chunkData))
            // Keep overlap for next chunk
            let removeCount = bytesPerChunk - overlapBytes
            meetingPCMBuffer.removeFirst(min(removeCount, meetingPCMBuffer.count))
            bufferLock.unlock()
            onAudioChunk?(wavData, .meeting)
        } else {
            bufferLock.unlock()
        }

        bufferLock.lock()
        // Emit mic audio chunk
        if micPCMBuffer.count >= bytesPerChunk {
            let chunkData = micPCMBuffer.prefix(bytesPerChunk)
            let wavData = createWAVData(pcmData: Data(chunkData))
            let removeCount = bytesPerChunk - overlapBytes
            micPCMBuffer.removeFirst(min(removeCount, micPCMBuffer.count))
            bufferLock.unlock()
            onAudioChunk?(wavData, .mic)
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

    var errorDescription: String? {
        switch self {
        case .noDisplayFound: return "No display found for screen capture"
        case .microphoneUnavailable: return "Microphone is not available"
        case .screenCapturePermissionDenied: return "Screen recording permission not granted"
        }
    }
}
