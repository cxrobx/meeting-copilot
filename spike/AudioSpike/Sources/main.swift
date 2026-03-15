import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import CoreAudio

// MARK: - Configuration

let captureDurationSeconds: Int = 30
let sampleRate: Int = 16_000
let channelCount: Int = 1
let bitsPerSample: Int = 16

// MARK: - WAV Writer

func writeWAV(pcmData: Data, sampleRate: Int, channels: Int, bitsPerSample: Int, to url: URL) throws {
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
    header.append(contentsOf: withUnsafeBytes(of: UInt32(16).littleEndian) { Array($0) })   // chunk size
    header.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian) { Array($0) })    // PCM format
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

    try fileData.write(to: url)
}

// MARK: - SCStream Output Delegate

class AudioCaptureDelegate: NSObject, SCStreamOutput {
    let lock = NSLock()
    var pcmData = Data()
    var sampleCount: Int = 0
    var droppedCount: Int = 0
    var lastReportTime: Date = Date()
    var samplesThisSecond: Int = 0
    let label: String

    init(label: String) {
        self.label = label
        super.init()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }

        guard sampleBuffer.isValid, sampleBuffer.numSamples > 0 else {
            lock.lock()
            droppedCount += 1
            lock.unlock()
            return
        }

        // Extract audio data from CMSampleBuffer
        guard let blockBuffer = sampleBuffer.dataBuffer else {
            lock.lock()
            droppedCount += 1
            lock.unlock()
            return
        }

        let length = CMBlockBufferGetDataLength(blockBuffer)
        var rawData = Data(count: length)
        rawData.withUnsafeMutableBytes { rawBufferPointer in
            guard let baseAddress = rawBufferPointer.baseAddress else { return }
            CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: baseAddress)
        }

        // The audio comes as Float32 from ScreenCaptureKit; convert to Int16 PCM
        let floatCount = length / MemoryLayout<Float32>.size
        var int16Data = Data(capacity: floatCount * MemoryLayout<Int16>.size)

        rawData.withUnsafeBytes { rawBufferPointer in
            let floatBuffer = rawBufferPointer.bindMemory(to: Float32.self)
            for i in 0..<floatCount {
                let sample = floatBuffer[i]
                let clamped = max(-1.0, min(1.0, sample))
                let int16Value = Int16(clamped * Float32(Int16.max))
                withUnsafeBytes(of: int16Value.littleEndian) { bytes in
                    int16Data.append(contentsOf: bytes)
                }
            }
        }

        lock.lock()
        pcmData.append(int16Data)
        sampleCount += Int(sampleBuffer.numSamples)
        samplesThisSecond += Int(sampleBuffer.numSamples)

        let now = Date()
        if now.timeIntervalSince(lastReportTime) >= 1.0 {
            let rate = samplesThisSecond
            samplesThisSecond = 0
            lastReportTime = now
            lock.unlock()
            print("  [\(label)] Samples/sec: \(rate), Total samples: \(sampleCount), Dropped: \(droppedCount)")
        } else {
            lock.unlock()
        }
    }

    func getData() -> Data {
        lock.lock()
        defer { lock.unlock() }
        return pcmData
    }

    func getTotalSamples() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return sampleCount
    }

    func getDroppedCount() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return droppedCount
    }
}

// MARK: - Audio Route Change Observer

class AudioRouteObserver {
    private var defaultOutputListenerBlock: AudioObjectPropertyListenerBlock?
    private var defaultInputListenerBlock: AudioObjectPropertyListenerBlock?

    init() {
        // Listen for default output device changes
        var outputAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        defaultOutputListenerBlock = { (_, _) in
            print("[Route Change] Default output device changed - continuing capture")
        }

        AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &outputAddress,
            DispatchQueue.main,
            defaultOutputListenerBlock!
        )

        // Listen for default input device changes
        var inputAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        defaultInputListenerBlock = { (_, _) in
            print("[Route Change] Default input device changed - continuing capture")
        }

