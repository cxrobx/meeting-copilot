import SwiftUI
import AppKit

// MARK: - Actions

/// Everything the popover can ask the app to do. Built by MeetingCopilotApp
/// from AppDelegate, so the view never reaches for the panel or NSWorkspace.
struct MenuBarActions {
    var startSession: () -> Void
    var setUpInvite: (_ key: String) -> Void
    var openSession: (_ id: String) -> Void
    var openHistory: () -> Void
    var togglePanel: () -> Void
    /// Front the panel with its Chat drawer open.
    var openChat: () -> Void
    var openSettings: () -> Void
    var checkForUpdates: () -> Void
    var openNotesFolder: () -> Void
    var quit: () -> Void
}

// MARK: - Menu Bar View

/// The menu bar popover, in the shape of CXNotes' panel: a chrome header, a
/// body and a labelled footer. Idle shows the record button, the next invite
/// and recent sessions; a live meeting shows the recording card (timer, track
/// levels, stop), the pulse, pending suggestions and an Ask box. It wears the
/// dashboard's look — the Obsidian vault's palette while "Match vault
/// appearance" is on (`MenuBarTheme`). Everything shown is real state.
struct MenuBarView: View {
    let sessionManager: SessionManager
    let feed: MenuBarFeed
    let actions: MenuBarActions

    @Environment(\.dismiss) private var dismiss

    private var theme: MenuBarTheme { feed.theme }

