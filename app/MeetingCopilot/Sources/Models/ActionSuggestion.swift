import Foundation

// MARK: - Action Types

enum ActionType: String, Codable {
    case research
    case fastResearch = "fast-research"
    case summary
    case mockup
    case codegen
    case analysis
    case review
    /// A worker type this build doesn't know yet. Without it, one new server
    /// type fails the whole `action.suggested` decode and the card is lost.
    case other

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ActionType(rawValue: raw) ?? .other
    }

    var icon: String {
        switch self {
        case .research:     return "magnifyingglass"
        case .fastResearch: return "bolt"
        case .summary:      return "doc.text"
        case .mockup:       return "paintbrush"
        case .codegen:      return "chevron.left.forwardslash.chevron.right"
        case .analysis:     return "chart.bar"
        case .review:       return "checkmark.seal"
        case .other:        return "sparkles"
        }
    }

    var displayName: String {
        switch self {
        case .research:     return "Research"
        case .fastResearch: return "Fast research"
        case .summary:      return "Summary"
        case .mockup:       return "Mockup"
        case .codegen:      return "Code Generation"
        case .analysis:     return "Analysis"
        case .review:       return "Self-review"
        case .other:        return "Action"
        }
    }
}

// MARK: - Action State

enum ActionState: String, Codable {
    case suggested
    case approved
    case queued
    case running
    case completed
    case failed
    case cancelled
    case expired

    var isTerminal: Bool {
        switch self {
        case .completed, .failed, .cancelled, .expired: return true
        default: return false
        }
    }

    var isActive: Bool {
        switch self {
        case .approved, .queued, .running: return true
        default: return false
        }
    }
}

// MARK: - Action Suggestion

struct ActionSuggestion: Identifiable, Codable {
    let id: String
    let type: ActionType
    let title: String
    let description: String
    let triggerQuote: String
    let estimatedDurationSec: Int
    var state: ActionState
    var createdAt: Date
    var approvedAt: Date?
    var startedAt: Date?
    var completedAt: Date?
    var result: ActionResult?

    init(
        id: String = UUID().uuidString,
        type: ActionType,
        title: String,
        description: String,
        triggerQuote: String,
        estimatedDurationSec: Int = 30,
        state: ActionState = .suggested,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.type = type
        self.title = title
        self.description = description
        self.triggerQuote = triggerQuote
        self.estimatedDurationSec = estimatedDurationSec
        self.state = state
        self.createdAt = createdAt
    }
}

// MARK: - Action Result

struct ActionResult: Codable {
    let success: Bool
    let summary: String
    let artifacts: [Artifact]?
    let error: String?
}

// MARK: - Artifact

struct Artifact: Codable, Identifiable {
    var id: String { "\(type.rawValue)_\(title ?? "untitled")" }
    let type: ArtifactType
    let content: String
    let title: String?

    enum ArtifactType: String, Codable {
        case text
        case markdown
        case image
        case code
        case html
    }
}
