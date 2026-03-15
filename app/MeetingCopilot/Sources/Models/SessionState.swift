import Foundation

// MARK: - Session State Machine

enum SessionState: String, Codable {
    case idle
    case priming
    case live
    case degraded
    case ending
    case error
    case archived

    /// Valid transitions from this state
    var validTransitions: [SessionState] {
        switch self {
        case .idle:     return [.priming]
        case .priming:  return [.live, .degraded, .idle, .error]
        case .live:     return [.degraded, .ending, .error]
        case .degraded: return [.live, .ending, .error]
        case .ending:   return [.archived, .error]
        case .error:    return [.idle]
        case .archived: return [.idle]
        }
    }

    func canTransition(to newState: SessionState) -> Bool {
        validTransitions.contains(newState)
    }
}

// MARK: - Session Model

struct Session: Identifiable {
    let id: String
    var state: SessionState
    var startedAt: Date?
    var endedAt: Date?
    var title: String

    init(id: String = UUID().uuidString, state: SessionState = .idle, title: String = "Untitled Meeting") {
        self.id = id
        self.state = state
        self.title = title
    }
}