    private var inMeeting: Bool {
        switch sessionManager.state {
        case .priming, .live, .degraded, .ending: return true
        case .idle, .archived, .error: return false
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            VStack(alignment: .leading, spacing: 14) {
                if let setup = sessionManager.processSupervisor.transcriptionSetup {
                    TranscriptionSetupCard(text: setup)
                }
                if inMeeting {
                    LiveSection(sessionManager: sessionManager, feed: feed, actions: actions, close: { dismiss() })
                } else {
                    IdleSection(sessionManager: sessionManager, feed: feed, actions: actions, close: { dismiss() })
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.groundFill)
            footer
        }
        .frame(width: 360)
        .foregroundStyle(theme.textPrimary)
        .tint(theme.accent)
        .environment(\.menuBarTheme, theme)
        .environment(\.colorScheme, theme.isDark ? .dark : .light)
        .background {
            // Zero-sized: it only needs a window to listen to, not a frame.
            PopoverWindowObserver(dark: theme.isDark) { visible in
                feed.setVisible(visible, session: sessionManager)
            }
            .frame(width: 0, height: 0)
        }
        .onChange(of: sessionManager.isRecording) {
            feed.updateLevelSampling(session: sessionManager)
        }
        .onChange(of: sessionManager.audioCheck.isRunning) {
            feed.updateLevelSampling(session: sessionManager)
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            Image(nsImage: AppIconProvider.icon)
                .resizable()
                .interpolation(.high)
                .frame(width: 24, height: 24)
            Text("Meeting Copilot")
                .font(theme.font(12.5, .semibold))
            Spacer()
            HStack(spacing: 5) {
                StatusDot(kind: headerStatus.kind)
                Text(headerStatus.label)
                    .font(theme.font(11))
                    .foregroundStyle(theme.textMuted)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 11)
        .padding(.bottom, 10)
        .background(theme.chromeFill)
        .overlay(alignment: .bottom) { Hairline() }
    }

    private var headerStatus: (kind: StatusDot.Kind, label: String) {
        if sessionManager.serverStartFailed { return (.bad, "Server down") }
        if sessionManager.isPaused, sessionManager.state == .live || sessionManager.state == .degraded {
            return (.warn, "Paused")
        }
        switch sessionManager.state {
        case .priming:  return (.warn, "Starting…")
        case .live:     return (.recording, "Recording")
        case .degraded: return (.warn, "Degraded")
        case .ending:   return (.warn, "Wrapping up")
        case .error:    return (.bad, "Error")
        case .idle, .archived:
            return sessionManager.serverReady ? (.ok, "Ready") : (.warn, "Starting server…")
        }
    }

    // MARK: Footer

    /// Labelled, not icon-only: four bare glyphs left their jobs to guesswork.
    private var footer: some View {
        HStack(spacing: 2) {
            FooterButton(systemName: "rectangle.on.rectangle", label: "Panel", hint: "⌘⇧M",
                         help: "Show or hide the Copilot window") {
                dismiss(); actions.togglePanel()
            }
            FooterButton(systemName: "doc.text", label: "Notes",
                         help: "Open CX/Meetings, where meeting summaries are filed") {
                dismiss(); actions.openNotesFolder()
            }
            FooterButton(systemName: "gearshape", label: "Settings",
                         help: "Open the dashboard's settings") {
                dismiss(); actions.openSettings()
            }
            FooterButton(systemName: "arrow.down.circle", label: "Updates",
                         help: "Check for a newer Meeting Copilot") {
                dismiss(); actions.checkForUpdates()
            }
            Spacer(minLength: 4)
            FooterButton(systemName: "power", label: "Quit", help: "Quit Meeting Copilot") {
                actions.quit()
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 6)
        .padding(.bottom, 7)
        .background(theme.chromeFill)
        .overlay(alignment: .top) { Hairline() }
    }
}

// MARK: - Idle

private struct IdleSection: View {
    let sessionManager: SessionManager
    let feed: MenuBarFeed
    let actions: MenuBarActions
    let close: () -> Void

    var body: some View {
        if sessionManager.serverStartFailed {
            ServerFailedCard(sessionManager: sessionManager)
        }

        RecButton(
            caption: sessionManager.serverReady ? "Start session" : "Starting server…",
            enabled: sessionManager.serverReady
        ) {
            close(); actions.startSession()
        }

        AudioCheckCard(check: sessionManager.audioCheck, feed: feed)

        if let meeting = feed.nextMeeting {
            NextMeetingCard(meeting: meeting, enabled: sessionManager.serverReady) {
                close(); actions.setUpInvite(meeting.key)
            }
        }

        VStack(alignment: .leading, spacing: 4) {
            SectionHeader(title: "Recent sessions") {
                if !feed.recentSessions.isEmpty {
                    ChipButton(text: "all", help: "All past sessions") { close(); actions.openHistory() }
                }
            }
            if feed.recentSessions.isEmpty {
                EmptyLine(text: sessionManager.serverReady ? "No meetings recorded yet" : "Loads once the server is up")
            } else {
                VStack(spacing: 0) {
                    ForEach(feed.recentSessions) { session in
                        SessionRow(session: session) {
                            close(); actions.openSession(session.id)
                        }
                    }
                }
            }
        }
    }
}

/// "Test audio": both tracks for a few seconds with no session (AudioCheck).
private struct AudioCheckCard: View {
    let check: AudioCheck
    let feed: MenuBarFeed
    @Environment(\.menuBarTheme) private var theme

    var body: some View {
        switch check.phase {
        case .idle:
            HStack(spacing: 8) {
                Text("Check both tracks before a meeting")
                    .font(theme.font(11))
                    .foregroundStyle(theme.textMuted)
                Spacer()
                Button("Test audio") { check.start() }
                    .buttonStyle(PillButtonStyle(kind: .normal, small: true))
                    .help("Listen to your mic and the meeting audio for a few seconds. Nothing is recorded or sent.")
            }
        case .running(let heardMic, let heardMeeting):
            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Text("Testing audio… say a few words")
                        .font(theme.font(11.5, .semibold))
                    Spacer()
                    Button("Cancel") { Task { await check.cancel() } }
                        .buttonStyle(PillButtonStyle(kind: .normal, small: true))
                }
                TrackRow(name: "Meeting", levels: feed.meetingLevels, color: theme.accent)
                TrackRow(name: "You", levels: feed.micLevels, color: theme.success)
                Text("\(heardMic ? "You ✓" : "You …")   \(heardMeeting ? "Meeting ✓" : "Meeting …")")
                    .font(theme.font(11, .semibold))
                Text("Nothing is recorded or sent. A faint test tone plays so the meeting track has something to hear.")
                    .font(theme.font(10.5))
                    .foregroundStyle(theme.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .modifier(CardStyle(border: theme.borderSubtle))
        case .done(let outcome):
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(outcome.passed ? "✓ Both tracks heard" : "Audio check found a problem")
                        .font(theme.font(11.5, .semibold))
                        .foregroundStyle(outcome.passed ? theme.success : theme.warning)
                    Spacer()
                    ChipButton(text: "again", help: "Run the check again") { check.start() }
                    ChipButton(text: "×", help: "Dismiss") { check.dismissResult() }
                }
                if outcome.error == nil {
                    Text("You: \(Self.word(outcome.mic)) · Meeting: \(Self.word(outcome.meeting))")
                        .font(theme.font(10.5))
                        .foregroundStyle(theme.textMuted)
                }
                ForEach(outcome.advice, id: \.self) { line in
                    Text(line)
                        .font(theme.font(10.5))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .modifier(CardStyle(border: outcome.passed ? theme.success.opacity(0.5) : theme.warning.opacity(0.6)))
        }
    }

    private static func word(_ v: AudioCheck.Verdict) -> String {
        switch v {
        case .heard: return "heard"
        case .zeros: return "silence only"
        case .nothing: return "nothing"
        }
    }
}

private struct ServerFailedCard: View {
    let sessionManager: SessionManager
    @Environment(\.menuBarTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                StatusDot(kind: .bad)
                Text("Server failed to start")
                    .font(theme.font(12, .semibold))
            }
            Text(sessionManager.errorMessage ?? "Check ~/.meeting-copilot/server.log")
                .font(theme.font(11))
                .foregroundStyle(theme.textMuted)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            Button("Retry") {
                // startServer() is a no-op if the process is alive and resets
                // the restart budget after a crash-loop give-up; then re-enter
                // the health poll.
                sessionManager.processSupervisor.startServer()
                sessionManager.retryServerConnection()
            }
            .buttonStyle(PillButtonStyle(kind: .normal, small: true))
        }
        .modifier(CardStyle(border: theme.danger.opacity(0.35)))
    }
}

/// First start on a new Mac: local speech recognition is still downloading
/// (ProcessSupervisor.transcriptionSetup). Shown in both states, since a
/// meeting started now would have no local transcription yet.
private struct TranscriptionSetupCard: View {
    let text: String
    @Environment(\.menuBarTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                StatusDot(kind: .warn)
                Text("Preparing transcription")
                    .font(theme.font(12, .semibold))
            }
            Text(text)
                .font(theme.font(11))
                .foregroundStyle(theme.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .modifier(CardStyle(border: theme.warning.opacity(0.35)))
    }
}

private struct NextMeetingCard: View {
    let meeting: UpcomingMeeting
    let enabled: Bool
    let setUp: () -> Void
    @Environment(\.menuBarTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(MBFormat.meetingTime(meeting.startsAt))
                    .font(theme.font(13, .semibold))
                Text(MBFormat.relativeStart(meeting.startsAt))
                    .font(theme.font(11))
                    .foregroundStyle(theme.accent)
                Spacer()
                SectionEyebrow(text: "Next")
            }
            .padding(.bottom, 3)
            Text(meeting.title)
                .font(theme.font(13, .semibold))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            if !meeting.attendees.isEmpty {
                Text(MBFormat.people(meeting.attendees.map(\.name)))
                    .font(theme.font(11))
                    .foregroundStyle(theme.textMuted)
                    .lineLimit(1)
                    .padding(.top, 2)
            }
            if let link = meeting.meetLink {
                Chip(text: MBFormat.linkLabel(link), kind: .plain)
                    .padding(.top, 8)
            }
            Button("Set up this meeting", action: setUp)
                .buttonStyle(PillButtonStyle(kind: .primary, small: true, fullWidth: true))
                .disabled(!enabled)
                .padding(.top, 10)
        }
        .modifier(CardStyle(border: theme.accent.opacity(0.3), tint: theme.accent.opacity(0.14)))
    }
}

