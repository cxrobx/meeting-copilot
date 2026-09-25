import XCTest
@testable import MeetingCopilot

/// Which chat answer the menu bar's Ask shows (MenubarChat in Messages.swift).
final class MenubarChatTests: XCTestCase {
    private func question(_ text: String, origin: String = "menubar") -> ChatReply {
        ChatReply(id: UUID().uuidString, role: "user", content: text, origin: origin, state: "done", error: nil)
    }

    private func answer(_ id: String, _ state: String, _ content: String = "", origin: String = "menubar") -> ChatReply {
        ChatReply(id: id, role: "assistant", content: content, origin: origin, state: state, error: nil)
    }

    func testTheAnswerAfterItsQuestionIsShownAndItsEndIsReported() {
        var chat = MenubarChat()
        chat.asked("What did Rory commit to?")
        XCTAssertNil(chat.receive(question("What did Rory commit to?")))
        XCTAssertNil(chat.receive(answer("a1", "streaming")))
        XCTAssertEqual(chat.answer?.state, "streaming")
        let done = chat.receive(answer("a1", "done", "A list by Friday."))
        XCTAssertEqual(done?.content, "A list by Friday.")
        XCTAssertEqual(chat.question, "What did Rory commit to?")
        XCTAssertEqual(chat.answer?.content, "A list by Friday.")
    }

    // The review's race (2026-09-25): a question near the end of one meeting,
    // a new meeting, a new question, and the old answer lands first.
    func testTheLastMeetingsAnswerNeverLandsUnderANewQuestion() {
        var chat = MenubarChat()
        chat.asked("Old question")
        _ = chat.receive(question("Old question"))
        _ = chat.receive(answer("old", "streaming"))
        chat = MenubarChat() // the meeting ended
        chat.asked("New question")
        XCTAssertNil(chat.receive(answer("old", "done", "Old answer")))
        XCTAssertNil(chat.answer)
        _ = chat.receive(question("New question"))
        XCTAssertNil(chat.receive(answer("old", "done", "Old answer")))
        _ = chat.receive(answer("new", "streaming"))
        XCTAssertNil(chat.receive(answer("old", "done", "Old answer")))
        XCTAssertEqual(chat.receive(answer("new", "done", "New answer"))?.content, "New answer")
    }

    // The server answers in order, so a second question's placeholder goes out
    // before the first answer finishes.
    func testAnEarlierQuestionStillFinishingIsNotShownUnderTheNextOne() {
        var chat = MenubarChat()
        _ = chat.receive(question("First"))
        _ = chat.receive(answer("a1", "streaming"))
        _ = chat.receive(question("Second"))
        _ = chat.receive(answer("a2", "streaming"))
        XCTAssertNil(chat.receive(answer("a1", "done", "First answer")))
        XCTAssertEqual(chat.question, "Second")
        XCTAssertEqual(chat.answer?.id, "a2")
    }

    func testTheDashboardsOwnTurnsAreIgnored() {
        var chat = MenubarChat()
        chat.asked("Mine")
        _ = chat.receive(question("Mine"))
        _ = chat.receive(answer("a1", "streaming"))
        XCTAssertNil(chat.receive(question("From the page", origin: "dashboard")))
        XCTAssertNil(chat.receive(answer("d1", "done", "Page answer", origin: "dashboard")))
        XCTAssertEqual(chat.question, "Mine")
        XCTAssertEqual(chat.answer?.id, "a1")
    }
}
