import Foundation

struct SessionHistoryItem: Codable, Identifiable {
    let sessionId: String
    let title: String
    let startedAt: String?  // ISO-8601
    let endedAt: String?    // ISO-8601
    let state: String
    let transcriptSegments: Int
    let actions: [SessionHistoryAction]?

    var id: String { sessionId }

    var startDate: Date? {
        guard let s = startedAt else { return nil }
        return ISO8601DateFormatter().date(from: s)
    }

    var endDate: Date? {
        guard let s = endedAt else { return nil }
        return ISO8601DateFormatter().date(from: s)
    }

    var duration: TimeInterval? {
        guard let start = startDate, let end = endDate else { return nil }
        return end.timeIntervalSince(start)
    }

    var formattedDuration: String {
        guard let d = duration else { return "\u{2014}" }
        let mins = Int(d) / 60
        let secs = Int(d) % 60
        return "\(mins)m \(secs)s"
    }
}

struct SessionHistoryAction: Codable {
    let id: String
    let type: String
    let title: String
    let state: String
}
