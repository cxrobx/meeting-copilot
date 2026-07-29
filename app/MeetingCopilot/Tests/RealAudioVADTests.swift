import Foundation
import XCTest
@testable import MeetingCopilot

/// Opt-in integration coverage for the real production Silero VAD path.
///
/// The fixture stays outside the repository and is read only. Run with:
///   REAL_AUDIO_RECORDING_DIR=/path/to/session REAL_AUDIO_MINUTES=5 swift test \
///     --filter RealAudioVADTests
final class RealAudioVADTests: XCTestCase {
    private struct Emission {
        let bytes: Int
        let duration: Double
        let continuation: Bool
    }

    func testRealAudioVADWhenFixtureConfigured() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let recordingDirectory = environment["REAL_AUDIO_RECORDING_DIR"],
              !recordingDirectory.isEmpty else {
            throw XCTSkip("Set REAL_AUDIO_RECORDING_DIR to opt into the private real-audio test")
        }

        let minutes = Double(environment["REAL_AUDIO_MINUTES"] ?? "5") ?? 5
        XCTAssertGreaterThan(minutes, 0)
        let modelPath = environment["MEETING_COPILOT_VAD_MODEL"]
            ?? NSString("~/.meeting-copilot/models/ggml-silero-v5.1.2.bin")
                .expandingTildeInPath
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: modelPath),
            "Silero VAD model is missing at \(modelPath)"
        )

        let tracks: [(String, TranscriptSegment.AudioSource)] = [
            ("system.wav", .meeting),
            ("mic.wav", .mic),
        ]

        for (fileName, source) in tracks {
            let fileURL = URL(fileURLWithPath: recordingDirectory)
                .appendingPathComponent(fileName)
            let samples = try readPCM16(
                from: fileURL,
                maximumSamples: Int(minutes * 60 * 16_000)
            )
            XCTAssertFalse(samples.isEmpty, "\(fileName) contained no PCM samples")

            guard let probe = VADProbe(modelPath: modelPath) else {
                return XCTFail("Could not load Silero VAD model at \(modelPath)")
            }

            var emissions: [Emission] = []
            let emitter = VADEmitter(source: source, probe: probe) { wav, _, meta in
                emissions.append(
                    Emission(
                        bytes: wav.count,
                        duration: meta.audioDurationSec,
                        continuation: meta.isContinuation
                    )
                )
            }

            // Feed one second at a time, matching streaming capture while
            // avoiding one task allocation per 30 ms probe window.
            for offset in stride(from: 0, to: samples.count, by: 16_000) {
                let end = min(offset + 16_000, samples.count)
                emitter.ingest(samples: Array(samples[offset..<end]))
            }
            if let trailing = emitter.flush() {
                emissions.append(
                    Emission(
                        bytes: trailing.wav.count,
                        duration: trailing.meta.audioDurationSec,
                        continuation: trailing.meta.isContinuation
                    )
                )
            }

            XCTAssertFalse(emissions.isEmpty, "VAD emitted no \(source.rawValue) speech")
            XCTAssertTrue(emissions.allSatisfy { $0.bytes > 44 })
            XCTAssertTrue(
                emissions.allSatisfy { $0.duration <= 6.50 },
                "VAD exceeded its six-second cap plus allowed pre-roll/trailing silence"
            )

            let speechSeconds = emissions.reduce(0) { $0 + $1.duration }
            let continuations = emissions.filter(\.continuation).count
            let sortedDurations = emissions.map(\.duration).sorted()
            let p95Index = max(
                0,
                min(sortedDurations.count - 1, Int(ceil(Double(sortedDurations.count) * 0.95)) - 1)
            )
            let p95Duration = sortedDurations[p95Index]
            print(
                "REAL_AUDIO_VAD source=\(source.rawValue) " +
                    "emissions=\(emissions.count) " +
                    "speechSeconds=\(String(format: "%.1f", speechSeconds)) " +
                    "durationP95=\(String(format: "%.2f", p95Duration)) " +
                    "continuations=\(continuations)"
            )
        }
    }

    private func readPCM16(from url: URL, maximumSamples: Int) throws -> [Float] {
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        guard data.count >= 44,
              String(data: data[0..<4], encoding: .ascii) == "RIFF",
              String(data: data[8..<12], encoding: .ascii) == "WAVE" else {
            throw NSError(
                domain: "RealAudioVADTests",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "\(url.path) is not a RIFF/WAVE file"]
            )
        }

        var offset = 12
        var channels: UInt16?
        var sampleRate: UInt32?
        var bitsPerSample: UInt16?
        var pcmRange: Range<Int>?

        while offset + 8 <= data.count {
            let chunkID = String(data: data[offset..<(offset + 4)], encoding: .ascii)
            let chunkLength = Int(readUInt32LE(data, at: offset + 4))
            let start = offset + 8
            let end = min(start + chunkLength, data.count)
            if chunkID == "fmt ", chunkLength >= 16 {
                channels = readUInt16LE(data, at: start + 2)
                sampleRate = readUInt32LE(data, at: start + 4)
                bitsPerSample = readUInt16LE(data, at: start + 14)
            } else if chunkID == "data" {
                pcmRange = start..<end
            }
            offset = start + chunkLength + (chunkLength % 2)
        }

        guard channels == 1, sampleRate == 16_000, bitsPerSample == 16,
              let pcmRange else {
            throw NSError(
                domain: "RealAudioVADTests",
                code: 2,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "\(url.path) must be 16kHz mono 16-bit PCM"
                ]
            )
        }

        let sampleCount = min(maximumSamples, pcmRange.count / MemoryLayout<Int16>.size)
        var samples = [Float]()
        samples.reserveCapacity(sampleCount)
        for index in 0..<sampleCount {
            let raw = readUInt16LE(data, at: pcmRange.lowerBound + index * 2)
            samples.append(Float(Int16(bitPattern: raw)) / 32_768)
        }
        return samples
    }

    private func readUInt16LE(_ data: Data, at offset: Int) -> UInt16 {
        UInt16(data[offset]) | (UInt16(data[offset + 1]) << 8)
    }

    private func readUInt32LE(_ data: Data, at offset: Int) -> UInt32 {
        UInt32(data[offset])
            | (UInt32(data[offset + 1]) << 8)
            | (UInt32(data[offset + 2]) << 16)
            | (UInt32(data[offset + 3]) << 24)
    }
}
