import XCTest
@testable import MeetingCopilot

final class ServerMessageTests: XCTestCase {
    private func decode(_ json: String) throws -> ServerMessage {
        try JSONDecoder().decode(ServerMessage.self, from: Data(json.utf8))
    }

    func testPulseCloseOutDecodesItsBody() throws {
        let message = try decode(#"{"type":"pulse.closeout","body":"Ask who owns the pilot readout · Propose a follow-up"}"#)
        guard case .pulseCloseOut(let body) = message else {
            return XCTFail("expected .pulseCloseOut, got \(message)")
        }
        XCTAssertEqual(body, "Ask who owns the pilot readout · Propose a follow-up")
    }

    func testMessagesTheAppDoesNotHandleStillDecode() throws {
        // The dashboard's own messages (pulse.update, coach.history, …) reach
        // the app's socket too; an unknown type must never fail the decode.
        let message = try decode(#"{"type":"pulse.update","pulse":{"id":"x"}}"#)
        guard case .metrics = message else {
            return XCTFail("unknown types fall through to .metrics, got \(message)")
        }
    }
}
