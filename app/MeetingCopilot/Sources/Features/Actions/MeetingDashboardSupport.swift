import Foundation
import SwiftUI

enum TranscriptSourceFilter: String, CaseIterable, Identifiable {
    case all
    case you
    case meeting

    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "All"
        case .you: return "You"
        case .meeting: return "Meeting"
        }
    }

    var icon: String {
        switch self {
        case .all: return "square.stack.3d.up"
        case .you: return "person.fill"
        case .meeting: return "person.3.fill"
        }
    }

    func includes(_ segment: TranscriptSegment) -> Bool {
        switch self {
        case .all:
            return true
        case .you:
            return segment.source == .mic
        case .meeting:
            return segment.source == .meeting
        }
    }
}

enum MeetingSignalKind: String, CaseIterable, Identifiable {
    case actionItem
    case decision
    case question
    case blocker

    var id: String { rawValue }

    var title: String {
        switch self {
        case .actionItem: return "Action Cue"
        case .decision: return "Decision"
        case .question: return "Question"
        case .blocker: return "Risk"
        }
    }

    var shortLabel: String {
        switch self {
        case .actionItem: return "Action"
        case .decision: return "Decision"
        case .question: return "Question"
        case .blocker: return "Risk"
        }
    }

    var icon: String {
        switch self {
        case .actionItem: return "checklist"
        case .decision: return "checkmark.seal"
        case .question: return "questionmark.circle"
        case .blocker: return "exclamationmark.triangle"
        }
    }

    var tint: Color {
        switch self {
        case .actionItem: return DashboardPalette.accentBlue
        case .decision: return DashboardPalette.accentTeal
        case .question: return DashboardPalette.warning
        case .blocker: return DashboardPalette.danger
        }
    }
}

struct MeetingSignal: Identifiable {
    let id: String
    let kind: MeetingSignalKind
    let excerpt: String
    let speaker: String
    let timestamp: Date
}

struct MeetingTopic: Identifiable {
    let id: String
    let term: String
    let count: Int
}

struct MeetingDashboardSnapshot {
    let signals: [MeetingSignal]
    let topics: [MeetingTopic]
    let wordCounts: [TranscriptSegment.AudioSource: Int]
    let segmentCounts: [TranscriptSegment.AudioSource: Int]
    let pacePerMinute: Int
    let pendingCount: Int
    let runningCount: Int
    let completedCount: Int
    let focusAction: ActionSuggestion?
    let latestCompletedAction: ActionSuggestion?

    var totalWords: Int {
        wordCounts.values.reduce(0, +)
    }

    var micWords: Int {
        wordCounts[.mic, default: 0]
    }

    var meetingWords: Int {
        wordCounts[.meeting, default: 0]
    }

    var actionSignals: [MeetingSignal] {
        signals.filter { $0.kind == .actionItem }
    }

    var decisionSignals: [MeetingSignal] {
        signals.filter { $0.kind == .decision }
    }

    var questionSignals: [MeetingSignal] {
        signals.filter { $0.kind == .question }
    }

    var blockerSignals: [MeetingSignal] {
        signals.filter { $0.kind == .blocker }
    }
}

enum MeetingDashboardAnalyzer {
    private static let actionMarkers = [
        "action item",
        "follow up",
        "next step",
        "send",
        "share",
        "create",
        "draft",
        "schedule",
        "update",
        "write",
        "review",
        "prepare",
        "need to",
        "let's",
        "we should",
        "i'll",
        "i will",
        "can you",
        "could you",
        "own that",
        "take that"
    ]

    private static let decisionMarkers = [
        "we decided",
        "decision",
        "agreed",
        "approved",
        "we'll go with",
        "let's do",
        "locking",
        "move forward with",
        "ship this",
        "finalize"
    ]

    private static let blockerMarkers = [
        "blocker",
        "blocked",
        "risk",
        "concern",
        "issue",
        "problem",
        "can't",
        "cannot",
        "stuck",
        "delay",
        "slip",
        "waiting on"
    ]

    private static let questionStarts = [
        "what",
        "why",
        "how",
        "when",
        "where",
        "who",
        "should",
        "can",
        "could",
        "would",
        "do we",
        "are we"
    ]

    private static let stopWords: Set<String> = [
        "about", "after", "again", "also", "because", "been", "before",
        "being", "between", "both", "call", "came", "come", "could",
        "from", "have", "just", "like", "maybe", "meeting", "more",
        "need", "next", "only", "other", "really", "right", "said",
        "same", "should", "some", "take", "team", "that", "them",
        "there", "these", "they", "thing", "think", "this", "those",
        "through", "today", "want", "with", "will", "would", "your",
        "ours", "into", "over", "under", "than", "then", "very",
        "from", "were", "where", "when", "what", "have", "has",
        "been", "being", "able", "make", "made", "gets", "getting",
        "going", "kind", "sort", "yeah", "okay", "sure", "look",
        "looks", "need", "needs"
    ]