private struct SessionRow: View {
    let session: RecentSession
    let open: () -> Void
    @Environment(\.menuBarTheme) private var theme
    @State private var hover = false

    var body: some View {
        Button(action: open) {
            HStack(spacing: 9) {
                StatusDot(kind: .ok)
                VStack(alignment: .leading, spacing: 1) {
                    Text(session.title)
                        .font(theme.font(12, .medium))
                        .lineLimit(1)
                    Text(MBFormat.sessionMeta(session))
                        .font(theme.font(10.5))
                        .foregroundStyle(theme.textSubtle)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(theme.textSubtle)
                    .opacity(hover ? 1 : 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(hover ? theme.hoverWash : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, -8)
        .onHover { hover = $0 }
        .help("Open this session in the panel")
    }
}

// MARK: - Live

private struct LiveSection: View {
    let sessionManager: SessionManager
    let feed: MenuBarFeed
    let actions: MenuBarActions
    let close: () -> Void

    var body: some View {
        RecordingCard(sessionManager: sessionManager, feed: feed, actions: actions, close: close)
        if sessionManager.state != .priming {
            PulseSection(sessionManager: sessionManager)
            CopilotSection(sessionManager: sessionManager, actions: actions, close: close)
            if sessionManager.state == .live || sessionManager.state == .degraded {
                AskSection(sessionManager: sessionManager, actions: actions)
            }
        }
    }
}

private struct RecordingCard: View {
    let sessionManager: SessionManager
    let feed: MenuBarFeed
    let actions: MenuBarActions
    let close: () -> Void
    @Environment(\.menuBarTheme) private var theme

    private var state: SessionState { sessionManager.state }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 9) {
                stateLabel
                Spacer()
                Text(MBFormat.elapsed(sessionManager.sessionElapsedTime))
                    .font(theme.mono(22, .semibold))
                    .monospacedDigit()
                    .foregroundStyle(state == .ending ? theme.textMuted : theme.textPrimary)
            }
            .padding(.bottom, 6)

            Text(sessionManager.currentSession?.title ?? "Starting…")
                .font(theme.font(13, .semibold))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            if let who = whoLine {
                Text(who)
                    .font(theme.font(11))
                    .foregroundStyle(theme.textMuted)
                    .lineLimit(1)
                    .padding(.top, 2)
            }

            if state == .priming {
                HStack(spacing: 7) {
                    ProgressView().controlSize(.small)
                    Text("Acquiring audio…")
                        .font(theme.font(11))
                        .foregroundStyle(theme.textMuted)
                }
                .padding(.top, 10)
            } else {
                VStack(spacing: 7) {
                    TrackRow(name: "Meeting", levels: feed.meetingLevels, color: theme.accent)
                    TrackRow(name: "You", levels: feed.micLevels, color: theme.success)
                }
                .padding(.vertical, 10)

                if sessionManager.isPaused {
                    // Chosen, not a fault: a plain note, not the warning box.
                    Text("Nothing is being recorded or sent until you resume.")
                        .font(theme.font(11))
                        .foregroundStyle(theme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, 10)
                } else if let warning = sessionManager.captureWarning {
                    WarningBox(title: "A track has gone silent", detail: warning)
                        .padding(.bottom, 10)
                }
                if state == .degraded, !sessionManager.degradedReasons.isEmpty {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 10))
                        Text(sessionManager.degradedReasons.joined(separator: " · ") + " — audio is buffered locally")
                            .font(theme.font(11))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .foregroundStyle(theme.warning)
                    .padding(.bottom, 10)
                }

                if state == .ending {
                    HStack(spacing: 7) {
                        ProgressView().controlSize(.small)
                        Text(endingText)
                            .font(theme.font(11))
                            .foregroundStyle(theme.textMuted)
                    }
                } else {
                    HStack(spacing: 6) {
                        Button(sessionManager.isPaused ? "Resume" : "Pause") { sessionManager.togglePause() }
                            .buttonStyle(PillButtonStyle(kind: sessionManager.isPaused ? .primary : .normal))
                            .help(sessionManager.isPaused ? "Resume recording" : "Pause: nothing is recorded or sent until you resume")
                        Button("Stop session") { sessionManager.stopSession() }
                            .buttonStyle(PillButtonStyle(kind: .danger, fullWidth: true))
                        Button("Panel") { close(); actions.togglePanel() }
                            .buttonStyle(PillButtonStyle(kind: .normal))
                            .help("Show or hide the Copilot window  ⌘⇧M")
                    }
                }
            }
        }
        .modifier(CardStyle(border: cardColor.opacity(0.4), tint: cardColor.opacity(0.15)))
    }

    private var cardColor: Color { sessionManager.isPaused ? theme.warning : theme.danger }

    @ViewBuilder
    private var stateLabel: some View {
        switch state {
        case .live where sessionManager.isPaused, .degraded where sessionManager.isPaused:
            RecLabel(text: "PAUSED", color: theme.warning, pulsing: false)
        case .live:
            RecLabel(text: "REC", color: theme.danger, pulsing: true)
        case .degraded:
            RecLabel(text: "REC · DEGRADED", color: theme.warning, pulsing: true)
        case .priming:
            RecLabel(text: "STARTING", color: theme.textMuted, pulsing: false)
        default:
            RecLabel(text: "WRAPPING UP", color: theme.textMuted, pulsing: false)
        }
    }

    private var endingText: String {
        let running = sessionManager.runningActions.count
        return running == 0 ? "Saving the session…" : "Finishing \(running) running action\(running == 1 ? "" : "s")…"
    }

    /// Attendees, then time left: from the latest pulse (the server's own
    /// count from the invite), else from the invite matched by title.
    private var whoLine: String? {
        let people = sessionManager.meetingAttendees
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        var parts: [String] = []
        if !people.isEmpty { parts.append(MBFormat.people(people)) }
        if let left = minutesLeft { parts.append(MBFormat.minutesLeft(left)) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var minutesLeft: Double? {
        let now = Date()
        if let pulse = sessionManager.latestPulse, let left = pulse.minutesLeft {
            return left - now.timeIntervalSince(pulse.createdAt) / 60
        }
        if let end = feed.liveInviteEndsAt {
            return end.timeIntervalSince(now) / 60
        }
        return nil
    }
}

private struct TrackRow: View {
    let name: String
    let levels: [Float]
    let color: Color
    @Environment(\.menuBarTheme) private var theme

    var body: some View {
        let live = MenuBarFeed.isLive(levels)
        HStack(spacing: 9) {
            Text(name)
                .font(theme.font(10.5))
                .foregroundStyle(theme.textMuted)
                .frame(width: 52, alignment: .leading)
            LevelBars(levels: levels, color: color)
            Chip(text: live ? "live" : "quiet", kind: live ? .ok : .plain)
                .frame(width: 46, alignment: .trailing)
        }
    }
}

private struct LevelBars: View {
    let levels: [Float]
    let color: Color

    var body: some View {
        GeometryReader { geo in
            HStack(alignment: .bottom, spacing: 1.5) {
                ForEach(levels.indices, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(color)
                        .frame(height: max(geo.size.height * 0.06, geo.size.height * CGFloat(levels[i])))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .bottom)
            .animation(.linear(duration: 0.12), value: levels)
        }
        .frame(height: 22)
    }
}

private struct PulseSection: View {
    let sessionManager: SessionManager
    @Environment(\.menuBarTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            SectionHeader(title: "Pulse") {
                if let pulse = sessionManager.latestPulse {
                    Chip(text: Self.label(pulse.status), kind: Self.kind(pulse.status))
                }
            }
            if let pulse = sessionManager.latestPulse {
                Text(pulse.read)
                    .font(theme.font(11.5))
                    .foregroundStyle(theme.textSecondary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                if let escalation = pulse.escalations.first {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(theme.warning)
                        Text(escalation.text)
                            .font(theme.font(11.5, .medium))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else {
                EmptyLine(text: sessionManager.sessionElapsedTime < 300
                    ? "First read about 5 minutes in"
                    : "Waiting for enough new talk for a read")
            }
        }
    }

    private static func label(_ status: MeetingPulse.Status) -> String {
        switch status {
        case .onTrack:  return "on track"
        case .drifting: return "drifting"
        case .stuck:    return "stuck"
        }
    }

    private static func kind(_ status: MeetingPulse.Status) -> Chip.Kind {
        switch status {
        case .onTrack:  return .ok
        case .drifting: return .warn
        case .stuck:    return .bad
        }
    }
}

private struct CopilotSection: View {
    let sessionManager: SessionManager
    let actions: MenuBarActions
    let close: () -> Void
    @Environment(\.menuBarTheme) private var theme

    private static let shown = 2

    var body: some View {
        let waiting = Array(sessionManager.suggestedActions.reversed())
        let running = sessionManager.runningActions
        VStack(alignment: .leading, spacing: 6) {
            SectionHeader(title: "Copilot") {
                if !waiting.isEmpty {
                    Chip(text: "\(waiting.count) waiting", kind: .accent)
                }
            }
            if waiting.isEmpty && running.isEmpty {
                EmptyLine(text: "Listening — suggestions show up here")
            }
            ForEach(waiting.prefix(Self.shown)) { action in
                SuggestionRow(
                    action: action,
                    approve: { sessionManager.approveAction(id: action.id) },
                    dismiss: { sessionManager.dismissAction(id: action.id) }
                )
            }
            if waiting.count > Self.shown {
                Button("+\(waiting.count - Self.shown) more in the panel") {
                    close(); actions.togglePanel()
                }
                .buttonStyle(.plain)
                .font(theme.font(11, .medium))
                .foregroundStyle(theme.accent)
            }
            ForEach(running.prefix(Self.shown)) { action in
                HStack(spacing: 8) {
                    ProgressView().controlSize(.mini)
                        .frame(width: 14)
                    Text(action.title)
                        .font(theme.font(11.5))
                        .foregroundStyle(theme.textSecondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(action.state == .running ? "running" : "queued")
                        .font(theme.font(10.5))
                        .foregroundStyle(theme.textSubtle)
                }
            }
        }
    }
}

private struct SuggestionRow: View {
    let action: ActionSuggestion
    let approve: () -> Void
    let dismiss: () -> Void
    @Environment(\.menuBarTheme) private var theme

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: action.type.icon)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(theme.accent)
                .frame(width: 16, height: 16)
            VStack(alignment: .leading, spacing: 6) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(action.title)
                        .font(theme.font(12, .medium))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(action.type.displayName)
                        .font(theme.font(10.5))
                        .foregroundStyle(theme.textSubtle)
                }
                HStack(spacing: 6) {
                    Button("Approve", action: approve)
                        .buttonStyle(PillButtonStyle(kind: .primary, small: true))
                    Button("Dismiss", action: dismiss)
                        .buttonStyle(PillButtonStyle(kind: .normal, small: true))
                }
            }
            Spacer(minLength: 0)
        }
        .modifier(CardStyle(border: theme.borderSubtle, padding: 10))
    }
}

