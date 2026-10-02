import XCTest
@testable import MeetingCopilot

/// T230: Sparkle must never interrupt a meeting. A background check that
/// finds an update opens a window (a shared screen would show it), and
/// installing quits the app, which ends the session.
final class UpdatePolicyTests: XCTestCase {
    func testEveryStateFromStartToArchiveIsAMeeting() {
        let meeting: [SessionState] = [.priming, .live, .degraded, .ending]
        let notMeeting: [SessionState] = [.idle, .error, .archived]
        for state in meeting { XCTAssertTrue(state.isMeeting, "\(state)") }
        for state in notMeeting { XCTAssertFalse(state.isMeeting, "\(state)") }
    }

    func testBackgroundChecksWaitForTheMeeting() {
        XCTAssertFalse(UpdatePolicy.mayCheck(userInitiated: false, inMeeting: true))
        XCTAssertTrue(UpdatePolicy.mayCheck(userInitiated: false, inMeeting: false))
    }

    func testACheckTheUserAsksForAlwaysRuns() {
        XCTAssertTrue(UpdatePolicy.mayCheck(userInitiated: true, inMeeting: true))
    }

    func testInstallWaitsForTheMeeting() {
        XCTAssertTrue(UpdatePolicy.postponeInstall(inMeeting: true))
        XCTAssertFalse(UpdatePolicy.postponeInstall(inMeeting: false))
    }

    func testCloseOutWorkCountsWhatIsStillToRun() {
        // GET /debug's shape (server/src/debug/index.ts): workers.byState.
        let json = #"{"workers":{"byState":{"running":1,"queued":2,"approved":1,"completed":7,"failed":1}}}"#
        XCTAssertEqual(UpdatePolicy.busyWorkers(debugJSON: Data(json.utf8)), 4)
        let idle = #"{"workers":{"byState":{"completed":3}}}"#
        XCTAssertEqual(UpdatePolicy.busyWorkers(debugJSON: Data(idle.utf8)), 0)
        XCTAssertNil(UpdatePolicy.busyWorkers(debugJSON: Data("not json".utf8)))
    }
}
