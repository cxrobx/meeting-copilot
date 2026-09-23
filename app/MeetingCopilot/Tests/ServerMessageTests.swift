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
}