private struct AskSection: View {
    let sessionManager: SessionManager
    let actions: MenuBarActions
    @Environment(\.menuBarTheme) private var theme

    private enum Status: Equatable { case idle, sending, sent, failed }

    @State private var question = ""
    @State private var status: Status = .idle
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionHeader(title: "Ask") {
                Chip(text: "meeting chat", kind: .plain)
                    .help("Answers from the whole meeting, and searches the web when it needs to. The thread is in the panel's Chat (⌘J).")
            }
            HStack(spacing: 6) {
                TextField("Ask the copilot…", text: $question)
                    .textFieldStyle(.plain)
                    .font(theme.font(12))
                    .focused($focused)
                    .onSubmit(send)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(theme.input))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(focused ? theme.accent.opacity(0.5) : theme.border)
                    )
                Button("Go", action: send)
                    .buttonStyle(PillButtonStyle(kind: .normal, small: true))
                    .disabled(trimmed.isEmpty || status == .sending)
            }
            if status == .failed {
                Text("Not connected — couldn't ask. Try again in a moment.")
                    .font(theme.font(10.5))
                    .foregroundStyle(theme.danger)
            } else if sessionManager.menubarQuestion != nil {
                // From the session, not this view's state: the answer is still
                // here when the popover is opened again.
                answer
            }
        }
    }

    private var trimmed: String { question.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The chat's answer to the last question, as it arrives.
    @ViewBuilder private var answer: some View {
        let reply = sessionManager.menubarAnswer
        VStack(alignment: .leading, spacing: 6) {
            if let asked = sessionManager.menubarQuestion {
                Text(asked)
                    .font(theme.font(10.5, .medium))
                    .foregroundStyle(theme.textSubtle)
                    .lineLimit(2)
            }
            if let reply, reply.isFinished {
                if reply.state == "done" {
                    Text(reply.plainContent)
                        .font(theme.font(11.5))
                        .foregroundStyle(theme.textSecondary)
                        .lineLimit(9)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                } else {
                    Text(reply.state == "cancelled" ? "Stopped." : "The chat didn't answer: \(reply.error ?? "unknown error")")
                        .font(theme.font(10.5))
                        .foregroundStyle(theme.danger)
                }
                Button("Open in Chat", action: actions.openChat)
                    .buttonStyle(PillButtonStyle(kind: .normal, small: true))
                    .help("The whole thread, in the panel's Chat drawer")
            } else {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Reading the meeting…")
                        .font(theme.font(10.5))
                        .foregroundStyle(theme.textSubtle)
                }
            }
        }
        .modifier(CardStyle(border: theme.borderSubtle, padding: 10))
    }

    private func send() {
        guard !trimmed.isEmpty, status != .sending else { return }
        let text = trimmed
        status = .sending
        Task {
            let ok = await sessionManager.askCopilot(text)
            status = ok ? .sent : .failed
            // Keep the text on failure so it can be retried without retyping.
            if ok { question = "" }
        }
    }
}

