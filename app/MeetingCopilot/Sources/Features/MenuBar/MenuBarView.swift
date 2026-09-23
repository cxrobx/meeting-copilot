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
    var openSettings: () -> Void
    var openSessionsFolder: () -> Void
    var openNotesFolder: () -> Void
    var quit: () -> Void
}

// MARK: - Menu Bar View

/// The menu bar popover, in the same shape as CXNotes' panel: a chrome
/// header, a glass body and an icon footer. Idle shows the record button,
/// the next invite and recent sessions; a live meeting shows the recording
/// card (timer, track levels, stop), the pulse, pending suggestions and an
/// Ask box. Everything shown is real app or server state.
struct MenuBarView: View {
    let sessionManager: SessionManager
    let feed: MenuBarFeed
    let actions: MenuBarActions

    @Environment(\.dismiss) private var dismiss

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
                if inMeeting {
                    LiveSection(sessionManager: sessionManager, feed: feed, actions: actions, close: { dismiss() })
                } else {
                    IdleSection(sessionManager: sessionManager, feed: feed, actions: actions, close: { dismiss() })
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(MB.pane.opacity(0.8))
            footer
        }
        .frame(width: 360)
        .foregroundStyle(MB.textPrimary)
        .environment(\.colorScheme, .dark)
        .background {
            // Zero-sized: it only needs a window to listen to, not a frame.
            PopoverWindowObserver { visible in
                feed.setVisible(visible, session: sessionManager)
            }
            .frame(width: 0, height: 0)
        }
        .onChange(of: sessionManager.isRecording) {
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
                .font(.system(size: 12.5, weight: .semibold))
            Spacer()
            HStack(spacing: 5) {
                StatusDot(kind: headerStatus.kind)
                Text(headerStatus.label)
                    .font(.system(size: 11))
                    .foregroundStyle(MB.textMuted)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 11)
        .padding(.bottom, 10)
        .background(MB.chrome.opacity(0.92))
        .overlay(alignment: .bottom) { Hairline() }
    }

    private var headerStatus: (kind: StatusDot.Kind, label: String) {
        if sessionManager.serverStartFailed { return (.bad, "Server down") }
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

    private var footer: some View {
        HStack(spacing: 2) {
            Spacer()
            FooterIcon(systemName: "rectangle.on.rectangle", help: "Toggle panel  ⌘⇧M") {
                dismiss(); actions.togglePanel()
            }
            FooterIcon(systemName: "folder", help: "Open the sessions folder") {
                dismiss(); actions.openSessionsFolder()
            }
            FooterIcon(systemName: "doc.text", help: "Open meeting notes in the vault") {
                dismiss(); actions.openNotesFolder()
            }
            FooterIcon(systemName: "gearshape", help: "Settings") {
                dismiss(); actions.openSettings()
            }
            FooterIcon(systemName: "power", help: "Quit Meeting Copilot") {
                actions.quit()
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 7)
        .padding(.bottom, 8)
        .background(MB.chrome.opacity(0.92))
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

        if let meeting = feed.nextMeeting {
            NextMeetingCard(meeting: meeting, enabled: sessionManager.serverReady) {
                close(); actions.setUpInvite(meeting.key)
            }
        }

        VStack(alignment: .leading, spacing: 4) {
            SectionHeader(title: "Recent sessions") {
                if !feed.recentSessions.isEmpty {
                    ChipButton(text: "all") { close(); actions.openHistory() }
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

private struct ServerFailedCard: View {
    let sessionManager: SessionManager

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                StatusDot(kind: .bad)
                Text("Server failed to start")
                    .font(.system(size: 12, weight: .semibold))
            }
            Text(sessionManager.errorMessage ?? "Check ~/.meeting-copilot/server.log")
                .font(.system(size: 11))
                .foregroundStyle(MB.textMuted)
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
        .cardStyle(border: MB.danger.opacity(0.35))
    }
}

private struct NextMeetingCard: View {
    let meeting: UpcomingMeeting
    let enabled: Bool
    let setUp: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Text(MBFormat.meetingTime(meeting.startsAt))
                    .font(.system(size: 13, weight: .semibold))
                Text(MBFormat.relativeStart(meeting.startsAt))
                    .font(.system(size: 11))
                    .foregroundStyle(MB.accent)
                Spacer()
                SectionEyebrow(text: "Next")
            }
            .padding(.bottom, 3)
            Text(meeting.title)
                .font(.system(size: 13, weight: .semibold))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            if !meeting.attendees.isEmpty {
                Text(MBFormat.people(meeting.attendees.map(\.name)))
                    .font(.system(size: 11))
                    .foregroundStyle(MB.textMuted)
                    .lineLimit(1)
                    .padding(.top, 2)
            }
            if let link = meeting.meetLink {
                HStack(spacing: 5) {
                    Chip(text: MBFormat.linkLabel(link), kind: .plain)
                }
                .padding(.top, 8)
            }
            Button("Set up this meeting", action: setUp)
                .buttonStyle(PillButtonStyle(kind: .primary, small: true, fullWidth: true))
                .disabled(!enabled)
                .padding(.top, 10)
        }
        .cardStyle(
            border: MB.accent.opacity(0.24),
            tint: MB.accent.opacity(0.16)
        )
    }
}

private struct SessionRow: View {
    let session: RecentSession
    let open: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: open) {
            HStack(spacing: 9) {
                StatusDot(kind: .ok)
                VStack(alignment: .leading, spacing: 1) {
                    Text(session.title)
                        .font(.system(size: 12, weight: .medium))
                        .lineLimit(1)
                    Text(MBFormat.sessionMeta(session))
                        .font(.system(size: 10.5))
                        .foregroundStyle(MB.textSubtle)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(MB.textSubtle)
                    .opacity(hover ? 1 : 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.white.opacity(hover ? 0.07 : 0)))
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
                AskSection(sessionManager: sessionManager)
            }
        }
    }
}

