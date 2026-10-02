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

    /// A meeting is under way, from Start until its session is archived.
    /// Nothing that interrupts (an update window, a relaunch) may happen then.
    var isMeeting: Bool {
        switch self {
        case .priming, .live, .degraded, .ending: return true
        case .idle, .error, .archived: return false
        }
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