// MARK: - Record Button

/// CXNotes' viewfinder record button: four corner brackets, a red disc and
/// the REC wordmark — an instrument aimed at the meeting rather than another
/// filled button.
private struct RecButton: View {
    let caption: String
    let enabled: Bool
    let action: () -> Void
    @Environment(\.menuBarTheme) private var theme
    @State private var hover = false

    var body: some View {
        let lit = hover && enabled
        Button(action: action) {
            VStack(spacing: 2) {
                HStack(spacing: 9) {
                    Circle()
                        .fill(theme.record)
                        .frame(width: 12, height: 12)
                        .overlay(Circle().strokeBorder(Color.white.opacity(0.22), lineWidth: 0.5))
                        .shadow(color: theme.record.opacity(lit ? 0.9 : 0.55), radius: lit ? 9 : 6)
                    Text("REC")
                        .font(theme.font(16, .heavy))
                        .tracking(0.96)
                }
                Text(caption.uppercased())
                    .font(theme.font(9.5, .semibold))
                    .tracking(0.76)
                    .foregroundStyle(lit ? theme.textSecondary : theme.textMuted)
            }
            .frame(maxWidth: .infinity, minHeight: 46)
            .padding(.top, 8)
            .padding(.bottom, 9)
            .background {
                ZStack {
                    // Glass under CX; a flat well under the vault.
                    theme.card.opacity(theme.translucent ? (lit ? 0.34 : 0.2) : 1)
                    if lit {
                        RadialGradient(
                            colors: [theme.record.opacity(0.22), .clear],
                            center: .top, startRadius: 0, endRadius: 190
                        )
                    }
                }
            }
            .overlay {
                ViewfinderBrackets(inset: lit ? 4 : 5, arm: 13)
                    .stroke(lit ? theme.record : theme.textPrimary.opacity(0.4),
                            style: StrokeStyle(lineWidth: 2, lineCap: .butt))
            }
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.55)
        .onHover { h in withAnimation(.easeOut(duration: 0.18)) { hover = h } }
    }
}