private struct RecordingCard: View {
    let sessionManager: SessionManager
    let feed: MenuBarFeed
    let actions: MenuBarActions
    let close: () -> Void

    private var state: SessionState { sessionManager.state }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 9) {
                stateLabel
                Spacer()
                Text(MBFormat.elapsed(sessionManager.sessionElapsedTime))
                    .font(.system(size: 22, weight: .semibold, design: .monospaced))
                    .monospacedDigit()
                    .foregroundStyle(state == .ending ? MB.textMuted : MB.textPrimary)
            }
            .padding(.bottom, 6)

            Text(sessionManager.currentSession?.title ?? "Starting…")
                .font(.system(size: 13, weight: .semibold))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            if let who = whoLine {
                Text(who)
                    .font(.system(size: 11))
                    .foregroundStyle(MB.textMuted)
                    .lineLimit(1)
                    .padding(.top, 2)
            }

            if state == .priming {
                HStack(spacing: 7) {
                    ProgressView().controlSize(.small)
                    Text("Acquiring audio…")
                        .font(.system(size: 11))
                        .foregroundStyle(MB.textMuted)
                }
                .padding(.top, 10)
            } else {
                VStack(spacing: 7) {
                    TrackRow(name: "Meeting", levels: feed.meetingLevels, color: MB.accent)
                    TrackRow(name: "You", levels: feed.micLevels, color: MB.success)
                }
                .padding(.vertical, 10)

                if let warning = sessionManager.captureWarning {
                    WarningBox(title: "A track has gone silent", detail: warning)
                        .padding(.bottom, 10)
                }
                if state == .degraded, !sessionManager.degradedReasons.isEmpty {
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(MB.warning)
                        Text(sessionManager.degradedReasons.joined(separator: " · ") + " — audio is buffered locally")
                            .font(.system(size: 11))
                            .foregroundStyle(MB.warning)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.bottom, 10)
                }

                if state == .ending {
                    HStack(spacing: 7) {
                        ProgressView().controlSize(.small)
                        Text(endingText)
                            .font(.system(size: 11))
                            .foregroundStyle(MB.textMuted)
                    }
                } else {
                    HStack(spacing: 6) {
                        Button("Stop session") { sessionManager.stopSession() }
                            .buttonStyle(PillButtonStyle(kind: .danger, fullWidth: true))
                        Button("Panel") { close(); actions.togglePanel() }
                            .buttonStyle(PillButtonStyle(kind: .normal))
                            .help("Toggle panel  ⌘⇧M")
                    }
                }
            }
        }
        .cardStyle(border: MB.danger.opacity(0.4), tint: MB.danger.opacity(0.17))
    }

    @ViewBuilder
    private var stateLabel: some View {
        switch state {
        case .live:
            RecLabel(text: "REC", color: MB.danger, pulsing: true)
        case .degraded:
            RecLabel(text: "REC · DEGRADED", color: MB.warning, pulsing: true)
        case .priming:
            RecLabel(text: "STARTING", color: MB.textMuted, pulsing: false)
        default:
            RecLabel(text: "WRAPPING UP", color: MB.textMuted, pulsing: false)
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

    var body: some View {
        let live = MenuBarFeed.isLive(levels)
        HStack(spacing: 9) {
            Text(name)
                .font(.system(size: 10.5))
                .foregroundStyle(MB.textMuted)
                .frame(width: 50, alignment: .leading)
            LevelBars(levels: levels, color: color)
            Chip(text: live ? "live" : "quiet", kind: live ? .ok : .plain)
                .frame(width: 44, alignment: .trailing)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            SectionHeader(title: "Pulse") {
                if let pulse = sessionManager.latestPulse {
                    Chip(text: Self.label(pulse.status), kind: Self.kind(pulse.status))
                }
            }
            if let pulse = sessionManager.latestPulse {
                Text(pulse.read)
                    .font(.system(size: 11.5))
                    .foregroundStyle(MB.textSecondary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                if let escalation = pulse.escalations.first {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(MB.warning)
                        Text(escalation.text)
                            .font(.system(size: 11.5, weight: .medium))
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
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(MB.accent)
            }
            ForEach(running.prefix(Self.shown)) { action in
                HStack(spacing: 8) {
                    ProgressView().controlSize(.mini)
                        .frame(width: 14)
                    Text(action.title)
                        .font(.system(size: 11.5))
                        .foregroundStyle(MB.textSecondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(action.state == .running ? "running" : "queued")
                        .font(.system(size: 10.5))
                        .foregroundStyle(MB.textSubtle)
                }
            }
        }
    }
}

private struct SuggestionRow: View {
    let action: ActionSuggestion
    let approve: () -> Void
    let dismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: action.type.icon)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(MB.accent)
                .frame(width: 16, height: 16)
            VStack(alignment: .leading, spacing: 6) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(action.title)
                        .font(.system(size: 12, weight: .medium))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(action.type.displayName)
                        .font(.system(size: 10.5))
                        .foregroundStyle(MB.textSubtle)
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
        .cardStyle(border: MB.borderSubtle, padding: 10)
    }
}

private struct AskSection: View {
    let sessionManager: SessionManager

    private enum Status: Equatable { case idle, sending, sent, failed }

    @State private var question = ""
    @State private var status: Status = .idle
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionHeader(title: "Ask") {
                Chip(text: "⚡ fast", kind: .plain)
                    .help("Quick answer with web search — the dashboard's ⚡ Fast action")
            }
            HStack(spacing: 6) {
                TextField("Ask the copilot…", text: $question)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                    .focused($focused)
                    .onSubmit(send)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(MB.card.opacity(focused ? 0.96 : 0.88))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(focused ? MB.accent.opacity(0.24) : MB.border)
                    )
                Button("Go", action: send)
                    .buttonStyle(PillButtonStyle(kind: .normal, small: true))
                    .disabled(trimmed.isEmpty || status == .sending)
            }
            switch status {
            case .sent:
                Text("Asked — the answer lands in the panel")
                    .font(.system(size: 10.5))
                    .foregroundStyle(MB.textSubtle)
            case .failed:
                Text("Not connected — couldn't ask. Try again in a moment.")
                    .font(.system(size: 10.5))
                    .foregroundStyle(MB.danger)
            case .idle, .sending:
                EmptyView()
            }
        }
    }

    private var trimmed: String { question.trimmingCharacters(in: .whitespacesAndNewlines) }

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
/// the REC wordmark — nearly all glass, so it reads as an instrument aimed at
/// the meeting rather than another filled button.
private struct RecButton: View {
    let caption: String
    let enabled: Bool
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        let lit = hover && enabled
        Button(action: action) {
            VStack(spacing: 2) {
                HStack(spacing: 9) {
                    Circle()
                        .fill(MB.record)
                        .frame(width: 12, height: 12)
                        .overlay(Circle().strokeBorder(Color.white.opacity(0.22), lineWidth: 0.5))
                        .shadow(color: MB.record.opacity(lit ? 0.9 : 0.55), radius: lit ? 9 : 6)
                    Text("REC")
                        .font(.system(size: 16, weight: .heavy))
                        .tracking(0.96)
                }
                Text(caption.uppercased())
                    .font(.system(size: 9.5, weight: .semibold))
                    .tracking(0.76)
                    .foregroundStyle(lit ? MB.textSecondary : MB.textMuted)
            }
            .frame(maxWidth: .infinity, minHeight: 46)
            .padding(.top, 8)
            .padding(.bottom, 9)
            .background {
                ZStack {
                    MB.card.opacity(lit ? 0.34 : 0.2)
                    if lit {
                        RadialGradient(
                            colors: [MB.record.opacity(0.22), .clear],
                            center: .top, startRadius: 0, endRadius: 190
                        )
                    }
                }
            }
            .overlay {
                ViewfinderBrackets(inset: lit ? 4 : 5, arm: 13)
                    .stroke(lit ? MB.record : Color.white.opacity(0.4),
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

/// CXNotes' panel palette (renderer/menubar-panel.html), shared by the CX
/// family: warm charcoal surfaces, Apple-blue accent, muted status hues.
private enum MB {
    static let pane = Color(red: 30 / 255, green: 28 / 255, blue: 25 / 255)
    static let chrome = Color(red: 46 / 255, green: 43 / 255, blue: 38 / 255)
    static let card = Color(red: 26 / 255, green: 24 / 255, blue: 21 / 255)

    static let accent = Color(red: 10 / 255, green: 132 / 255, blue: 255 / 255)

    static let textPrimary = Color.white
    static let textSecondary = Color(red: 222 / 255, green: 220 / 255, blue: 217 / 255)
    static let textMuted = Color(red: 182 / 255, green: 179 / 255, blue: 175 / 255)
    static let textSubtle = Color(red: 150 / 255, green: 147 / 255, blue: 143 / 255)

    static let border = Color.white.opacity(0.12)
    static let borderSubtle = Color.white.opacity(0.08)

    static let success = Color(red: 143 / 255, green: 179 / 255, blue: 136 / 255)
    static let warning = Color(red: 212 / 255, green: 168 / 255, blue: 90 / 255)
    static let danger = Color(red: 212 / 255, green: 118 / 255, blue: 106 / 255)
    /// The record disc — deliberately not `danger`, so start and stop never
    /// read as the same control.
    static let record = Color(red: 229 / 255, green: 72 / 255, blue: 77 / 255)
}

private struct Hairline: View {
    var body: some View {
        Rectangle().fill(MB.borderSubtle).frame(height: 1)
    }
}

private struct StatusDot: View {
    enum Kind { case ok, warn, bad, recording }
    let kind: Kind

    var body: some View {
        switch kind {
        case .recording:
            Image(systemName: "circle.fill")
                .font(.system(size: 7))
                .foregroundStyle(MB.danger)
                .symbolEffect(.pulse, options: .repeating)
        default:
            Circle()
                .fill(color)
                .frame(width: 7, height: 7)
        }
    }

    private var color: Color {
        switch kind {
        case .ok: return MB.success
        case .warn: return MB.warning
        case .bad, .recording: return MB.danger
        }
    }
}

private struct RecLabel: View {
    let text: String
    let color: Color
    let pulsing: Bool

    var body: some View {
        HStack(spacing: 6) {
            if pulsing {
                Image(systemName: "circle.fill")
                    .font(.system(size: 7))
                    .symbolEffect(.pulse, options: .repeating)
            }
            Text(text)
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.66)
        }
        .foregroundStyle(color)
    }
}

private struct SectionEyebrow: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .semibold))
            .tracking(1.0)
            .foregroundStyle(MB.textSubtle)
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

