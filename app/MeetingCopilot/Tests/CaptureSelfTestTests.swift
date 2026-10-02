import XCTest
@testable import MeetingCopilot

/// The self-test mode must only ever start from its exact flag with an output
/// path: any other launch is the real app, which starts the server.
@MainActor
final class CaptureSelfTestTests: XCTestCase {
    func testFlagWithAPathRequestsTheSelfTest() {
        XCTAssertEqual(
            CaptureSelfTest.requestedOutput(["MeetingCopilot", "--capture-selftest", "/tmp/out.json"])?.path,
            "/tmp/out.json")
    }

    func testOrdinaryLaunchesDoNot() {
        XCTAssertNil(CaptureSelfTest.requestedOutput(["MeetingCopilot"]))
        XCTAssertNil(CaptureSelfTest.requestedOutput(["MeetingCopilot", "-NSDocumentRevisionsDebugMode", "YES"]))
        // A flag with nothing after it has nowhere to report, so it is not a run.
        XCTAssertNil(CaptureSelfTest.requestedOutput(["MeetingCopilot", "--capture-selftest"]))
    }
}
