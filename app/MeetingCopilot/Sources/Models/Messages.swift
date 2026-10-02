import Foundation

// MARK: - Client → Server Messages

enum ClientMessage: Encodable {
    case sessionStart(title: String? = nil, projectNames: [String]? = nil, agenda: String? = nil, attendees: String? = nil, contextPaths: [String]? = nil)
    case sessionStop
    /// Pause / Resume the live meeting (server/src/session/pause.ts).
    case sessionPause
    case sessionResume
    // Audio chunk with capture metadata. Server measures true e2e latency as
    // (now on receive of transcript broadcast) - captureEndedAt. `sequence`
    // is per-source so out-of-order delivery is detectable. `isContinuation`
    // tells the server's dedup whether this chunk shares audio with the
    // previous one (true for overlap carry, false for pause-triggered VAD).
    case audioChunk(
        data: String,
        source: String, // "mic"|"meeting"
        chunkId: String,
        audioDurationSec: Double,
        captureStartedAt: Date,
        captureEndedAt: Date,
        sequence: Int,
        isContinuation: Bool
    )
    // Signals session-stop flush — tells the server to await any in-flight
    // chunks (transcription.flushPending) before finalizing the session.
    // Wire type is "audio.flush" (dot, matching the Phase -1e server stub)
    // even though most outbound messages use underscore ("audio_chunk").
    case audioFlush
    case actionApprove(actionId: String)
    case actionDismiss(actionId: String)
    case actionCancel(actionId: String)
    case actionTrigger(actionType: String, prompt: String?)
    /// A pulse read now: "checkin" (How am I doing?), "missed", or "closeout".
    case pulseRequest(kind: String)
    /// "Suggest": one coach card now.
    case coachAsk(focus: String?)
    /// The menu bar's Ask: a question for the live meeting's chat.
    case chatSend(text: String)

    private enum CodingKeys: String, CodingKey {
        case type, data, source, actionId, title, projectNames, agenda, attendees, contextPaths, actionType, prompt,
             chunkId, audioDurationSec, captureStartedAt, captureEndedAt, sequence, isContinuation, kind, focus,
             text, origin
    }

    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .sessionStart(let title, let projectNames, let agenda, let attendees, let contextPaths):
            try container.encode("session.start", forKey: .type)
            try container.encodeIfPresent(title, forKey: .title)
            try container.encodeIfPresent(projectNames, forKey: .projectNames)
            try container.encodeIfPresent(agenda, forKey: .agenda)
            try container.encodeIfPresent(attendees, forKey: .attendees)
            try container.encodeIfPresent(contextPaths, forKey: .contextPaths)
        case .sessionStop:
            try container.encode("session.stop", forKey: .type)
        case .sessionPause:
            try container.encode("session.pause", forKey: .type)
        case .sessionResume:
            try container.encode("session.resume", forKey: .type)
        case .audioChunk(let data, let source, let chunkId, let audioDurationSec, let captureStartedAt, let captureEndedAt, let sequence, let isContinuation):
            try container.encode("audio_chunk", forKey: .type)
            try container.encode(data, forKey: .data)
            try container.encode(source, forKey: .source)
            try container.encode(chunkId, forKey: .chunkId)
            try container.encode(audioDurationSec, forKey: .audioDurationSec)
            try container.encode(Self.iso8601.string(from: captureStartedAt), forKey: .captureStartedAt)
            try container.encode(Self.iso8601.string(from: captureEndedAt), forKey: .captureEndedAt)
            try container.encode(sequence, forKey: .sequence)
            try container.encode(isContinuation, forKey: .isContinuation)
        case .audioFlush:
            try container.encode("audio.flush", forKey: .type)
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
        case .pulseRequest(let kind):
            try container.encode("pulse.request", forKey: .type)
            try container.encode(kind, forKey: .kind)
        case .coachAsk(let focus):
            try container.encode("coach.ask", forKey: .type)
            try container.encodeIfPresent(focus, forKey: .focus)
        case .chatSend(let text):
            try container.encode("chat.send", forKey: .type)
            try container.encode(text, forKey: .text)
            try container.encode("menubar", forKey: .origin)
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
    /// The meeting pulse's close-out pass found things to settle before the call ends.
    case pulseCloseOut(body: String)
    /// The meeting pulse's latest big-picture read (every ~5 min).
    case pulseUpdate(MeetingPulse)
    /// One of the coach's questions (a dashboard button or a hotkey) was
    /// taken, answered, or failed. The app turns it into a notification.
    case askState(AskState)
    /// The server's own watchdog on the frames it receives
    /// (server/src/capture/track-watch.ts): "ok" | "stalled" | "silent".
    case captureHealth(mic: String, meeting: String)
    /// The dashboard's Restart mic button, relayed by the server.
    case captureRestartMic
    /// A message in the meeting chat (server/src/chat/service.ts): a question,
    /// or an answer as it starts and when it ends.
    case chatMessage(ChatReply)
    /// The live meeting was paused or resumed (server/src/session/pause.ts).
    case sessionPaused(PauseUpdate)

