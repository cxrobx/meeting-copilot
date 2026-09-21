import XCTest
@testable import MeetingCopilot

final class DashboardNavigationTests: XCTestCase {
    private let policy = DashboardNavigationPolicy(dashboardURL: URL(string: "http://localhost:17890/present")!)

    func testDashboardReplayAndAnchorStayInApp() {
        for path in ["/present", "/present/", "/present?session=meeting-123", "/present#results"] {
            XCTAssertEqual(policy.destination(for: URL(string: "http://localhost:17890" + path)!), .dashboard)
        }
    }

    func testResearchLinksOpenExternally() {
        for value in ["https://note.com/article", "http://example.com", "mailto:hello@example.com", "tel:+15555555555"] {
            XCTAssertEqual(policy.destination(for: URL(string: value)!), .external)
        }
    }

    func testRegularAndNewWindowLinksCannotNavigateTheDashboard() {
        let article = URL(string: "https://note.com/article")!
        XCTAssertEqual(policy.decision(for: article, targetIsMainFrame: true), .openExternally)
        XCTAssertEqual(policy.decision(for: article, targetIsMainFrame: nil), .openExternally)
        let replay = URL(string: "http://localhost:17890/present?session=123")!
        XCTAssertEqual(policy.decision(for: replay, targetIsMainFrame: true), .allow)
        XCTAssertEqual(policy.decision(for: replay, targetIsMainFrame: nil), .openExternally)
    }

    func testMockupFramesRemainEmbeddedButCannotReplaceDashboard() {
        let preview = URL(string: "about:srcdoc")!
        XCTAssertEqual(policy.decision(for: preview, targetIsMainFrame: false), .allow)
        XCTAssertEqual(policy.decision(for: preview, targetIsMainFrame: true), .cancel)
        XCTAssertEqual(policy.decision(for: nil, targetIsMainFrame: true), .cancel)
        XCTAssertEqual(policy.decision(for: nil, targetIsMainFrame: nil), .cancel)
    }

    func testOtherLocalPagesCannotReplaceDashboard() {
        for value in ["http://localhost:17890/health", "http://localhost:17891/present",
                      "https://localhost:17890/present", "http://localhost.example.com:17890/present",
                      "http://localhost:17890/present/article", "http://user@localhost:17890/present"] {
            XCTAssertEqual(policy.destination(for: URL(string: value)!), .external)
        }
    }

    func testConfiguredPortIsRespected() {
        let custom = DashboardNavigationPolicy(dashboardURL: URL(string: "http://127.0.0.1:19000/present")!)
        XCTAssertTrue(custom.isDashboard(URL(string: "http://127.0.0.1:19000/present?session=123")!))
        XCTAssertFalse(custom.isDashboard(URL(string: "http://127.0.0.1:17890/present")!))
    }

    func testUnsupportedURLsCannotReplaceDashboardOrLaunchApps() {
        for value in ["javascript:alert(1)", "data:text/html,hello", "file:///tmp/example.html", "about:blank", "custom-app:run"] {
            XCTAssertEqual(policy.destination(for: URL(string: value)!), .blocked)
        }
    }

    func testIntentionalCancellationDoesNotTriggerDashboardReload() {
        XCTAssertTrue(DashboardNavigationPolicy.isCancelledNavigation(NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)))
        XCTAssertTrue(DashboardNavigationPolicy.isCancelledNavigation(NSError(domain: "WebKitErrorDomain", code: 102)))
        XCTAssertFalse(DashboardNavigationPolicy.isCancelledNavigation(NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)))
    }
}
