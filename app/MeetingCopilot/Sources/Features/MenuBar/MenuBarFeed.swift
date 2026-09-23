import AppKit
import Foundation
import Observation

// MARK: - Wire Models

/// One past meeting, as `GET /present/sessions` lists it.
struct RecentSession: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let startedAt: Date?
    let endedAt: Date?
    let actionCount: Int?
    let segmentCount: Int?
    let empty: Bool?
}

/// One invite from cxmail, as `GET /calendar/upcoming` returns it.
struct UpcomingMeeting: Decodable, Equatable {
    struct Attendee: Decodable, Equatable {
        let name: String
        let email: String
    }

    let eventUid: String?
    let title: String
    let startsAt: Date
    let endsAt: Date?
    let meetLink: String?
    let attendees: [Attendee]

    /// The key the dashboard's start form matches an invite by
    /// (`m.eventUid || m.title` in present/index.ts).
    var key: String { eventUid ?? title }
}

private struct SessionsEnvelope: Decodable { let sessions: [RecentSession] }
private struct UpcomingEnvelope: Decodable { let meetings: [UpcomingMeeting] }

/// `GET /present/vault-look` — the dashboard's look, as data (`tokens`).
private struct VaultLookEnvelope: Codable {
    let enabled: Bool
    let mode: String?
    let tokens: [String: String]?
}

// MARK: - Menu Bar Feed

/// What the menu bar popover shows beyond SessionManager's own state: the
/// recent sessions, the next invite, and a few seconds of level history per
/// audio track. Fetches only when the popover opens and samples levels only
/// while it is open and recording, so a closed popover costs nothing.
@Observable
@MainActor
final class MenuBarFeed {
    /// 9 seconds of history at 4 Hz.
    static let historyBars = 36
    private static let levelInterval: TimeInterval = 0.25

    private(set) var recentSessions: [RecentSession] = []
    private(set) var nextMeeting: UpcomingMeeting?
    /// The invite the live meeting was started from, matched by title — gives
    /// "min left" before the first pulse carries it.
    private(set) var liveInviteEndsAt: Date?
    /// Normalised 0…1 (−60 dBFS…0), oldest first.
    private(set) var meetingLevels = [Float](repeating: 0, count: historyBars)
    private(set) var micLevels = [Float](repeating: 0, count: historyBars)
    /// The popover's palette: the vault's while "Match vault appearance" is
    /// on (the same switch as the dashboard), else CXNotes'.
    private(set) var theme: MenuBarTheme = MenuBarFeed.lastTheme()

    private static let lookDefaultsKey = "menuBarVaultLook"

    private var isVisible = false
    private var levelTimer: Timer?

    // MARK: Visibility

    func setVisible(_ visible: Bool, session: SessionManager) {
        guard visible != isVisible else { return }
        isVisible = visible
        if visible {
            Task { await refresh(liveTitle: session.isRecording ? session.meetingTitle : nil) }
        }
        updateLevelSampling(session: session)
    }

    /// Start or stop the level bars to match "open and recording".
    func updateLevelSampling(session: SessionManager) {
        if isVisible && session.isRecording {
            startLevels(from: session.audioCaptureManager.levelMeter)
        } else {
            stopLevels()
        }
        if !session.isRecording { liveInviteEndsAt = nil }
    }

    // MARK: Fetch

    func refresh(liveTitle: String?) async {
        async let sessions = Self.fetch("/present/sessions", as: SessionsEnvelope.self)
        async let upcoming = Self.fetch("/calendar/upcoming", as: UpcomingEnvelope.self)
        async let look = Self.fetch("/present/vault-look", as: VaultLookEnvelope.self)

        // No answer keeps the current look: the server restarting must not
        // repaint the popover, the same rule the dashboard follows.
        if let look = await look { wear(look) }

        if let sessions = await sessions {
            recentSessions = Array(sessions.sessions.filter { $0.empty != true }.prefix(4))
        }
        if let meetings = await upcoming?.meetings {
            let now = Date()
            nextMeeting = meetings.first { ($0.endsAt ?? $0.startsAt.addingTimeInterval(3600)) > now }
            if let liveTitle, let match = meetings.first(where: { $0.title == liveTitle }) {
                liveInviteEndsAt = match.endsAt
            }
        }
    }