    private enum CodingKeys: String, CodingKey {
        case type, segment, action, actionId, state, result, sessionId, data, body, pulse,
             kind, phase, title, empty, mic, meeting, message, paused, pausedAt, pausedMs
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
            // The app only needs the state; a result shape it can't read
            // (a new artifact type) must not throw the state change away, or
            // a finished action stays "running" and session end waits it out.
            let result = (try? container.decodeIfPresent(ActionResult.self, forKey: .result)) ?? nil
            self = .actionStatus(actionId: actionId, state: state, result: result)
        case "session.state":
            let state = try container.decode(SessionState.self, forKey: .state)
            let sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
            self = .sessionState(state, sessionId: sessionId)
        case "metrics":
            let metrics = try container.decode(DebugMetrics.self, forKey: .data)
            self = .metrics(metrics)
        case "pulse.closeout":
            let body = try container.decode(String.self, forKey: .body)
            self = .pulseCloseOut(body: body)
        case "pulse.update":
            // The dashboard renders the pulse; the app only mirrors it in the
            // menu bar, so a shape it can't read degrades to "no pulse yet"
            // rather than a decode failure.
            if let pulse = try? container.decode(MeetingPulse.self, forKey: .pulse) {
                self = .pulseUpdate(pulse)
            } else {
                self = .metrics(DebugMetrics(transcriptLatencyMs: nil, activeWorkers: nil, audioBufferSizeBytes: nil, serverUptime: nil))
            }
        case "ask.state":
            self = .askState(AskState(
                kind: try container.decode(String.self, forKey: .kind),
                phase: try container.decode(String.self, forKey: .phase),
                title: try container.decodeIfPresent(String.self, forKey: .title),
                body: try container.decodeIfPresent(String.self, forKey: .body),
                empty: (try container.decodeIfPresent(Bool.self, forKey: .empty)) ?? false
            ))
        case "capture.health":
            self = .captureHealth(
                mic: (try container.decodeIfPresent(String.self, forKey: .mic)) ?? "ok",
                meeting: (try container.decodeIfPresent(String.self, forKey: .meeting)) ?? "ok"
            )
        case "capture.restartMic":
            self = .captureRestartMic
        case "session.paused":
            // pausedAt is epoch ms or null; a missing field reads as not paused.
            let pausedAtMs = try? container.decodeIfPresent(Double.self, forKey: .pausedAt)
            self = .sessionPaused(PauseUpdate(
                paused: (try? container.decodeIfPresent(Bool.self, forKey: .paused)) ?? false,
                pausedAt: pausedAtMs.map { Date(timeIntervalSince1970: $0 / 1000) },
                pausedMs: (try? container.decodeIfPresent(Double.self, forKey: .pausedMs)) ?? 0
            ))
        case "chat.message":
            // Only the menu bar reads these; a shape it can't read must not
            // fail the decode (gotcha #23).
            if let reply = try? container.decode(ChatReply.self, forKey: .message) {
                self = .chatMessage(reply)
            } else {
                self = .metrics(DebugMetrics(transcriptLatencyMs: nil, activeWorkers: nil, audioBufferSizeBytes: nil, serverUptime: nil))
            }
        default:
            // Ignore unknown message types gracefully
            self = .metrics(DebugMetrics(transcriptLatencyMs: nil, activeWorkers: nil, audioBufferSizeBytes: nil, serverUptime: nil))
        }
    }
}

