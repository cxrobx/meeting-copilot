import XCTest
import SwiftUI
@testable import MeetingCopilot

/// Renders the menu bar popover's states to PNGs for a visual check against
/// CXNotes' panel (the design it mirrors). Opt-in, because it writes files:
///
///     MC_RENDER_DIR=/tmp/mb swift test --filter MenuBarRenderTests
///
/// ImageRenderer draws AppKit-backed controls (the Ask field, spinners) as
/// placeholders and has no window material behind it, so this checks layout,
/// palette and type — the running popover is the check for the rest.
@MainActor
final class MenuBarRenderTests: XCTestCase {
    private let backdrop = Color(red: 0.16, green: 0.16, blue: 0.17)

    func testRenderPopoverStates() throws {
        guard let dir = ProcessInfo.processInfo.environment["MC_RENDER_DIR"] else {
            throw XCTSkip("Set MC_RENDER_DIR to render the menu bar popover")
        }
        let out = URL(fileURLWithPath: dir, isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let now = Date()

        // Idle, with an invite coming up and four past sessions.
        let idle = SessionManager()
        idle.serverReady = true
        let idleFeed = MenuBarFeed()
        idleFeed.loadPreview(
            sessions: [
                RecentSession(id: "1", title: "Meets: Christopher (CX) / Winslow (Harbor Ventures)",
                              startedAt: now.addingTimeInterval(-86_400), endedAt: now.addingTimeInterval(-84_380),
                              actionCount: 3, segmentCount: 428, empty: false),
                RecentSession(id: "2", title: "AI Media", startedAt: now.addingTimeInterval(-8 * 86_400),
                              endedAt: now.addingTimeInterval(-8 * 86_400 + 2_430), actionCount: 8, segmentCount: 652, empty: false),
                RecentSession(id: "3", title: "Globex Portal Sync", startedAt: now.addingTimeInterval(-53 * 86_400),
                              endedAt: now.addingTimeInterval(-53 * 86_400 + 2_970), actionCount: 4, segmentCount: 740, empty: false),
                RecentSession(id: "4", title: "Teacher Hero", startedAt: now.addingTimeInterval(-3 * 86_400),
                              endedAt: now.addingTimeInterval(-3 * 86_400 + 1_800), actionCount: 1, segmentCount: 300, empty: false),
            ],
            next: UpcomingMeeting(
                eventUid: "evt-1", title: "ACME Phase 1 walkthrough",
                startsAt: now.addingTimeInterval(12 * 60), endsAt: now.addingTimeInterval(42 * 60),
                meetLink: "https://meet.google.com/abc-defg-hij",
                attendees: [.init(name: "Rory", email: "t@example.com"), .init(name: "Eli Park", email: "e@example.com")]
            ),
            meetingLevels: [], micLevels: []
        )
        try render(MenuBarView(sessionManager: idle, feed: idleFeed, actions: Self.noActions), to: out.appendingPathComponent("idle.png"))

        // Live, 12:48 in, with a pulse, two waiting suggestions and one running.
        let live = SessionManager()
        live.serverReady = true
        var session = Session(state: .live, title: "ACME Phase 1 walkthrough")
        session.startedAt = now.addingTimeInterval(-768)
        live.currentSession = session
        live.state = .live
        live.isRecording = true
        live.sessionElapsedTime = 768
        live.meetingAttendees = "Rory, Eli Park"
        live.latestPulse = MeetingPulse(
            id: "p1", status: .onTrack,
            read: "Pilot scope is agreed; pricing keeps getting pushed to the end.",
            escalations: [.init(text: "Ask Rory who owns the rollout date", why: "No owner yet")],
            minutesLeft: 17, createdAt: now.addingTimeInterval(-40)
        )
        live.actions = [
            ActionSuggestion(type: .fastResearch, title: "FieldPulse API rate limits for two-way sync",
                             description: "", triggerQuote: ""),
            ActionSuggestion(type: .analysis, title: "Compare $399/mo against their current answering service",
                             description: "", triggerQuote: ""),
            ActionSuggestion(type: .summary, title: "Summary: decisions so far", description: "",
                             triggerQuote: "", state: .running),
        ]
        let liveFeed = MenuBarFeed()
        liveFeed.loadPreview(
            sessions: [], next: nil,
            meetingLevels: Self.wave(seed: 1), micLevels: Self.wave(seed: 2, quietTail: true)
        )
        try render(MenuBarView(sessionManager: live, feed: liveFeed, actions: Self.noActions), to: out.appendingPathComponent("live.png"))

        // Live with the capture watchdog's silence warning.
        live.captureWarning = "No meeting audio for 25 s. Check System Settings → Privacy & Security → System Audio Recording."
        live.latestPulse = nil
        live.actions = []
        liveFeed.loadPreview(sessions: [], next: nil,
                             meetingLevels: [Float](repeating: 0, count: MenuBarFeed.historyBars),
                             micLevels: Self.wave(seed: 3))
        try render(MenuBarView(sessionManager: live, feed: liveFeed, actions: Self.noActions), to: out.appendingPathComponent("live-silent.png"))
    }

    private func render<V: View>(_ view: V, to url: URL) throws {
        let renderer = ImageRenderer(content: view.background(backdrop))
        renderer.scale = 2
        guard let image = renderer.nsImage,
              let tiff = image.tiffRepresentation,
              let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else {
            return XCTFail("render failed for \(url.lastPathComponent)")
        }
        try png.write(to: url)
    }

    private static func wave(seed: Int, quietTail: Bool = false) -> [Float] {
        (0..<MenuBarFeed.historyBars).map { i in
            if quietTail && i > 26 { return 0 }
            let x = Double(i + seed * 7)
            return Float(max(0, 0.35 + 0.3 * sin(x * 0.7) + 0.2 * sin(x * 1.9 + Double(seed))))
        }
    }

    private static let noActions = MenuBarActions(
        startSession: {}, setUpInvite: { _ in }, openSession: { _ in }, openHistory: {},
        togglePanel: {}, openSettings: {}, openSessionsFolder: {}, openNotesFolder: {}, quit: {}
    )
}