        AudioObjectAddPropertyListenerBlock(
            AudioObjectID(kAudioObjectSystemObject),
            &inputAddress,
            DispatchQueue.main,
            defaultInputListenerBlock!
        )
    }

    deinit {
        var outputAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        if let block = defaultOutputListenerBlock {
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
        if let block = defaultInputListenerBlock {
            AudioObjectRemovePropertyListenerBlock(
                AudioObjectID(kAudioObjectSystemObject),
                &inputAddress,
                DispatchQueue.main,
                block
            )
        }
    }
}

// MARK: - Microphone Capture

class MicrophoneCapture {
    let audioEngine = AVAudioEngine()
    let lock = NSLock()
    var pcmData = Data()
    var sampleCount: Int = 0
    var samplesThisSecond: Int = 0
    var lastReportTime: Date = Date()

    func start() throws {
        let inputNode = audioEngine.inputNode
        let hardwareFormat = inputNode.inputFormat(forBus: 0)

        print("[Mic] Hardware format: \(hardwareFormat)")

        // We'll capture at native format and convert
        let desiredFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(sampleRate),
            channels: AVAudioChannelCount(channelCount),
            interleaved: false
        )!

        // If hardware sample rate differs, we need a converter
        let needsConversion = hardwareFormat.sampleRate != Double(sampleRate) ||
                              hardwareFormat.channelCount != AVAudioChannelCount(channelCount)

        var converter: AVAudioConverter?
        if needsConversion {
            converter = AVAudioConverter(from: hardwareFormat, to: desiredFormat)
            if converter == nil {
                print("[Mic] WARNING: Could not create format converter, capturing at hardware format")
            }
        }

        let captureFormat = needsConversion && converter != nil ? hardwareFormat : desiredFormat

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: captureFormat) { [weak self] buffer, _ in
            guard let self = self else { return }

            var processBuffer: AVAudioPCMBuffer

            if let converter = converter {
                // Convert to target format
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

                if let error = error {
                    print("[Mic] Conversion error: \(error)")
                    return
                }
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

            self.lock.lock()
            self.pcmData.append(int16Data)
            self.sampleCount += frameCount
            self.samplesThisSecond += frameCount

            let now = Date()
            if now.timeIntervalSince(self.lastReportTime) >= 1.0 {
                let rate = self.samplesThisSecond
                self.samplesThisSecond = 0
                self.lastReportTime = now
                self.lock.unlock()
                print("  [Mic] Samples/sec: \(rate), Total samples: \(self.sampleCount)")
            } else {
                self.lock.unlock()
            }
        }

        audioEngine.prepare()
        try audioEngine.start()
        print("[Mic] Audio engine started")
    }

    func stop() {
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        print("[Mic] Audio engine stopped")
    }

    func getData() -> Data {
        lock.lock()
        defer { lock.unlock() }
        return pcmData
    }

    func getTotalSamples() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return sampleCount
    }
}

// MARK: - Main Entry Point

func printAudioDeviceInfo() {
    print("=== Audio Device Info ===")

    // List audio devices using CoreAudio
    var propertyAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )

    var dataSize: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject),
        &propertyAddress,
        0, nil,
        &dataSize
    )

    guard status == noErr else {
        print("  Could not query audio devices: \(status)")
        return
    }

    let deviceCount = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
    var deviceIDs = [AudioDeviceID](repeating: 0, count: deviceCount)

    status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &propertyAddress,
        0, nil,
        &dataSize,
        &deviceIDs
    )

    guard status == noErr else {
        print("  Could not get audio devices: \(status)")
        return
    }

    print("  Found \(deviceCount) audio device(s):")

    for deviceID in deviceIDs {
        var namePropertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceNameCFString,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )

        var nameSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var nameRef: Unmanaged<CFString>?
        let nameStatus = AudioObjectGetPropertyData(
            deviceID,
            &namePropertyAddress,
            0, nil,
            &nameSize,
            &nameRef
        )

        if nameStatus == noErr, let cfName = nameRef?.takeRetainedValue() {
            print("    - [\(deviceID)] \(cfName as String)")
        }
    }

    // Default input device
    var defaultInputAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var defaultInput: AudioDeviceID = 0
    var defaultInputSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    if AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &defaultInputAddress, 0, nil, &defaultInputSize, &defaultInput) == noErr {
        print("  Default input device ID: \(defaultInput)")
    }

    // Default output device
    var defaultOutputAddress = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var defaultOutput: AudioDeviceID = 0
    var defaultOutputSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    if AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &defaultOutputAddress, 0, nil, &defaultOutputSize, &defaultOutput) == noErr {
        print("  Default output device ID: \(defaultOutput)")
    }

    print("=========================")
}