/// Corner arms, never a closed border — the gap between them is the camera
/// framing, and closing it turns the mark back into an outlined button.
private struct ViewfinderBrackets: Shape {
    var inset: CGFloat
    var arm: CGFloat
    var radius: CGFloat = 5

    var animatableData: CGFloat {
        get { inset }
        set { inset = newValue }
    }

    func path(in rect: CGRect) -> Path {
        // +1: the 2pt stroke is centred on the path, so this lands its outer
        // edge exactly `inset` from the button's edge.
        let r = rect.insetBy(dx: inset + 1, dy: inset + 1)
        var p = Path()
        func corner(_ start: CGPoint, _ vertex: CGPoint, _ end: CGPoint) {
            p.move(to: start)
            p.addArc(tangent1End: vertex, tangent2End: end, radius: radius)
            p.addLine(to: end)
        }
        corner(CGPoint(x: r.minX, y: r.minY + arm), CGPoint(x: r.minX, y: r.minY), CGPoint(x: r.minX + arm, y: r.minY))
        corner(CGPoint(x: r.maxX - arm, y: r.minY), CGPoint(x: r.maxX, y: r.minY), CGPoint(x: r.maxX, y: r.minY + arm))
        corner(CGPoint(x: r.maxX, y: r.maxY - arm), CGPoint(x: r.maxX, y: r.maxY), CGPoint(x: r.maxX - arm, y: r.maxY))
        corner(CGPoint(x: r.minX + arm, y: r.maxY), CGPoint(x: r.minX, y: r.maxY), CGPoint(x: r.minX, y: r.maxY - arm))
        return p
    }
}

// MARK: - Atoms

private struct Hairline: View {
    @Environment(\.menuBarTheme) private var theme

    var body: some View {
        Rectangle().fill(theme.borderSubtle).frame(height: 1)
    }
}

private struct StatusDot: View {
    enum Kind { case ok, warn, bad, recording }
    let kind: Kind
    @Environment(\.menuBarTheme) private var theme

    var body: some View {
        switch kind {
        case .recording:
            Image(systemName: "circle.fill")
                .font(.system(size: 7))
                .foregroundStyle(theme.danger)
                .symbolEffect(.pulse, options: .repeating)
        default:
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
        }
    }

    private var color: Color {
        switch kind {
        case .ok: return theme.success
        case .warn: return theme.warning
        case .bad, .recording: return theme.danger
        }
    }
}

private struct RecLabel: View {
    let text: String
    let color: Color
    let pulsing: Bool
    @Environment(\.menuBarTheme) private var theme

