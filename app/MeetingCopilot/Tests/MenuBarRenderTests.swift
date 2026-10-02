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

    /// The vault palette `/present/vault-look` served on 2026-09-22 (dark).
    static let vaultDark: [String: String] = [
        "bg-primary": "26 26 26", "bg-sidebar": "26 26 26", "bg-surface": "24 24 24",
        "bg-elevated": "34 35 34", "bg-input": "32 32 32",
        "border-default": "50 50 48", "border-subtle": "38 38 37",
        "text-primary": "196 197 181", "text-secondary": "152 153 141",
        "text-muted": "106 106 99", "text-faint": "79 79 74",
        "accent": "88 209 235", "accent-hover": "115 206 222", "accent-ink": "26 26 26",
        "font-sans": "\"JetBrains Mono\", Inter, ui-sans-serif, -apple-system, sans-serif",
    ]

    /// A Solarized Light vault, for the light path.
    static let vaultLight: [String: String] = [
        "bg-primary": "253 246 227", "bg-sidebar": "238 232 213", "bg-surface": "241 234 210",
        "bg-elevated": "238 232 213", "bg-input": "247 241 222",
        "border-default": "218 218 203", "border-subtle": "235 232 215",
        "text-primary": "0 43 54", "text-secondary": "68 98 101",
        "text-muted": "101 123 131", "text-faint": "147 161 161",
        "accent": "203 75 22", "accent-hover": "180 65 18", "accent-ink": "255 255 255",
        "font-sans": "\"JetBrains Mono\", Inter, ui-sans-serif",
    ]

    func testVaultTokensMakeATheme() throws {
        let dark = try XCTUnwrap(MenuBarTheme.vault(tokens: Self.vaultDark, mode: "dark"))
        XCTAssertTrue(dark.isDark)
        XCTAssertFalse(dark.translucent)
        XCTAssertFalse(try XCTUnwrap(MenuBarTheme.vault(tokens: Self.vaultLight, mode: "light")).isDark)
        // One bad token means no vault theme at all, never a half-applied one.
        var broken = Self.vaultDark
        broken["accent"] = "rgb(88 209 235)"
        XCTAssertNil(MenuBarTheme.vault(tokens: broken, mode: "dark"))
        broken = Self.vaultDark
        broken.removeValue(forKey: "bg-elevated")
        XCTAssertNil(MenuBarTheme.vault(tokens: broken, mode: "dark"))
    }

    func testVaultFaceWeightsRoundLikeCSS() {
        // Regular + Bold only: medium must land on Regular, as the dashboard's does.
        XCTAssertEqual(MenuBarTheme.cssWeight(.medium), .regular)
        XCTAssertEqual(MenuBarTheme.cssWeight(.regular), .regular)
        XCTAssertEqual(MenuBarTheme.cssWeight(.semibold), .bold)
        XCTAssertEqual(MenuBarTheme.cssWeight(.heavy), .bold)
    }

    func testFontStackResolvesToAnInstalledFamilyOrTheSystemFont() {
        XCTAssertNil(MenuBarTheme.installedFamily(from: "ui-sans-serif, \"JetBrains Mono\""))
        XCTAssertNil(MenuBarTheme.installedFamily(from: "\"No Such Face 9\", -apple-system"))
        XCTAssertNil(MenuBarTheme.installedFamily(from: nil))
    }

    func testRenderPopoverStates() throws {
        guard let dir = ProcessInfo.processInfo.environment["MC_RENDER_DIR"] else {
            throw XCTSkip("Set MC_RENDER_DIR to render the menu bar popover")
        }
        let out = URL(fileURLWithPath: dir, isDirectory: true)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let now = Date()
        let vaultDark = try XCTUnwrap(MenuBarTheme.vault(tokens: Self.vaultDark, mode: "dark"))
        let vaultLight = try XCTUnwrap(MenuBarTheme.vault(tokens: Self.vaultLight, mode: "light"))
        for (name, theme) in [("vault", vaultDark), ("light", vaultLight), ("cx", MenuBarTheme.cx)] {
            try renderStates(theme: theme, suffix: name, out: out, now: now)
        }
    }

    private func renderStates(theme: MenuBarTheme, suffix: String, out: URL, now: Date) throws {
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
            meetingLevels: [], micLevels: [], theme: theme
        )
        try render(MenuBarView(sessionManager: idle, feed: idleFeed, actions: Self.noActions), to: out.appendingPathComponent("idle-\(suffix).png"))

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
            meetingLevels: Self.wave(seed: 1), micLevels: Self.wave(seed: 2, quietTail: true), theme: theme
        )
        try render(MenuBarView(sessionManager: live, feed: liveFeed, actions: Self.noActions), to: out.appendingPathComponent("live-\(suffix).png"))

        // The Ask box's question, answered by the meeting chat.
        let waiting = live.actions
        live.actions = []
        let asked = "What did Rory say about the rollout date?"
        live.menubarChat.asked(asked)
        _ = live.menubarChat.receive(ChatReply(id: "q1", role: "user", content: asked, origin: "menubar", state: "done", error: nil))
        _ = live.menubarChat.receive(ChatReply(id: "a1", role: "assistant", content: "", origin: "menubar", state: "streaming", error: nil))
        _ = live.menubarChat.receive(ChatReply(
            id: "a1", role: "assistant",
            content: "He didn't give one. At **[12:05]** Rory said the pilot scope is agreed, but nobody owns the rollout date yet.\n\n- Ask him to name an owner before the end.",
            origin: "menubar", state: "done", error: nil
        ))
        try render(MenuBarView(sessionManager: live, feed: liveFeed, actions: Self.noActions), to: out.appendingPathComponent("live-ask-\(suffix).png"))
        live.menubarChat = MenubarChat()
        live.actions = waiting

        // Live with the capture watchdog's silence warning.
        live.captureWarning = "No meeting audio for 25 s. Check System Settings → Privacy & Security → System Audio Recording."
        live.latestPulse = nil
        live.actions = []
        liveFeed.loadPreview(sessions: [], next: nil,
                             meetingLevels: [Float](repeating: 0, count: MenuBarFeed.historyBars),
                             micLevels: Self.wave(seed: 3), theme: theme)
        try render(MenuBarView(sessionManager: live, feed: liveFeed, actions: Self.noActions), to: out.appendingPathComponent("live-silent-\(suffix).png"))

        // First start on a new Mac: Parakeet's model still downloading.
        let setup = SessionManager()
        setup.serverReady = true
        setup.processSupervisor.transcriptionSetup =
            "Downloading the speech model: 42% of 2.5 GB. First start only; transcription starts when it's ready."
        let setupFeed = MenuBarFeed()
        setupFeed.loadPreview(sessions: [], next: nil, meetingLevels: [], micLevels: [], theme: theme)
        try render(MenuBarView(sessionManager: setup, feed: setupFeed, actions: Self.noActions), to: out.appendingPathComponent("idle-setup-\(suffix).png"))
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
        togglePanel: {}, openChat: {}, openSettings: {}, openNotesFolder: {}, quit: {}
    )
}
