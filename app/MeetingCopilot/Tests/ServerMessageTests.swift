import XCTest
@testable import MeetingCopilot

final class ServerMessageTests: XCTestCase {
    /// The decoder the WebSocket client actually uses. Decoding with a bare
    /// JSONDecoder() here is what let the fractional-seconds failure through.
    private func decode(_ json: String) throws -> ServerMessage {
        try JSONDecoder.copilotDecoder.decode(ServerMessage.self, from: Data(json.utf8))
    }

    func testPulseCloseOutDecodesItsBody() throws {
        let message = try decode(#"{"type":"pulse.closeout","body":"Ask who owns the pilot readout · Propose a follow-up"}"#)
        guard case .pulseCloseOut(let body) = message else {
            return XCTFail("expected .pulseCloseOut, got \(message)")
        }
        XCTAssertEqual(body, "Ask who owns the pilot readout · Propose a follow-up")
    }

    func testCaptureHealthDecodesBothTracks() throws {
        // server/src/index.ts: broadcast({ type: 'capture.health', ...trackWatch.snapshot() })
        let message = try decode(#"{"type":"capture.health","mic":"stalled","meeting":"ok"}"#)
        guard case .captureHealth(let mic, let meeting) = message else {
            return XCTFail("expected .captureHealth, got \(message)")
        }
        XCTAssertEqual(mic, "stalled")
        XCTAssertEqual(meeting, "ok")
    }

    func testCaptureRestartMicDecodes() throws {
        let message = try decode(#"{"type":"capture.restartMic"}"#)
        guard case .captureRestartMic = message else {
            return XCTFail("expected .captureRestartMic, got \(message)")
        }
    }

    // MARK: - Pause (server/src/session/pause.ts)

    func testSessionPausedDecodesThePauseAndTheResume() throws {
        // Captured from the server's WebSocket (e2e/09-pause.spec.ts), 2026-10-02.
        let paused = try decode(#"{"type":"session.paused","sessionId":"a1","paused":true,"pausedAt":1791000000123,"pausedMs":4000}"#)
        guard case .sessionPaused(let p) = paused else { return XCTFail("expected .sessionPaused, got \(paused)") }
        XCTAssertTrue(p.paused)
        XCTAssertEqual(p.pausedAt, Date(timeIntervalSince1970: 1_791_000_000.123))
        XCTAssertEqual(p.pausedMs, 4000)

        let resumed = try decode(#"{"type":"session.paused","sessionId":"a1","paused":false,"pausedAt":null,"pausedMs":64000,"marker":{"id":"m1","label":"[Paused]","text":"Paused 1 min (2:02 PM–2:03 PM). Nothing was recorded.","timestamp":1791000064123}}"#)
        guard case .sessionPaused(let r) = resumed else { return XCTFail("expected .sessionPaused, got \(resumed)") }
        XCTAssertFalse(r.paused)
        XCTAssertNil(r.pausedAt)
        XCTAssertEqual(r.pausedMs, 64000)
    }

    func testPauseAndResumeEncodeWhatTheServerReads() throws {
        func json(_ message: ClientMessage) throws -> [String: String] {
            let data = try JSONEncoder.copilotEncoder.encode(message)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        }
        XCTAssertEqual(try json(.sessionPause), ["type": "session.pause"])
        XCTAssertEqual(try json(.sessionResume), ["type": "session.resume"])
    }

    func testMessagesTheAppDoesNotHandleStillDecode() throws {
        // The dashboard's own messages (coach.history, factcheck.flag, …) reach
        // the app's socket too; an unknown type must never fail the decode.
        let message = try decode(#"{"type":"coach.history","suggestions":[]}"#)
        guard case .metrics = message else {
            return XCTFail("unknown types fall through to .metrics, got \(message)")
        }
    }

    // MARK: - Real wire format
    //
    // Every payload below is what server/src/index.ts actually broadcasts:
    // dates from JS toISOString() (always with milliseconds), pulse times in
    // epoch ms. Foundation's .iso8601 strategy rejected the milliseconds, so
    // every transcript.update and action.suggested failed to decode.

    func testTranscriptUpdateWithMillisecondTimestampDecodes() throws {
        let message = try decode(#"""
        {"type":"transcript.update","segment":{"id":"s1","text":"the pilot starts in May","source":"meeting",
         "label":"[Meeting]","timestamp":"2026-09-22T19:04:05.123Z","audioDurationSec":4,
         "transcriptionLatencyMs":812,"sequence":7,"duration":4,"wordCount":5}}
        """#)
        guard case .transcriptUpdate(let segment) = message else {
            return XCTFail("expected .transcriptUpdate, got \(message)")
        }
        XCTAssertEqual(segment.wordCount, 5)
        XCTAssertEqual(segment.timestamp.timeIntervalSince1970, 1_790_103_845.123, accuracy: 0.001)
    }

    func testFastResearchSuggestionDecodes() throws {
        // fast-research is the default suggested research type
        // (intelligence/suggested-type.ts), so this is the common card.
        let message = try decode(#"""
        {"type":"action.suggested","action":{"id":"a1","type":"fast-research",
         "title":"FieldPulse API rate limits","description":"They asked about sync limits",
         "triggerQuote":"what are the limits","estimatedDurationSec":20,"state":"suggested",
         "createdAt":"2026-09-22T19:04:05.123Z"}}
        """#)
        guard case .actionSuggested(let action) = message else {
            return XCTFail("expected .actionSuggested, got \(message)")
        }
        XCTAssertEqual(action.type, .fastResearch)
        XCTAssertEqual(action.state, .suggested)
    }

    func testUnknownActionTypeStillDecodes() throws {
        let message = try decode(#"""
        {"type":"action.suggested","action":{"id":"a2","type":"storyboard","title":"t","description":"d",
         "triggerQuote":"q","estimatedDurationSec":30,"state":"suggested","createdAt":"2026-09-22T19:04:05.123Z"}}
        """#)
        guard case .actionSuggested(let action) = message else {
            return XCTFail("expected .actionSuggested, got \(message)")
        }
        XCTAssertEqual(action.type, .other)
    }

    func testActionStatusKeepsTheStateWhenTheResultIsUnreadable() throws {
        // A mockup finishes with an html artifact; a result shape the app
        // can't read must not cost it the "completed" state.
        let message = try decode(#"""
        {"type":"action.status","actionId":"a1","state":"completed",
         "result":{"success":true,"data":{},"summary":"done","artifacts":[{"type":"svg","content":"<svg/>"}]}}
        """#)
        guard case .actionStatus(let id, let state, _) = message else {
            return XCTFail("expected .actionStatus, got \(message)")
        }
        XCTAssertEqual(id, "a1")
        XCTAssertEqual(state, .completed)
    }

    func testPulseUpdateDecodes() throws {
        let message = try decode(#"""
        {"type":"pulse.update","pulse":{"id":"p1","mode":"pulse","trigger":"interval","status":"drifting",
         "read":"Pricing keeps getting deferred while the demo runs long.",
         "escalations":[{"text":"Ask Rory who owns the rollout date","why":"No owner yet"}],
         "closeOut":[],"minutesIn":14,"minutesLeft":16,"createdAt":1790103845123,"latencyMs":9000}}
        """#)
        guard case .pulseUpdate(let pulse) = message else {
            return XCTFail("expected .pulseUpdate, got \(message)")
        }
        XCTAssertEqual(pulse.status, .drifting)
        XCTAssertEqual(pulse.escalations.first?.text, "Ask Rory who owns the rollout date")
        XCTAssertEqual(pulse.minutesLeft, 16)
        XCTAssertEqual(pulse.createdAt.timeIntervalSince1970, 1_790_103_845.123, accuracy: 0.001)
    }

    func testMalformedPulseDoesNotFailTheDecode() throws {
        let message = try decode(#"{"type":"pulse.update","pulse":{"id":"x"}}"#)
        guard case .metrics = message else {
            return XCTFail("an unreadable pulse falls through to .metrics, got \(message)")
        }
    }

    // MARK: - Coach questions (⌃⌥1/2/3 and the coach head's buttons)

    func testAskStateDecodes() throws {
        let message = try decode(#"""
        {"type":"ask.state","kind":"missed","phase":"done","title":"You may have missed",
         "body":"Dana asked about Q3 pricing · No owner for the pilot readout"}
        """#)
        guard case .askState(let ask) = message else {
            return XCTFail("expected .askState, got \(message)")
        }
        XCTAssertEqual(ask, AskState(kind: "missed", phase: "done", title: "You may have missed",
                                     body: "Dana asked about Q3 pricing · No owner for the pilot readout", empty: false))
    }

    func testAskStateStartedHasNoTitleForSuggest() throws {
        let message = try decode(#"{"type":"ask.state","kind":"suggest","phase":"started"}"#)
        guard case .askState(let ask) = message else {
            return XCTFail("expected .askState, got \(message)")
        }
        XCTAssertNil(ask.title)
        XCTAssertFalse(ask.empty)
    }

    func testHotkeyMessagesEncodeWhatTheServerReads() throws {
        func json(_ message: ClientMessage) throws -> [String: String] {
            let data = try JSONEncoder.copilotEncoder.encode(message)
            return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        }
        XCTAssertEqual(try json(.pulseRequest(kind: "checkin")), ["type": "pulse.request", "kind": "checkin"])
        XCTAssertEqual(try json(.coachAsk(focus: nil)), ["type": "coach.ask"])
    }

    // MARK: - Meeting chat (server/src/chat/service.ts)

    func testChatSendEncodesWhatTheServerReads() throws {
        let data = try JSONEncoder.copilotEncoder.encode(ClientMessage.chatSend(text: "What did Rory commit to?"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: String])
        XCTAssertEqual(object, ["type": "chat.send", "text": "What did Rory commit to?", "origin": "menubar"])
    }

    func testChatMessageDecodesTheRealBroadcast() throws {
        // Captured from the server's WebSocket on 2026-09-25.
        let message = try decode(#"""
        {"type":"chat.message","sessionId":"e3cf5767-4dcd-48c0-a059-865564eb38f6","message":{"id":"a1","role":"assistant",
         "content":"The agenda has **Pricing** and **Next steps**. Nothing has been said yet.","attachments":[],
         "origin":"menubar","state":"done","via":"gpt-6-luna","createdAt":1790352969123}}
        """#)
        guard case .chatMessage(let reply) = message else {
            return XCTFail("expected .chatMessage, got \(message)")
        }
        XCTAssertEqual(reply.origin, "menubar")
        XCTAssertTrue(reply.isAnswer)
        XCTAssertTrue(reply.isFinished)
        XCTAssertEqual(reply.plainContent, "The agenda has Pricing and Next steps. Nothing has been said yet.")
    }

    func testChatDeltasAndOddShapesNeverFailTheDecode() throws {
        guard case .metrics = try decode(#"{"type":"chat.delta","sessionId":"s","id":"a1","seq":3,"text":"Pri"}"#) else {
            return XCTFail("chat.delta is the dashboard's")
        }
        guard case .metrics = try decode(#"{"type":"chat.message","sessionId":"s","message":{"id":"a1"}}"#) else {
            return XCTFail("a chat.message the app can't read falls through")
        }
    }

    func testChatAnswerAsPlainText() {
        let reply = ChatReply(id: "a", role: "assistant",
                              content: "## Ask Brightline\n- **Tracking audit:** see [GA4 help](https://support.google.com/x)\n- `DebugView` check\n\n**Sources:** [GA4 help](https://support.google.com/x)",
                              origin: "menubar", state: "done", error: nil)
        XCTAssertEqual(reply.plainContent, "Ask Brightline\n• Tracking audit: see GA4 help\n• DebugView check")
    }
}