    var body: some View {
        Text(text)
            .font(.system(size: 11.5))
            .foregroundStyle(MB.textSubtle)
            .padding(.top, 2)
    }
}

private struct Chip: View {
    enum Kind { case plain, accent, ok, warn, bad }
    let text: String
    let kind: Kind

    var body: some View {
        Text(text)
            .font(.system(size: 10, design: .monospaced))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .foregroundStyle(foreground)
            .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(fill))
            .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).strokeBorder(stroke))
    }

    private var hue: Color? {
        switch kind {
        case .plain: return nil
        case .accent: return MB.accent
        case .ok: return MB.success
        case .warn: return MB.warning
        case .bad: return MB.danger
        }
    }

    private var foreground: Color { hue ?? MB.textMuted }
    private var fill: Color { hue?.opacity(0.12) ?? MB.card.opacity(0.55) }
    private var stroke: Color { hue?.opacity(0.32) ?? MB.border }
}

private struct ChipButton: View {
    let text: String
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Chip(text: text, kind: hover ? .accent : .plain)
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .help("All past sessions")
    }
}

private struct WarningBox: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("⚠️ \(title)")
                .font(.system(size: 11, weight: .semibold))
            Text(detail)
                .font(.system(size: 10.5))
                .foregroundStyle(Color(red: 240 / 255, green: 198 / 255, blue: 190 / 255))
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(Color(red: 1, green: 226 / 255, blue: 220 / 255))
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Opaque on purpose: a warning that dissolves into the wallpaper
        // defeats itself.
        .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Color(red: 74 / 255, green: 32 / 255, blue: 28 / 255)))
        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Color(red: 150 / 255, green: 68 / 255, blue: 58 / 255)))
    }
}