    var body: some View {
        HStack(spacing: 6) {
            if pulsing {
                Image(systemName: "circle.fill")
                    .font(.system(size: 7))
                    .symbolEffect(.pulse, options: .repeating)
            }
            Text(text)
                .font(theme.font(11, .semibold))
                .tracking(0.66)
        }
        .foregroundStyle(color)
    }
}

private struct SectionEyebrow: View {
    let text: String
    @Environment(\.menuBarTheme) private var theme

    var body: some View {
        Text(text.uppercased())
            .font(theme.font(10, .semibold))
            .tracking(1.0)
            .foregroundStyle(theme.textSubtle)
    }
}

private struct SectionHeader<Trailing: View>: View {
    let title: String
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack {
            SectionEyebrow(text: title)
            Spacer()
            trailing()
        }
    }
}

private struct EmptyLine: View {
    let text: String
    @Environment(\.menuBarTheme) private var theme

    var body: some View {
        Text(text)
            .font(theme.font(11.5))
            .foregroundStyle(theme.textSubtle)
            .padding(.top, 2)
    }
}

private struct Chip: View {
    enum Kind { case plain, accent, ok, warn, bad }
    let text: String
    let kind: Kind
    @Environment(\.menuBarTheme) private var theme

    var body: some View {
        Text(text)
            .font(theme.mono(10))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .foregroundStyle(hue ?? theme.textMuted)
            .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(hue?.opacity(0.12) ?? theme.input))
            .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).strokeBorder(hue?.opacity(0.32) ?? theme.border))
    }

    private var hue: Color? {
        switch kind {
        case .plain: return nil
        case .accent: return theme.accent
        case .ok: return theme.success
        case .warn: return theme.warning
        case .bad: return theme.danger
        }
    }
}

private struct ChipButton: View {
    let text: String
    let help: String
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Chip(text: text, kind: hover ? .accent : .plain)
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .help(help)
    }
}

private struct WarningBox: View {
    let title: String
    let detail: String
    @Environment(\.menuBarTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("⚠️ \(title)")
                .font(theme.font(11, .semibold))
                .foregroundStyle(theme.warningBoxTitle)
            Text(detail)
                .font(theme.font(10.5))
                .foregroundStyle(theme.warningBoxText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(theme.warningBoxFill))
        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(theme.warningBoxStroke))
    }
}

private struct FooterButton: View {
    let systemName: String
    let label: String
    var hint: String? = nil
    let help: String
    let action: () -> Void
    @Environment(\.menuBarTheme) private var theme
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: systemName)
                    .font(.system(size: 11))
                Text(label)
                    .font(theme.font(11, .medium))
                if let hint {
                    Text(hint)
                        .font(theme.mono(9.5))
                        .foregroundStyle(theme.textSubtle)
                }
            }
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 5)
            .padding(.vertical, 5)
            .foregroundStyle(hover ? theme.textPrimary : theme.textMuted)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(hover ? theme.hoverWash : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .help(help)
    }
}

private struct PillButtonStyle: ButtonStyle {
    enum Kind { case normal, primary, danger }
    var kind: Kind
    var small = false
    var fullWidth = false

    func makeBody(configuration: Configuration) -> some View {
        PillButton(configuration: configuration, kind: kind, small: small, fullWidth: fullWidth)
    }

    private struct PillButton: View {
        let configuration: ButtonStyleConfiguration
        let kind: Kind
        let small: Bool
        let fullWidth: Bool
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.menuBarTheme) private var theme
        @State private var hover = false

        var body: some View {
            configuration.label
                .font(theme.font(small ? 11 : 12, kind == .normal ? .medium : .semibold))
                .lineLimit(1)
                .padding(.horizontal, small ? 10 : 14)
                .padding(.vertical, small ? 4 : 6)
                .frame(maxWidth: fullWidth ? .infinity : nil)
                .foregroundStyle(foreground)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(fill))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(stroke))
                .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
                .contentShape(Rectangle())
                .onHover { hover = $0 && isEnabled }
        }

        private var foreground: Color {
            switch kind {
            case .normal: return theme.textPrimary
            case .primary: return theme.accentInk
            case .danger: return theme.dangerInk
            }
        }

        private var fill: Color {
            switch kind {
            case .normal: return hover ? theme.buttonFillHover : theme.buttonFill
            case .primary: return hover ? theme.accentHover : theme.accent
            case .danger: return theme.danger.opacity(hover ? 0.88 : 1)
            }
        }

        private var stroke: Color {
            switch kind {
            case .normal: return theme.border
            case .primary, .danger: return fill
            }
        }
    }
}

/// A card lies ON the ground, so it runs denser (and darker) than the ground
/// beneath it — a well cut into the surface, not a second sheet.
private struct CardStyle: ViewModifier {
    let border: Color
    var tint: Color? = nil
    var padding: CGFloat = 12
    @Environment(\.menuBarTheme) private var theme

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, padding)
            .padding(.vertical, padding - 1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(theme.cardFill)
                    .overlay {
                        if let tint {
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(LinearGradient(colors: [tint, tint.opacity(0)], startPoint: .top, endPoint: UnitPoint(x: 0.5, y: 0.7)))
                        }
                    }
            }
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(border))
    }
}