    /// Both endpoints degrade to "nothing to show" — the popover must never
    /// depend on the server being up.
    private nonisolated static func fetch<T: Decodable>(_ path: String, as type: T.Type) async -> T? {
        var request = URLRequest(url: ServerConfig.url(path))
        request.timeoutInterval = 3
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder.copilotDecoder.decode(T.self, from: data)
    }

    // MARK: Look

    private func wear(_ look: VaultLookEnvelope) {
        if look.enabled, let mode = look.mode, let tokens = look.tokens,
           let vault = MenuBarTheme.vault(tokens: tokens, mode: mode) {
            theme = vault
            if let data = try? JSONEncoder().encode(look) {
                UserDefaults.standard.set(data, forKey: Self.lookDefaultsKey)
            }
        } else {
            theme = .cx
            UserDefaults.standard.removeObject(forKey: Self.lookDefaultsKey)
        }
    }

    /// The look the popover last wore, so the first open after a launch
    /// doesn't flash CXNotes' colours before the fetch lands.
    private static func lastTheme() -> MenuBarTheme {
        guard let data = UserDefaults.standard.data(forKey: lookDefaultsKey),
              let look = try? JSONDecoder().decode(VaultLookEnvelope.self, from: data),
              let mode = look.mode, let tokens = look.tokens,
              let vault = MenuBarTheme.vault(tokens: tokens, mode: mode) else { return .cx }
        return vault
    }

    // MARK: Levels

    private func startLevels(from meter: LevelMeter) {
        guard levelTimer == nil else { return }
        _ = meter.drain() // the peak that built up while closed isn't "now"
        meetingLevels = [Float](repeating: 0, count: Self.historyBars)
        micLevels = [Float](repeating: 0, count: Self.historyBars)
        let timer = Timer(timeInterval: Self.levelInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.push(meter.drain())
            }
        }
        // .common keeps the bars moving while a control in the popover is
        // being clicked (event-tracking run-loop mode).
        RunLoop.main.add(timer, forMode: .common)
        levelTimer = timer
    }

    private func stopLevels() {
        levelTimer?.invalidate()
        levelTimer = nil
    }

    private func push(_ peaks: (mic: Float, meeting: Float)) {
        meetingLevels.append(Self.normalise(peaks.meeting))
        meetingLevels.removeFirst(meetingLevels.count - Self.historyBars)
        micLevels.append(Self.normalise(peaks.mic))
        micLevels.removeFirst(micLevels.count - Self.historyBars)
    }

    /// Linear peak → 0…1 on a −60 dB floor. Speech peaks sit around −30…−6 dB,
    /// so a linear scale would leave every bar a sliver.
    static func normalise(_ peak: Float) -> Float {
        guard peak > 0 else { return 0 }
        let db = 20 * log10(min(peak, 1))
        return max(0, min(1, (db + 60) / 60))
    }

    /// A track counts as live when it carried signal (above about −48 dB) in
    /// the last two seconds.
    static func isLive(_ levels: [Float]) -> Bool {
        levels.suffix(8).contains { $0 > 0.2 }
    }

    #if DEBUG
    /// Fixture seam for MenuBarRenderTests — never compiled into a release.
    func loadPreview(sessions: [RecentSession], next: UpcomingMeeting?, inviteEndsAt: Date? = nil,
                     meetingLevels: [Float], micLevels: [Float], theme: MenuBarTheme = .cx) {
        self.theme = theme
        recentSessions = sessions
        nextMeeting = next
        liveInviteEndsAt = inviteEndsAt
        self.meetingLevels = meetingLevels
        self.micLevels = micLevels
    }
    #endif
}