private struct FooterIcon: View {
    let systemName: String
    let help: String
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 12.5))
                .frame(width: 26, height: 24)
                .foregroundStyle(hover ? MB.textPrimary : MB.textMuted)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.white.opacity(hover ? 0.1 : 0)))
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
        @State private var hover = false

        var body: some View {
            configuration.label
                .font(.system(size: small ? 11 : 12, weight: kind == .normal ? .medium : .semibold))
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
            case .normal: return MB.textPrimary
            case .primary: return .white
            case .danger: return Color(red: 38 / 255, green: 18 / 255, blue: 15 / 255)
            }
        }

        private var fill: Color {
            switch kind {
            case .normal: return Color.white.opacity(hover ? 0.13 : 0.07)
            case .primary: return hover ? Color(red: 8 / 255, green: 106 / 255, blue: 204 / 255) : MB.accent
            case .danger: return hover ? Color(red: 198 / 255, green: 104 / 255, blue: 92 / 255) : MB.danger
            }
        }

        private var stroke: Color {
            switch kind {
            case .normal: return MB.border
            case .primary, .danger: return fill
            }
        }
    }
}

private extension View {
    /// A card lies ON the pane, so it runs denser (and darker) than the pane
    /// beneath it — a well cut into the surface, not a second sheet of glass.
    func cardStyle(border: Color, tint: Color? = nil, padding: CGFloat = 12) -> some View {
        self
            .padding(.horizontal, padding)
            .padding(.vertical, padding - 1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(MB.card.opacity(0.9))
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
/// are reliable. Also pins the window dark, like CXNotes' panel.
private struct PopoverWindowObserver: NSViewRepresentable {
    let onVisibilityChange: (Bool) -> Void

    func makeNSView(context: Context) -> ObserverView {
        let view = ObserverView()
        view.onVisibilityChange = onVisibilityChange
        return view
    }

    func updateNSView(_ nsView: ObserverView, context: Context) {
        nsView.onVisibilityChange = onVisibilityChange
    }

    final class ObserverView: NSView {
        var onVisibilityChange: ((Bool) -> Void)?
        private var tokens: [NSObjectProtocol] = []

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            tokens.forEach { NotificationCenter.default.removeObserver($0) }
            tokens = []
            guard let window else { return }
            window.appearance = NSAppearance(named: .darkAqua)

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
