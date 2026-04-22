import Foundation

/// Shared helpers for writing 16 kHz mono 16-bit PCM WAV data. Used by
/// both the fixed-timer emit path in `AudioCaptureManager` and the
/// VAD-driven `VADEmitter`. Previously duplicated in each file; extracted
/// so changes to the WAV wire format happen in one place.
///
/// whisper-server accepts this exact layout (standard 44-byte header +
/// signed 16-bit little-endian PCM samples, mono, 16 kHz).
enum AudioWAV {
    static let sampleRate: UInt32 = 16_000
    static let channels: UInt16 = 1
    static let bitsPerSample: UInt16 = 16
    static var bytesPerSecond: Int {
        Int(sampleRate) * Int(channels) * Int(bitsPerSample / 8)
    }

    /// Encode raw Int16 PCM (little-endian bytes) into a WAV container.
    /// Used by `AudioCaptureManager.emitChunks` which already buffers
    /// quantized Int16.
    static func encode(int16PCM pcmData: Data) -> Data {
        writeHeader(dataSize: UInt32(pcmData.count)) + pcmData
    }

    /// Encode Float32 samples (Silero VAD's native format) — quantize to
    /// Int16, clamp at ±1.0, append after the WAV header. Used by
    /// `VADEmitter` which keeps audio in Float32 until emit time.
    static func encode(float32Samples samples: [Float]) -> Data {
        let dataSize = UInt32(samples.count * MemoryLayout<Int16>.size)
        var data = writeHeader(dataSize: dataSize)
        data.reserveCapacity(Int(dataSize) + 44)
        for sample in samples {
            let clamped = max(-1.0, min(1.0, sample))
            let int16Value = Int16(clamped * Float(Int16.max))
            data.append(contentsOf: withUnsafeBytes(of: int16Value.littleEndian) { Array($0) })
        }
        return data
    }

    private static func writeHeader(dataSize: UInt32) -> Data {
        let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
        let blockAlign = channels * (bitsPerSample / 8)
        let fileSize = 36 + dataSize

        var header = Data()
        header.reserveCapacity(44)

        header.append(contentsOf: "RIFF".utf8)
        header.append(contentsOf: withUnsafeBytes(of: fileSize.littleEndian) { Array($0) })
        header.append(contentsOf: "WAVE".utf8)

        header.append(contentsOf: "fmt ".utf8)
        header.append(contentsOf: withUnsafeBytes(of: UInt32(16).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: channels.littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: sampleRate.littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: byteRate.littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: blockAlign.littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: bitsPerSample.littleEndian) { Array($0) })

        header.append(contentsOf: "data".utf8)
        header.append(contentsOf: withUnsafeBytes(of: dataSize.littleEndian) { Array($0) })

        return header
    }
}