func run() async {
    print("AudioSpike - ScreenCaptureKit + Microphone Audio Capture")
    print("=========================================================")
    print("Capture duration: \(captureDurationSeconds) seconds")
    print("Sample rate: \(sampleRate) Hz, Channels: \(channelCount), Bits: \(bitsPerSample)")
    print("")

    printAudioDeviceInfo()
    print("")

    // --- Step 1: Request ScreenCaptureKit permission and enumerate content ---
    print("[SCK] Requesting ScreenCaptureKit permission...")

    let content: SCShareableContent
    do {
        content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    } catch {
        print("[SCK] ERROR: Failed to get shareable content: \(error)")
        print("")
        print("  This likely means Screen Recording permission is not granted.")
        print("  Go to: System Settings > Privacy & Security > Screen Recording")
        print("  Add your terminal app (Terminal, iTerm2, etc.) to the list.")
        print("")
        exit(1)
    }

    print("[SCK] Permission granted. Found:")
    print("  \(content.applications.count) application(s)")
    print("  \(content.windows.count) window(s)")
    print("  \(content.displays.count) display(s)")
    print("")

    // List running apps that might be producing audio
    print("[SCK] Running applications:")
    for app in content.applications.prefix(20) {
        let name = app.applicationName
        let bundleID = app.bundleIdentifier
        print("  - \(name.isEmpty ? "(unnamed)" : name) [\(bundleID)]")
    }
    if content.applications.count > 20 {
        print("  ... and \(content.applications.count - 20) more")
    }
    print("")

    // --- Step 2: Configure SCStream for audio-only capture ---
    print("[SCK] Configuring audio-only stream...")

    // Use a display-based filter to capture all system audio
    guard let display = content.displays.first else {
        print("[SCK] ERROR: No displays found")
        exit(1)
    }

    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])

    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.excludesCurrentProcessAudio = true
    config.sampleRate = sampleRate
    config.channelCount = channelCount
    // Minimize video overhead since we only want audio
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 1, timescale: 1) // 1 fps minimum
    config.showsCursor = false

    let stream: SCStream
    let systemAudioDelegate = AudioCaptureDelegate(label: "System")

    do {
        stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(systemAudioDelegate, type: .audio, sampleHandlerQueue: DispatchQueue(label: "com.audiospike.system-audio", qos: .userInteractive))
    } catch {
        print("[SCK] ERROR: Failed to create stream: \(error)")
        exit(1)
    }

    // --- Step 3: Set up microphone capture ---
    print("[Mic] Setting up microphone capture...")

    let micCapture = MicrophoneCapture()

    // --- Step 3.5: Set up audio route change observer ---
    let routeObserver = AudioRouteObserver()
    _ = routeObserver  // retain for lifetime of capture

    // --- Step 4: Start capturing ---
    print("")
    print("Starting audio capture for \(captureDurationSeconds) seconds...")
    print("")

    do {
        try await stream.startCapture()
        print("[SCK] System audio capture started")
    } catch {
        print("[SCK] ERROR: Failed to start capture: \(error)")
        print("  Ensure Screen Recording permission is enabled.")
        exit(1)
    }

    do {
        try micCapture.start()
    } catch {
        print("[Mic] ERROR: Failed to start microphone capture: \(error)")
        print("  Ensure Microphone permission is granted.")
        print("  Continuing with system audio only...")
    }

    // --- Step 5: Wait for capture duration with progress ---
    let startTime = Date()

    for _ in stride(from: 5, through: captureDurationSeconds, by: 5) {
        try? await Task.sleep(nanoseconds: UInt64(5) * 1_000_000_000)
        let actualElapsed = Int(Date().timeIntervalSince(startTime))
        print("")
        print("--- Progress: \(actualElapsed)/\(captureDurationSeconds) seconds ---")
    }

    // Wait for any remaining time
    let remaining = Double(captureDurationSeconds) - Date().timeIntervalSince(startTime)
    if remaining > 0 {
        try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
    }

    // --- Step 6: Stop capturing ---
    print("")
    print("Stopping capture...")

    do {
        try await stream.stopCapture()
        print("[SCK] System audio capture stopped")
    } catch {
        print("[SCK] Warning: Error stopping stream: \(error)")
    }

    micCapture.stop()

    // --- Step 7: Write WAV files ---
    print("")
    print("Writing WAV files...")

    let currentDir = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)

    // System audio WAV
    let systemAudioData = systemAudioDelegate.getData()
    let systemAudioURL = currentDir.appendingPathComponent("meeting_audio.wav")
    do {
        try writeWAV(
            pcmData: systemAudioData,
            sampleRate: sampleRate,
            channels: channelCount,
            bitsPerSample: bitsPerSample,
            to: systemAudioURL
        )
        let systemDuration = Double(systemAudioData.count) / Double(sampleRate * channelCount * (bitsPerSample / 8))
        print("[SCK] Wrote: \(systemAudioURL.path)")
        print("  Size: \(systemAudioData.count + 44) bytes (\(ByteCountFormatter.string(fromByteCount: Int64(systemAudioData.count + 44), countStyle: .file)))")
        print("  Duration: \(String(format: "%.2f", systemDuration)) seconds")
        print("  Total samples: \(systemAudioDelegate.getTotalSamples())")
        print("  Dropped buffers: \(systemAudioDelegate.getDroppedCount())")
    } catch {
        print("[SCK] ERROR writing meeting_audio.wav: \(error)")
    }

    // Microphone audio WAV
    let micAudioData = micCapture.getData()
    let micAudioURL = currentDir.appendingPathComponent("mic_audio.wav")
    do {
        try writeWAV(
            pcmData: micAudioData,
            sampleRate: sampleRate,
            channels: channelCount,
            bitsPerSample: bitsPerSample,
            to: micAudioURL
        )
        let micDuration = Double(micAudioData.count) / Double(sampleRate * channelCount * (bitsPerSample / 8))
        print("")
        print("[Mic] Wrote: \(micAudioURL.path)")
        print("  Size: \(micAudioData.count + 44) bytes (\(ByteCountFormatter.string(fromByteCount: Int64(micAudioData.count + 44), countStyle: .file)))")
        print("  Duration: \(String(format: "%.2f", micDuration)) seconds")
        print("  Total samples: \(micCapture.getTotalSamples())")
    } catch {
        print("[Mic] ERROR writing mic_audio.wav: \(error)")
    }

    // --- Summary ---
    print("")
    print("=========================================================")
    print("AudioSpike capture complete.")
    if systemAudioData.isEmpty {
        print("WARNING: System audio buffer is empty - no audio was captured.")
        print("  Make sure some application is producing audio during capture.")
    }
    if micAudioData.isEmpty {
        print("WARNING: Microphone buffer is empty - no mic audio was captured.")
        print("  Make sure microphone permission is granted and a mic is connected.")
    }
    if !systemAudioData.isEmpty || !micAudioData.isEmpty {
        print("SUCCESS: Audio files written to current directory.")
    }
    print("=========================================================")
}

// --- Launch async entry point from synchronous CLI context ---

let semaphore = DispatchSemaphore(value: 0)
var exitCode: Int32 = 0

Task {
    await run()
    semaphore.signal()
}

// Keep the main thread alive with RunLoop so audio callbacks can fire
// but also check the semaphore periodically
let runLoop = RunLoop.main
while semaphore.wait(timeout: .now()) == .timedOut {
    runLoop.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
}

exit(exitCode)
