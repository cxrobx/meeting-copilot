import Foundation

// MARK: - Client → Server Messages

enum ClientMessage: Encodable {
    case sessionStart(title: String? = nil, projectNames: [String]? = nil, agenda: String? = nil, attendees: String? = nil)
    case sessionStop
    case audioChunk(data: String, source: String) // base64, "mic"|"meeting"
    case actionApprove(actionId: String)
    case actionDismiss(actionId: String)
    case actionCancel(actionId: String)
    case actionTrigger(actionType: String, prompt: String?)

    private enum CodingKeys: String, CodingKey {
        case type, data, source, actionId, title, projectNames, agenda, attendees, actionType, prompt
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .sessionStart(let title, let projectNames, let agenda, let attendees):
            try container.encode("session.start", forKey: .type)
            try container.encodeIfPresent(title, forKey: .title)
            try container.encodeIfPresent(projectNames, forKey: .projectNames)
            try container.encodeIfPresent(agenda, forKey: .agenda)
            try container.encodeIfPresent(attendees, forKey: .attendees)
        case .sessionStop:
            try container.encode("session.stop", forKey: .type)
        case .audioChunk(let data, let source):
            try container.encode("audio_chunk", forKey: .type)
            try container.encode(data, forKey: .data)
            try container.encode(source, forKey: .source)
        case .actionApprove(let actionId):
            try container.encode("action.approve", forKey: .type)
            try container.encode(actionId, forKey: .actionId)
        case .actionDismiss(let actionId):
            try container.encode("action.dismiss", forKey: .type)
            try container.encode(actionId, forKey: .actionId)
        case .actionCancel(let actionId):
            try container.encode("action.cancel", forKey: .type)
            try container.encode(actionId, forKey: .actionId)
        case .actionTrigger(let actionType, let prompt):
            try container.encode("action.trigger", forKey: .type)
            try container.encode(actionType, forKey: .actionType)
            try container.encodeIfPresent(prompt, forKey: .prompt)
        }
    }
}

// MARK: - Server → Client Messages

/// Decodes messages from the Node.js server. JSON keys match the server's
/// actual wire format exactly (segment, action, actionId, state, data).
enum ServerMessage: Decodable {
    case transcriptUpdate(TranscriptSegment)
    case actionSuggested(ActionSuggestion)
    case actionStatus(actionId: String, state: ActionState, result: ActionResult?)
    case sessionState(SessionState, sessionId: String?)
    case metrics(DebugMetrics)

    private enum CodingKeys: String, CodingKey {
        case type, segment, action, actionId, state, result, sessionId, data
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "transcript.update":
            let segment = try container.decode(TranscriptSegment.self, forKey: .segment)
            self = .transcriptUpdate(segment)
        case "action.suggested":
            let action = try container.decode(ActionSuggestion.self, forKey: .action)
            self = .actionSuggested(action)
        case "action.status":
            let actionId = try container.decode(String.self, forKey: .actionId)
            let state = try container.decode(ActionState.self, forKey: .state)
            let result = try container.decodeIfPresent(ActionResult.self, forKey: .result)
            self = .actionStatus(actionId: actionId, state: state, result: result)
        case "session.state":
            let state = try container.decode(SessionState.self, forKey: .state)
            let sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
            self = .sessionState(state, sessionId: sessionId)
        case "metrics":
            let metrics = try container.decode(DebugMetrics.self, forKey: .data)
            self = .metrics(metrics)
        default:
            // Ignore unknown message types gracefully
            self = .metrics(DebugMetrics(transcriptLatencyMs: nil, activeWorkers: nil, audioBufferSizeBytes: nil, serverUptime: nil))
        }
    }
}

// MARK: - Debug Metrics

struct DebugMetrics: Codable {
    let transcriptLatencyMs: Double?
    let activeWorkers: Int?
    let audioBufferSizeBytes: Int?
    let serverUptime: TimeInterval?
}
