import Foundation

struct TranscriptSegment: Identifiable, Codable {
    let id: String
    let text: String
    let source: AudioSource
    let label: String // "[You]" or "[Meeting]"
    let timestamp: Date
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
        duration: TimeInterval = 0,
        isRedacted: Bool = false
    ) {
        self.id = id
        self.text = text
        self.source = source
        self.label = source == .mic ? "[You]" : "[Meeting]"
        self.timestamp = timestamp
        self.duration = duration
        self.wordCount = text.split(separator: " ").count
        self.isRedacted = isRedacted
    }

    // Custom decoding with defaults for optional server fields
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        text = try container.decode(String.self, forKey: .text)
        source = try container.decode(AudioSource.self, forKey: .source)
        label = try container.decodeIfPresent(String.self, forKey: .label)
            ?? (source == .mic ? "[You]" : "[Meeting]")
        timestamp = try container.decodeIfPresent(Date.self, forKey: .timestamp) ?? Date()
        duration = try container.decodeIfPresent(TimeInterval.self, forKey: .duration) ?? 0
        wordCount = try container.decodeIfPresent(Int.self, forKey: .wordCount)
            ?? text.split(separator: " ").count
        isRedacted = try container.decodeIfPresent(Bool.self, forKey: .isRedacted) ?? false
    }
}
