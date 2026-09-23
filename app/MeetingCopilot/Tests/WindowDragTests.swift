import XCTest
import AppKit
@testable import MeetingCopilot

/// The page decides a press landed in its title bar; `WindowDrag` decides what
/// that press may still become. Moving the real window needs a real mouse, so
/// the drag itself is checked by hand — this pins everything around it.
final class WindowDragTests: XCTestCase {
    private let now: TimeInterval = 5_000

    // MARK: - What a press becomes

    func testAFreshHeldPressDrags() {
        XCTAssertEqual(WindowDrag.action(clickCount: 1, pressedAt: now - 0.01, now: now, buttonHeld: true), .drag)
    }

    func testAPressAlreadyReleasedIsJustAClick() {
        // Nothing to drag once the button is up; AppKit would drag from nowhere.
        XCTAssertEqual(WindowDrag.action(clickCount: 1, pressedAt: now - 0.01, now: now, buttonHeld: false), .none)
    }

    func testADoubleClickActsEvenAfterRelease() {
        // A quick double-click is usually up before the page's request lands.
        XCTAssertEqual(WindowDrag.action(clickCount: 2, pressedAt: now - 0.05, now: now, buttonHeld: false), .titleBarDoubleClick)
        XCTAssertEqual(WindowDrag.action(clickCount: 2, pressedAt: now - 0.05, now: now, buttonHeld: true), .titleBarDoubleClick)
    }

    func testAStalePressDoesNothing() {
        let stale = now - WindowDrag.maxPressAge - 0.01
        XCTAssertEqual(WindowDrag.action(clickCount: 1, pressedAt: stale, now: now, buttonHeld: true), .none)
        XCTAssertEqual(WindowDrag.action(clickCount: 2, pressedAt: stale, now: now, buttonHeld: false), .none)
    }

    func testAPressFromTheFutureDoesNothing() {
        XCTAssertEqual(WindowDrag.action(clickCount: 1, pressedAt: now + 1, now: now, buttonHeld: true), .none)
    }

    func testATripleClickDoesNothing() {
        XCTAssertEqual(WindowDrag.action(clickCount: 3, pressedAt: now - 0.01, now: now, buttonHeld: true), .none)
    }

    // MARK: - What a title-bar double-click does

    private func defaults(_ values: [String: Any]) -> UserDefaults {
        let name = "WindowDragTests.\(UUID().uuidString)"
        let suite = UserDefaults(suiteName: name)!
        addTeardownBlock { suite.removePersistentDomain(forName: name) }
        for (key, value) in values { suite.set(value, forKey: key) }
        return suite
    }

    func testDoubleClickFollowsSystemSettings() {
        XCTAssertEqual(WindowDrag.doubleClickAction(defaults: defaults(["AppleActionOnDoubleClick": "Maximize"])), .zoom)
        XCTAssertEqual(WindowDrag.doubleClickAction(defaults: defaults(["AppleActionOnDoubleClick": "Fill"])), .zoom)
        XCTAssertEqual(WindowDrag.doubleClickAction(defaults: defaults(["AppleActionOnDoubleClick": "Minimize"])), .minimize)
        XCTAssertEqual(WindowDrag.doubleClickAction(defaults: defaults(["AppleActionOnDoubleClick": "None"])), .none)
    }

    func testDoubleClickWithNothingSetZooms() throws {
        // A suite still reads the global domain, so this only means something
        // on a Mac where the setting was never changed.
        try XCTSkipIf(UserDefaults.standard.object(forKey: "AppleActionOnDoubleClick") != nil,
                      "this Mac sets AppleActionOnDoubleClick globally")
        XCTAssertEqual(WindowDrag.doubleClickAction(defaults: defaults([:])), .zoom)
        XCTAssertEqual(WindowDrag.doubleClickAction(defaults: defaults(["AppleMiniaturizeOnDoubleClick": true])), .minimize)
    }

    // MARK: - The panel can actually zoom

    @MainActor
    func testTheDashboardPanelZoomsAndUnzooms() throws {
        // A utility panel shows no zoom button; `zoom(_:)` must still resize it,
        // or the double-click would silently do nothing.
        let screen = try XCTUnwrap(NSScreen.main, "needs a display")
        let panel = NSPanel(
            contentRect: NSRect(x: screen.visibleFrame.minX + 40, y: screen.visibleFrame.minY + 40, width: 1040, height: 760),
            styleMask: [.titled, .closable, .resizable, .utilityWindow, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.isReleasedWhenClosed = false
        defer { panel.close() }
        let before = panel.frame

        panel.zoom(nil)
        XCTAssertNotEqual(panel.frame, before, "zoom(_:) left the panel's frame unchanged")
        XCTAssertGreaterThan(panel.frame.width * panel.frame.height, before.width * before.height)

        panel.zoom(nil)
        XCTAssertEqual(panel.frame, before, "a second zoom(_:) should restore the user's frame")
    }
}
