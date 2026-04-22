import Foundation

struct TranscriptSegment: Identifiable, Codable {
    let id: String
    let text: String
    let source: AudioSource
    let label: String // "[You]" or "[Meeting]"
    let timestamp: Date
    /// Actual audio length (seconds) covered by this segment.
    let audioDurationSec: TimeInterval
    /// Whisper processing latency (milliseconds).
    let transcriptionLatencyMs: Double
    /// Monotonically-increasing per-source chunk counter from the Swift capture.
    let sequence: Int?
    /// @deprecated — use `audioDurationSec`. Kept during v2 rollout.
    let duration: TimeInterval
    let wordCount: Int
    var isRedacted: Bool = false

    enum AudioSource: String, Codable {
        case mic
        case meeting
    }

    init(
        id: String = UUID().uuidString,
        text: String,
        source: AudioSource,
        timestamp: Date = Date(),
        audioDurationSec: TimeInterval = 0,
        transcriptionLatencyMs: Double = 0,
        sequence: Int? = nil,
        isRedacted: Bool = false
    ) {
        self.id = id
        self.text = text
        self.source = source
        self.label = source == .mic ? "[You]" : "[Meeting]"
        self.timestamp = timestamp
        self.audioDurationSec = audioDurationSec
        self.transcriptionLatencyMs = transcriptionLatencyMs
        self.sequence = sequence
        self.duration = audioDurationSec
        self.wordCount = text.split(separator: " ").count
        self.isRedacted = isRedacted
    }

    // Custom decoding — tolerates older servers that only sent `duration`.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        text = try container.decode(String.self, forKey: .text)
        source = try container.decode(AudioSource.self, forKey: .source)
        label = try container.decodeIfPresent(String.self, forKey: .label)
            ?? (source == .mic ? "[You]" : "[Meeting]")
        timestamp = try container.decodeIfPresent(Date.self, forKey: .timestamp) ?? Date()
        let legacyDuration = try container.decodeIfPresent(TimeInterval.self, forKey: .duration) ?? 0
        audioDurationSec = try container.decodeIfPresent(TimeInterval.self, forKey: .audioDurationSec) ?? legacyDuration
        transcriptionLatencyMs = try container.decodeIfPresent(Double.self, forKey: .transcriptionLatencyMs) ?? 0
        sequence = try container.decodeIfPresent(Int.self, forKey: .sequence)
        duration = audioDurationSec
        wordCount = try container.decodeIfPresent(Int.self, forKey: .wordCount)
            ?? text.split(separator: " ").count
        isRedacted = try container.decodeIfPresent(Bool.self, forKey: .isRedacted) ?? false
    }
}