    static func snapshot(
        segments: [TranscriptSegment],
        actions: [ActionSuggestion],
        elapsed: TimeInterval
    ) -> MeetingDashboardSnapshot {
        let wordCounts = Dictionary(
            grouping: segments,
            by: \.source
        ).mapValues { group in
            group.reduce(0) { $0 + $1.wordCount }
        }

        let segmentCounts = Dictionary(
            grouping: segments,
            by: \.source
        ).mapValues(\.count)

        let totalWords = wordCounts.values.reduce(0, +)
        let minutes = max(elapsed / 60, 1)
        let pacePerMinute = Int((Double(totalWords) / minutes).rounded())

        let suggestedActions = actions.filter { $0.state == .suggested }
        let runningActions = actions.filter { $0.state.isActive }
        let completedActions = actions.filter { $0.state.isTerminal && $0.result != nil }

        let focusAction = runningActions.first
            ?? suggestedActions.last
            ?? completedActions.last

        return MeetingDashboardSnapshot(
            signals: extractSignals(from: Array(segments.suffix(36))),
            topics: topTopics(from: Array(segments.suffix(60))),
            wordCounts: wordCounts,
            segmentCounts: segmentCounts,
            pacePerMinute: pacePerMinute,
            pendingCount: suggestedActions.count,
            runningCount: runningActions.count,
            completedCount: completedActions.count,
            focusAction: focusAction,
            latestCompletedAction: completedActions.last
        )
    }

    static func tags(for segment: TranscriptSegment) -> [MeetingSignalKind] {
        signalKinds(in: segment.text)
    }

    private static func extractSignals(from segments: [TranscriptSegment]) -> [MeetingSignal] {
        var signals: [MeetingSignal] = []
        var seen = Set<String>()

        for segment in segments.reversed() {
            let kinds = signalKinds(in: segment.text)
            guard !kinds.isEmpty else { continue }

            for kind in kinds {
                let normalized = normalize(segment.text)
                let cacheKey = "\(kind.rawValue):\(normalized)"
                guard seen.insert(cacheKey).inserted else { continue }

                signals.append(
                    MeetingSignal(
                        id: cacheKey,
                        kind: kind,
                        excerpt: trimmed(segment.text),
                        speaker: cleanedLabel(segment.label),
                        timestamp: segment.timestamp
                    )
                )
            }

            if signals.count >= 10 {
                break
            }
        }

        return signals.sorted { $0.timestamp > $1.timestamp }
    }

    private static func topTopics(from segments: [TranscriptSegment]) -> [MeetingTopic] {
        var counts: [String: Int] = [:]

        for segment in segments {
            for token in normalizedTokens(in: segment.text) {
                guard token.count >= 4, !stopWords.contains(token) else { continue }
                counts[token, default: 0] += 1
            }
        }

        return counts
            .filter { $0.value > 1 }
            .sorted {
                if $0.value == $1.value {
                    return $0.key < $1.key
                }
                return $0.value > $1.value
            }
            .prefix(6)
            .map { MeetingTopic(id: $0.key, term: $0.key.capitalized, count: $0.value) }
    }

    private static func signalKinds(in text: String) -> [MeetingSignalKind] {
        let lower = text.lowercased()
        var kinds: [MeetingSignalKind] = []

        if actionMarkers.contains(where: { lower.contains($0) }) {
            kinds.append(.actionItem)
        }

        if decisionMarkers.contains(where: { lower.contains($0) }) {
            kinds.append(.decision)
        }

        if lower.contains("?") || questionStarts.contains(where: { lower.hasPrefix($0 + " ") || lower.contains(" \($0) ") }) {
            kinds.append(.question)
        }

        if blockerMarkers.contains(where: { lower.contains($0) }) {
            kinds.append(.blocker)
        }

        return kinds
    }

    private static func normalizedTokens(in text: String) -> [String] {
        text.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
    }

    private static func normalize(_ text: String) -> String {
        normalizedTokens(in: text).joined(separator: " ").prefix(120).description
    }

    private static func trimmed(_ text: String) -> String {
        let normalizedWhitespace = text
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")

        if normalizedWhitespace.count <= 140 {
            return normalizedWhitespace
        }

        return String(normalizedWhitespace.prefix(137)) + "..."
    }

    private static func cleanedLabel(_ label: String) -> String {
        label
            .replacingOccurrences(of: "[", with: "")
            .replacingOccurrences(of: "]", with: "")
    }
}