// MARK: - Formatting

enum MBFormat {
    static func elapsed(_ interval: TimeInterval) -> String {
        let total = Int(interval)
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%02d:%02d", m, s)
    }

    /// "Rory, Eli, Dana +3" — attendees are context, not content.
    static func people(_ names: [String], show: Int = 3) -> String {
        let named = names.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let head = named.prefix(show).joined(separator: ", ")
        return named.count > show ? "\(head) +\(named.count - show)" : head
    }

    static func minutesLeft(_ minutes: Double) -> String {
        if minutes >= 0.5 { return "\(Int(minutes.rounded())) min left" }
        if minutes > -0.5 { return "at time" }
        return "\(Int((-minutes).rounded())) min over"
    }

    static func meetingTime(_ date: Date, now: Date = Date()) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        let cal = Calendar.current
        if cal.isDate(date, inSameDayAs: now) { return time }
        if cal.isDateInTomorrow(date) { return "Tomorrow \(time)" }
        return "\(date.formatted(.dateTime.weekday(.abbreviated))) \(time)"
    }

    static func relativeStart(_ date: Date, now: Date = Date()) -> String {
        let minutes = Int((date.timeIntervalSince(now) / 60).rounded())
        if minutes < -1 { return "started \(-minutes) min ago" }
        if minutes <= 1 { return "now" }
        if minutes < 60 { return "in \(minutes) min" }
        let h = minutes / 60, m = minutes % 60
        return m == 0 ? "in \(h)h" : "in \(h)h \(m)m"
    }

    static func linkLabel(_ link: String) -> String {
        let host = URL(string: link)?.host?.lowercased() ?? link.lowercased()
        if host.contains("meet.google") { return "Google Meet" }
        if host.contains("zoom") { return "Zoom" }
        if host.contains("teams") { return "Teams" }
        if host.contains("webex") { return "Webex" }
        return "Call link"
    }

    /// "yesterday · 34 min · 3 actions"
    static func sessionMeta(_ session: RecentSession, now: Date = Date()) -> String {
        var parts: [String] = []
        if let start = session.startedAt {
            parts.append(day(start, now: now))
            if let end = session.endedAt {
                let minutes = max(1, Int((end.timeIntervalSince(start) / 60).rounded()))
                parts.append(minutes >= 60 ? "\(minutes / 60)h \(minutes % 60)m" : "\(minutes) min")
            }
        }
        if let count = session.actionCount, count > 0 {
            parts.append("\(count) action\(count == 1 ? "" : "s")")
        }
        return parts.joined(separator: " · ")
    }

    /// today / yesterday / Fri / Sep 14
    static func day(_ date: Date, now: Date = Date()) -> String {
        let cal = Calendar.current
        if cal.isDate(date, inSameDayAs: now) { return "today" }
        if let yesterday = cal.date(byAdding: .day, value: -1, to: now), cal.isDate(date, inSameDayAs: yesterday) {
            return "yesterday"
        }
        if let days = cal.dateComponents([.day], from: cal.startOfDay(for: date), to: cal.startOfDay(for: now)).day, days < 7 {
            return date.formatted(.dateTime.weekday(.abbreviated))
        }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}

// MARK: - Window Observer

/// Reports when the MenuBarExtra window opens and closes. SwiftUI's
/// onAppear/onDisappear fire only once for a `.window`-style extra, so the
/// feed would never refresh; the window's own occlusion and key notifications
/// are reliable. Also sets the window's appearance to the theme's mode, so
/// its material and native controls match.
private struct PopoverWindowObserver: NSViewRepresentable {
    let dark: Bool
    let onVisibilityChange: (Bool) -> Void

    func makeNSView(context: Context) -> ObserverView {
        let view = ObserverView()
        view.dark = dark
        view.onVisibilityChange = onVisibilityChange
        return view
    }

    func updateNSView(_ nsView: ObserverView, context: Context) {
        nsView.onVisibilityChange = onVisibilityChange
        nsView.dark = dark
    }

    final class ObserverView: NSView {
        var onVisibilityChange: ((Bool) -> Void)?
        var dark = true {
            didSet { applyAppearance() }
        }
        private var tokens: [NSObjectProtocol] = []

        private func applyAppearance() {
            window?.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            tokens.forEach { NotificationCenter.default.removeObserver($0) }
            tokens = []
            guard let window else { return }
            applyAppearance()

            let center = NotificationCenter.default
            let report: (Notification) -> Void = { [weak self, weak window] _ in
                guard let window else { return }
                self?.onVisibilityChange?(window.isVisible && window.occlusionState.contains(.visible))
            }
            tokens.append(center.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main, using: report))
            tokens.append(center.addObserver(forName: NSWindow.didBecomeKeyNotification, object: window, queue: .main, using: report))
            // Not during this view update — mutating observed state here trips
            // SwiftUI's "modifying state during view update".
            DispatchQueue.main.async { [weak self, weak window] in
                guard let window else { return }
                self?.onVisibilityChange?(window.isVisible)
            }
        }

        deinit {
            tokens.forEach { NotificationCenter.default.removeObserver($0) }
        }
    }
}