// MARK: - Pause

/// `session.paused` in server/src/index.ts.
struct PauseUpdate: Equatable {
    let paused: Bool
    /// When the current pause began; nil while running.
    let pausedAt: Date?
    /// All paused time so far, the current pause included, as of the message.
    let pausedMs: Double
}

// MARK: - Coach Questions

/// `ask.state` in server/src/index.ts. `kind` is checkin | missed | suggest |
/// wrapup; `phase` is started | done | failed.
struct AskState: Equatable {
    let kind: String
    let phase: String
    let title: String?
    let body: String?
    /// done with no answer: Suggest found nothing worth saying.
    let empty: Bool
}

// MARK: - Meeting Chat

/// One message of the meeting chat: `ChatMessage` in server/src/chat/store.ts.
/// Only the fields the menu bar shows. The dashboard renders the thread.
struct ChatReply: Decodable, Equatable {
    let id: String
    /// "user" | "assistant"
    let role: String
    let content: String
    /// "dashboard" | "menubar": where the question was asked.
    let origin: String
    /// "streaming" | "done" | "error" | "cancelled"
    let state: String
    let error: String?

    var isAnswer: Bool { role == "assistant" }
    var isFinished: Bool { state != "streaming" }

    /// The answer as plain text for the popover and a notification: no
    /// Sources line, no markdown marks, links as their titles.
    var plainContent: String {
        var text = content
        if let range = text.range(of: "\n\n**Sources:**") { text = String(text[..<range.lowerBound]) }
        text = text.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?m)^#{1,6}\s+"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?m)^\s*[-*]\s+"#, with: "• ", options: .regularExpression)
        text = text.replacingOccurrences(of: "**", with: "")
        text = text.replacingOccurrences(of: "`", with: "")
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// The menu bar's Ask: its question, and the one chat answer that belongs to
/// it. The server sends a question and its answer's first, "streaming" copy
/// back to back (chat/service.ts `send`), so the answer right after the echo
/// of our question is ours. Any other one (an earlier question still
/// finishing, the previous meeting's) is not, and is ignored.
struct MenubarChat: Equatable {
    private(set) var question: String?
    private(set) var answer: ChatReply?
    private var claimNext = false

    /// Sent from the Ask box; the server's echo confirms it.
    mutating func asked(_ text: String) {
        question = text
        answer = nil
        claimNext = false
    }

    /// Take a chat.message. Returns the answer when it has just finished
    /// (for the notification), nil otherwise.
    mutating func receive(_ reply: ChatReply) -> ChatReply? {
        guard reply.origin == "menubar" else { return nil }
        if !reply.isAnswer {
            question = reply.content
            answer = nil
            claimNext = true
            return nil
        }
        // Ours starts "streaming"; a finished one arriving here is a late
        // answer to something else and must not take the claim.
        if claimNext && !reply.isFinished {
            claimNext = false
            answer = reply
            return nil
        }
        guard answer?.id == reply.id else { return nil }
        answer = reply
        return reply.isFinished ? reply : nil
    }
}

// MARK: - Meeting Pulse

/// The meeting pulse's read of the whole meeting — `MeetingPulseResult` in
/// server/src/intelligence/pulse.ts. Only the fields the menu bar shows.
struct MeetingPulse: Decodable, Equatable {
    struct Item: Decodable, Equatable {
        let text: String
        let why: String?
    }

    enum Status: String, Decodable {
        case onTrack = "on_track"
        case drifting
        case stuck
    }

    let id: String
    let status: Status
    let read: String
    let escalations: [Item]
    /// Minutes to the calendar end when this read was taken; nil unless the
    /// meeting was started from an invite.
    let minutesLeft: Double?
    /// Epoch milliseconds on the wire.
    let createdAt: Date
}

// MARK: - Debug Metrics

struct DebugMetrics: Codable {
    let transcriptLatencyMs: Double?
    let activeWorkers: Int?
    let audioBufferSizeBytes: Int?
    let serverUptime: TimeInterval?
}
