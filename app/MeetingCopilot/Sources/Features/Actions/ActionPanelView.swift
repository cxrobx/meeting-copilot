import SwiftUI
import UniformTypeIdentifiers

// MARK: - Action Panel View

/// The main floating panel content showing transcript, suggestions, and action results.
struct ActionPanelView: View {
    let sessionManager: SessionManager

    @State private var transcriptSearch = ""
    @State private var sourceFilter: TranscriptSourceFilter = .all
    @State private var autoScroll = true
    @State private var pinnedActionID: String?
    @State private var manualPrompt = ""
    @State private var showingHistory = false

    private let transcriptGrid = [GridItem(.flexible()), GridItem(.flexible())]

    private var dashboard: MeetingDashboardSnapshot {
        MeetingDashboardAnalyzer.snapshot(
            segments: sessionManager.transcriptSegments,
            actions: sessionManager.actions,
            elapsed: sessionManager.sessionElapsedTime
        )
    }

    private var filteredSegments: [TranscriptSegment] {
        sessionManager.transcriptSegments.filter { segment in
            sourceFilter.includes(segment)
            && (transcriptSearch.isEmpty
                || segment.text.localizedCaseInsensitiveContains(transcriptSearch)
                || segment.label.localizedCaseInsensitiveContains(transcriptSearch))
        }
    }

    private var pinnedAction: ActionSuggestion? {
        sessionManager.actions.first {
            $0.id == pinnedActionID && $0.result != nil
        }
    }

    private var suggestedActions: [ActionSuggestion] {
        Array(sessionManager.suggestedActions.reversed())
    }

    private var runningActions: [ActionSuggestion] {
        Array(sessionManager.runningActions.reversed())
    }

    private var completedActions: [ActionSuggestion] {
        Array(sessionManager.completedActions.reversed())
    }

    var body: some View {
        ZStack {
            background

            VStack(spacing: 18) {
                panelHeader

                if sessionManager.state == .idle || sessionManager.state == .archived {
                    idleState
                } else {
                    HStack(alignment: .top, spacing: 16) {
                        insightsColumn
                            .frame(width: 288)

                        transcriptColumn
                            .frame(maxWidth: .infinity, maxHeight: .infinity)

                        actionsColumn
                            .frame(width: 390)
                    }
                }
            }
            .padding(18)
        }
        .frame(minWidth: 1040, idealWidth: 1320, minHeight: 760, idealHeight: 880)
        .overlay(alignment: .top) {
            if let error = sessionManager.errorMessage {
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(DashboardPalette.danger)
                    Text(error)
                        .font(.callout)
                        .foregroundStyle(DashboardPalette.textPrimary)
                    Spacer()
                    Button(action: { sessionManager.dismissError() }) {
                        Image(systemName: "xmark")
                            .foregroundStyle(DashboardPalette.textMuted)
                    }
                    .buttonStyle(.plain)
                }
                .padding(14)
                .background {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(DashboardPalette.danger.opacity(0.15))
                        .overlay(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .stroke(DashboardPalette.danger.opacity(0.3), lineWidth: 1)
                        )
                }
                .padding(.horizontal, 24)
                .padding(.top, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
                .animation(.easeInOut(duration: 0.3), value: sessionManager.errorMessage)
            }
        }
    }

    // MARK: - Background

    private var background: some View {
        ZStack {
            LinearGradient(
                colors: [DashboardPalette.backgroundTop, DashboardPalette.backgroundBottom],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            Circle()
                .fill(DashboardPalette.accentBlue.opacity(0.14))
                .frame(width: 360, height: 360)
                .blur(radius: 80)
                .offset(x: -420, y: -280)

            Circle()
                .fill(DashboardPalette.accent.opacity(0.08))
                .frame(width: 320, height: 320)
                .blur(radius: 90)
                .offset(x: 460, y: -260)

            Circle()
                .fill(DashboardPalette.accentTeal.opacity(0.1))
                .frame(width: 360, height: 360)
                .blur(radius: 110)
                .offset(x: 420, y: 320)
        }
        .ignoresSafeArea()
    }

    // MARK: - Header

    private var panelHeader: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 18) {
                Image(nsImage: AppIconProvider.icon)
                    .resizable()
                    .interpolation(.high)
                    .frame(width: 68, height: 68)
                    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))

                VStack(alignment: .leading, spacing: 10) {
                    Text("Live Copilot")
                        .font(.system(size: 11, weight: .bold))
                        .tracking(1.6)
                        .foregroundStyle(DashboardPalette.textFaint)

                    Text(sessionManager.currentSession?.title ?? "Meeting Copilot")
                        .font(.system(size: 28, weight: .semibold, design: .rounded))
                        .foregroundStyle(DashboardPalette.textPrimary)
                        .lineLimit(1)

                    Text(headerSubtitle)
                        .font(.callout)
                        .foregroundStyle(DashboardPalette.textSecondary)
                        .lineLimit(2)

                    if sessionManager.state != .idle && sessionManager.state != .archived {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 8) {
                                DashboardPill(connectionLabel, icon: connectionIcon, tint: connectionTint)
                                DashboardPill("\(dashboard.pendingCount) awaiting review", icon: "lightbulb", tint: DashboardPalette.warning)
                                DashboardPill("\(dashboard.runningCount) active", icon: "bolt.fill", tint: DashboardPalette.accentBlue)
                                DashboardPill("\(dashboard.signals.count) meeting signals", icon: "waveform.and.magnifyingglass", tint: DashboardPalette.accentTeal)
                            }
                        }
                    }
                }

                Spacer(minLength: 20)

                if sessionManager.state == .idle || sessionManager.state == .archived {
                    // Compact state indicator for idle/archived
                    DashboardPill(stateLabel, icon: sessionManager.state == .idle ? "circle.fill" : "archivebox.fill", tint: DashboardPalette.textMuted)
                } else {
                    VStack(alignment: .trailing, spacing: 8) {
                        HStack(spacing: 8) {
                            if sessionManager.currentSession != nil {
                                Button(action: {
                                    exportCurrentSession()
                                }) {
                                    Image(systemName: "square.and.arrow.up")
                                        .font(.system(size: 13))
                                        .foregroundStyle(DashboardPalette.textMuted)
                                }
                                .buttonStyle(.plain)
                                .help("Export session")
                            }

                            Circle()
                                .fill(connectionTint)
                                .frame(width: 9, height: 9)
                                .shadow(color: connectionTint.opacity(0.6), radius: 6)

                            Text(stateLabel)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(DashboardPalette.textPrimary)
                        }

                        Text(elapsedTime)
                            .font(.system(size: 22, weight: .semibold, design: .monospaced))
                            .foregroundStyle(DashboardPalette.textPrimary)
                            .monospacedDigit()

                        Text(stateDescription)
                            .font(.caption)
                            .foregroundStyle(DashboardPalette.textMuted)
                            .multilineTextAlignment(.trailing)
                            .frame(maxWidth: 220, alignment: .trailing)
                    }
                }
            }

            if sessionManager.state != .idle && sessionManager.state != .archived {
                LazyVGrid(columns: transcriptGrid, spacing: 12) {
                    DashboardMetricTile(
                        title: "Words",
                        value: "\(dashboard.totalWords)",
                        icon: "text.word.spacing",
                        accent: DashboardPalette.accent
                    )
                    DashboardMetricTile(
                        title: "Pace",
                        value: "\(dashboard.pacePerMinute)/min",
                        icon: "speedometer",
                        accent: DashboardPalette.accentBlue
                    )
                    DashboardMetricTile(
                        title: "You",
                        value: "\(dashboard.micWords)",
                        icon: "mic.fill",
                        accent: DashboardPalette.accentBlue
                    )
                    DashboardMetricTile(
                        title: "Meeting",
                        value: "\(dashboard.meetingWords)",
                        icon: "person.3.fill",
                        accent: DashboardPalette.accentTeal
                    )
                }
            }

            if !sessionManager.degradedReasons.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    DashboardSectionHeader(
                        title: "Degraded State",
                        icon: "exclamationmark.triangle.fill",
                        detail: "Capture is still running, but part of the pipeline needs attention."
                    )

                    ForEach(sessionManager.degradedReasons, id: \.self) { reason in
                        HStack(spacing: 10) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(DashboardPalette.warning)
                            Text(reason)
                                .font(.caption)
                                .foregroundStyle(DashboardPalette.textSecondary)
                            Spacer()
                        }
                        .padding(12)
                        .dashboardSurface(
                            cornerRadius: 16,
                            stroke: DashboardPalette.warning.opacity(0.28),
                            fillTop: DashboardPalette.warning.opacity(0.14),
                            fillBottom: DashboardPalette.surfaceMuted,
                            shadowOpacity: 0.08
                        )
                    }
                }
            }
        }
        .padding(22)
        .dashboardSurface(
            cornerRadius: 30,
            stroke: DashboardPalette.strokeStrong,
            fillTop: DashboardPalette.panelTop,
            fillBottom: DashboardPalette.panelBottom,
            shadowOpacity: 0.24
        )
    }

    // MARK: - Insights Column

    private var insightsColumn: some View {
        ScrollView {
            VStack(spacing: 16) {
                sessionRadarCard
                signalCard
                topicCard

                if let pinnedAction {
                    pinnedResultCard(for: pinnedAction)
                }
            }
            .padding(.bottom, 8)
        }
        .scrollIndicators(.hidden)
    }

    private var sessionRadarCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            DashboardSectionHeader(
                title: "Session Radar",
                icon: "gauge.with.dots.needle.67percent",
                detail: "Watch the meeting balance and system health in real time."
            )

            VStack(spacing: 12) {
                InsightStatRow(
                    label: "Connection",
                    value: connectionLabel,
                    icon: connectionIcon,
                    tint: connectionTint
                )
                InsightStatRow(
                    label: "Transcript feed",
                    value: "\(sessionManager.transcriptSegments.count) segments",
                    icon: "text.bubble.fill",
                    tint: DashboardPalette.accentBlue
                )
                InsightStatRow(
                    label: "Pending suggestions",
                    value: "\(dashboard.pendingCount)",
                    icon: "lightbulb.fill",
                    tint: DashboardPalette.warning
                )
                InsightStatRow(
                    label: "Completed actions",
                    value: "\(dashboard.completedCount)",
                    icon: "checkmark.circle.fill",
                    tint: DashboardPalette.success
                )
            }

            Divider()
                .overlay(DashboardPalette.stroke)

            VStack(alignment: .leading, spacing: 10) {
                Text("Speaker balance")
                    .font(.system(size: 11, weight: .bold))
                    .tracking(1)
                    .foregroundStyle(DashboardPalette.textFaint)

                SpeakerBalanceBar(
                    leftLabel: "You",
                    rightLabel: "Meeting",
                    leftValue: dashboard.micWords,
                    rightValue: dashboard.meetingWords
                )
            }
        }
        .padding(18)
        .dashboardSurface()
    }

    private var signalCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            DashboardSectionHeader(
                title: "Meeting Signals",
                icon: "waveform.and.magnifyingglass",
                count: dashboard.signals.count,
                detail: "High-signal cues extracted from the latest conversation."
            )

            if dashboard.signals.isEmpty {
                EmptyCardState(
                    icon: "ear",
                    title: "Listening for cues",
                    message: "Action items, decisions, questions, and risks will appear here as they surface in the meeting."
                )
            } else {
                VStack(spacing: 10) {
                    ForEach(dashboard.signals.prefix(6)) { signal in
                        MeetingSignalRow(signal: signal)
                    }
                }
            }
        }
        .padding(18)
        .dashboardSurface()
    }

    private var topicCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            DashboardSectionHeader(
                title: "Topic Radar",
                icon: "scope",
                count: dashboard.topics.count,
                detail: "Repeated themes in the recent transcript window."
            )

            if dashboard.topics.isEmpty {
                EmptyCardState(
                    icon: "scope",
                    title: "No repeated topics yet",
                    message: "As the conversation settles around recurring themes, they will cluster here."
                )
            } else {
                VStack(spacing: 12) {
                    ForEach(dashboard.topics) { topic in
                        TopicRow(topic: topic, maxCount: max(dashboard.topics.map(\.count).max() ?? 1, 1))
                    }
                }
            }
        }
        .padding(18)
        .dashboardSurface()
    }

    private func pinnedResultCard(for action: ActionSuggestion) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            DashboardSectionHeader(
                title: "Pinned Output",
                icon: "pin.fill",
                detail: action.title
            )

            if let result = action.result {
                Text(result.summary)
                    .font(.callout)
                    .foregroundStyle(DashboardPalette.textPrimary)
                    .lineSpacing(2)
                    .lineLimit(8)
                    .textSelection(.enabled)
            }

            Button(action: { pinnedActionID = nil }) {
                Label("Unpin", systemImage: "pin.slash")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(ActionGhostButtonStyle())
        }
        .padding(18)
        .dashboardSurface(
            stroke: DashboardPalette.warning.opacity(0.28),
            fillTop: DashboardPalette.warning.opacity(0.14),
            fillBottom: DashboardPalette.surfaceMuted
        )
    }

    // MARK: - Transcript Column

    private var transcriptColumn: some View {
        VStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 14) {
                DashboardSectionHeader(
                    title: "Live Transcript",
                    icon: "text.bubble.fill",
                    count: filteredSegments.count,
                    detail: "Streaming from local transcription in real time."
                )

                HStack(spacing: 10) {
                    searchField

                    Picker("Source", selection: $sourceFilter) {
                        ForEach(TranscriptSourceFilter.allCases) { filter in
                            Text(filter.title).tag(filter)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 250)

                    Button(action: { autoScroll.toggle() }) {
                        Label(autoScroll ? "Auto-scroll" : "Manual", systemImage: autoScroll ? "arrow.down.to.line" : "hand.draw")
                    }
                    .buttonStyle(ActionGhostButtonStyle())
                }

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        DashboardPill("\(dashboard.actionSignals.count) action cues", icon: "checklist", tint: DashboardPalette.accentBlue)
                        DashboardPill("\(dashboard.decisionSignals.count) decisions", icon: "checkmark.seal", tint: DashboardPalette.accentTeal)
                        DashboardPill("\(dashboard.questionSignals.count) questions", icon: "questionmark.circle", tint: DashboardPalette.warning)
                        DashboardPill("\(dashboard.blockerSignals.count) risks", icon: "exclamationmark.triangle", tint: DashboardPalette.danger)
                    }
                }
            }
            .padding(18)
            .dashboardSurface()

            TranscriptView(
                segments: filteredSegments,
                autoScroll: autoScroll,
                onRedact: { id in
                    if let index = sessionManager.transcriptSegments.firstIndex(where: { $0.id == id }) {
                        sessionManager.transcriptSegments[index].isRedacted.toggle()
                    }
                }
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .dashboardSurface(cornerRadius: 28)
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(DashboardPalette.textFaint)

            TextField("Search transcript, speaker, or phrase", text: $transcriptSearch)
                .textFieldStyle(.plain)
                .foregroundStyle(DashboardPalette.textPrimary)

            if !transcriptSearch.isEmpty {
                Button(action: { transcriptSearch = "" }) {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(DashboardPalette.textFaint)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .dashboardSurface(
            cornerRadius: 16,
            stroke: DashboardPalette.stroke,
            fillTop: DashboardPalette.surfaceStrong,
            fillBottom: DashboardPalette.surfaceMuted,
            shadowOpacity: 0.08
        )
    }

    // MARK: - Actions Column

    private var quickActionsCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            DashboardSectionHeader(
                title: "Quick Actions",
                icon: "bolt.circle.fill",
                detail: "Manually trigger a worker on the current transcript."
            )

            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(DashboardPalette.textFaint)

                TextField("Topic or prompt (optional)", text: $manualPrompt)
                    .textFieldStyle(.plain)
                    .foregroundStyle(DashboardPalette.textPrimary)

                if !manualPrompt.isEmpty {
                    Button(action: { manualPrompt = "" }) {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(DashboardPalette.textFaint)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .dashboardSurface(
                cornerRadius: 16,
                stroke: DashboardPalette.stroke,
                fillTop: DashboardPalette.surfaceStrong,
                fillBottom: DashboardPalette.surfaceMuted,
                shadowOpacity: 0.08
            )

            HStack(spacing: 8) {
                Button(action: {
                    sessionManager.triggerManualAction(type: "research", prompt: manualPrompt.isEmpty ? nil : manualPrompt)
                    manualPrompt = ""
                }) {
                    Label("Research", systemImage: "magnifyingglass")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(ActionGhostButtonStyle())

                Button(action: {
                    sessionManager.triggerManualAction(type: "summary", prompt: manualPrompt.isEmpty ? nil : manualPrompt)
                    manualPrompt = ""
                }) {
                    Label("Summary", systemImage: "doc.text")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(ActionGhostButtonStyle())

                Button(action: {
                    sessionManager.triggerManualAction(type: "analysis", prompt: manualPrompt.isEmpty ? nil : manualPrompt)
                    manualPrompt = ""
                }) {
                    Label("Analysis", systemImage: "chart.bar")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(ActionGhostButtonStyle())
            }
        }
        .padding(18)
        .dashboardSurface()
    }

    private var actionsColumn: some View {
        ScrollView {
            VStack(spacing: 16) {
                if sessionManager.state == .live || sessionManager.state == .degraded {
                    quickActionsCard
                }

                actionSummaryCard

                if let focusAction = dashboard.focusAction {
                    focusActionCard(focusAction)
                }

                actionSection(
                    title: "Approval Queue",
                    icon: "lightbulb.fill",
                    detail: "Suggestions inferred from the live conversation.",
                    actions: suggestedActions
                )

                actionSection(
                    title: "Active Work",
                    icon: "bolt.fill",
                    detail: "Approved items currently being executed.",
                    actions: runningActions
                )

                actionSection(
                    title: "Completed",
                    icon: "checkmark.circle.fill",
                    detail: "Finished outputs and worker results.",
                    actions: completedActions
                )
            }
            .padding(.bottom, 8)
        }
        .scrollIndicators(.hidden)
    }

    private var actionSummaryCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            DashboardSectionHeader(
                title: "Action Workspace",
                icon: "sparkles.rectangle.stack",
                detail: "Suggestions, automation work, and finished outputs."
            )

            HStack(spacing: 12) {
                CompactMetricPill(title: "Suggested", value: dashboard.pendingCount, tint: DashboardPalette.warning)
                CompactMetricPill(title: "Running", value: dashboard.runningCount, tint: DashboardPalette.accentBlue)
                CompactMetricPill(title: "Done", value: dashboard.completedCount, tint: DashboardPalette.success)
            }
        }
        .padding(18)
        .dashboardSurface()
    }

    private func focusActionCard(_ action: ActionSuggestion) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            DashboardSectionHeader(
                title: "Focus Item",
                icon: "target",
                detail: "The action that currently deserves the most attention."
            )

            Text(action.title)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(DashboardPalette.textPrimary)

            Text(action.description)
                .font(.callout)
                .foregroundStyle(DashboardPalette.textSecondary)
                .lineLimit(4)

            HStack(spacing: 8) {
                DashboardPill(action.type.displayName, icon: action.type.icon, tint: DashboardPalette.accent)
                DashboardPill(action.state.rawValue.capitalized, icon: action.state.isActive ? "bolt.fill" : "lightbulb", tint: action.state.isActive ? DashboardPalette.accentBlue : DashboardPalette.warning)
            }
        }
        .padding(18)
        .dashboardSurface(
            stroke: DashboardPalette.accentBlue.opacity(0.28),
            fillTop: DashboardPalette.accentBlue.opacity(0.14),
            fillBottom: DashboardPalette.surfaceMuted
        )
    }

    private func actionSection(
        title: String,
        icon: String,
        detail: String,
        actions: [ActionSuggestion]
    ) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            DashboardSectionHeader(
                title: title,
                icon: icon,
                count: actions.count,
                detail: detail
            )

            if actions.isEmpty {
                EmptyCardState(
                    icon: icon,
                    title: "Nothing here right now",
                    message: emptyActionMessage(for: title)
                )
            } else {
                VStack(spacing: 12) {
                    ForEach(actions) { action in
                        ActionCardView(
                            action: action,
                            onApprove: { sessionManager.approveAction(id: action.id) },
                            onDismiss: { sessionManager.dismissAction(id: action.id) },
                            onCancel: { sessionManager.cancelAction(id: action.id) },
                            onRetry: { sessionManager.approveAction(id: action.id) },
                            onCopy: { text in copyToClipboard(text) },
                            onPin: {
                                pinnedActionID = pinnedActionID == action.id ? nil : action.id
                            },
                            isPinned: pinnedActionID == action.id
                        )
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                }
            }
        }
        .padding(18)
        .dashboardSurface()
    }

    // MARK: - Idle State

    private var idleState: some View {
        VStack(spacing: 22) {
            Spacer()

            Image(nsImage: AppIconProvider.icon)
                .resizable()
                .interpolation(.high)
                .frame(width: 120, height: 120)

            if sessionManager.serverReady {
                VStack(spacing: 10) {
                    Text("No active meeting")
                        .font(.system(size: 26, weight: .semibold))
                        .foregroundStyle(DashboardPalette.textPrimary)

                    Text("Start a session from the menu bar. The panel will then fill with live transcript, action suggestions, and meeting intelligence.")
                        .font(.callout)
                        .foregroundStyle(DashboardPalette.textSecondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 520)
                }

                HStack(spacing: 12) {
                    DashboardPill("Live transcription", icon: "text.bubble.fill", tint: DashboardPalette.accentBlue)
                    DashboardPill("Action routing", icon: "sparkles", tint: DashboardPalette.warning)
                    DashboardPill("Topic radar", icon: "scope", tint: DashboardPalette.accentTeal)
                }

                Button(action: { sessionManager.requestStartSession() }) {
                    Label("Start Session", systemImage: "record.circle")
                        .frame(maxWidth: 280)
                }
                .buttonStyle(ActionProminentButtonStyle(tint: DashboardPalette.success))
                .disabled(!sessionManager.serverReady)

                Button(action: { showingHistory = true }) {
                    Label("View Past Sessions", systemImage: "clock.arrow.circlepath")
                        .frame(maxWidth: 280)
                }
                .buttonStyle(ActionGhostButtonStyle())
            } else {
                VStack(spacing: 10) {
                    if sessionManager.serverStartFailed {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 32))
                            .foregroundStyle(DashboardPalette.danger)
                            .padding(.bottom, 4)

                        Text("Server connection failed")
                            .font(.system(size: 26, weight: .semibold))
                            .foregroundStyle(DashboardPalette.textPrimary)

                        Text("The local transcription and intelligence server could not be reached. Check that Node.js is installed and try again.")
                            .font(.callout)
                            .foregroundStyle(DashboardPalette.textSecondary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 520)

                        Button(action: { sessionManager.retryServerConnection() }) {
                            Label("Retry Connection", systemImage: "arrow.clockwise")
                                .frame(maxWidth: 220)
                        }
                        .buttonStyle(ActionGhostButtonStyle())
                    } else {
                        ProgressView()
                            .controlSize(.large)
                            .padding(.bottom, 4)

                        Text("Starting server...")
                            .font(.system(size: 26, weight: .semibold))
                            .foregroundStyle(DashboardPalette.textPrimary)

                        Text("The local transcription and intelligence server is booting up. This usually takes a few seconds.")
                            .font(.callout)
                            .foregroundStyle(DashboardPalette.textSecondary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: 520)
                    }
                }
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(40)
        .dashboardSurface(cornerRadius: 32)
        .sheet(isPresented: $showingHistory) {
            SessionHistoryView(sessionManager: sessionManager)
        }
    }

    // MARK: - Export Current Session

    private func exportCurrentSession() {
        guard let sessionId = sessionManager.currentSession?.id else { return }
        Task {
            guard let content = await sessionManager.exportSession(sessionId: sessionId) else { return }

            let panel = NSSavePanel()
            panel.title = "Export Session"
            let title = sessionManager.currentSession?.title ?? "meeting"
            let sanitized = title.components(separatedBy: CharacterSet(charactersIn: "/\\:*?\"<>|")).joined(separator: "-")
            panel.nameFieldStringValue = "\(sanitized).md"
            panel.allowedContentTypes = [.plainText]
            panel.canCreateDirectories = true

            let response = panel.runModal()
            if response == .OK, let url = panel.url {
                try? content.write(to: url, atomically: true, encoding: .utf8)
            }
        }
    }

    // MARK: - Helpers

    private var stateLabel: String {
        switch sessionManager.state {
        case .idle:
            return "Ready"
        case .priming:
            return "Priming"
        case .live:
            return "Live"
        case .degraded:
            return "Degraded"
        case .ending:
            return "Ending"
        case .error:
            return "Error"
        case .archived:
            return "Archived"
        }
    }

    private var headerSubtitle: String {
        switch sessionManager.state {
        case .idle:
            return sessionManager.serverReady ? "Waiting for a meeting to begin." : "Starting local server..."
        case .priming:
            return "Initializing audio capture, server connection, and meeting intelligence."
        case .live:
            return "Real-time transcription, inferred suggestions, and action execution are updating continuously."
        case .degraded:
            return "Capture is still active, but one or more parts of the pipeline need attention."
        case .ending:
            return "Wrapping up the session and waiting for any in-flight work to finish."
        case .error:
            return "The session encountered an error."
        case .archived:
            return "The previous meeting has been stored."
        }
    }

    private var stateDescription: String {
        switch sessionManager.state {
        case .idle:
            return "No active session"
        case .priming:
            return "Acquiring devices"
        case .live:
            return "All systems streaming"
        case .degraded:
            return sessionManager.degradedReasons.first ?? "Partial pipeline availability"
        case .ending:
            return "Waiting for worker completion"
        case .error:
            return "Check setup and retry"
        case .archived:
            return "Session persisted"
        }
    }

    private var connectionLabel: String {
        if sessionManager.isConnected {
            return "Server synced"
        }
        if sessionManager.state == .degraded {
            return "Buffering locally"
        }
        return "Waiting on server"
    }

    private var connectionIcon: String {
        if sessionManager.isConnected {
            return "dot.radiowaves.left.and.right"
        }
        if sessionManager.state == .degraded {
            return "externaldrive.badge.exclamationmark"
        }
        return "wifi.slash"
    }

    private var connectionTint: Color {
        if sessionManager.state == .degraded {
            return DashboardPalette.warning
        }
        return sessionManager.isConnected ? DashboardPalette.success : DashboardPalette.textMuted
    }

    private var elapsedTime: String {
        let interval = sessionManager.sessionElapsedTime
        let hours = Int(interval) / 3600
        let minutes = (Int(interval) % 3600) / 60
        let seconds = Int(interval) % 60

        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        }

        return String(format: "%02d:%02d", minutes, seconds)
    }

    private func emptyActionMessage(for title: String) -> String {
        switch title {
        case "Approval Queue":
            return "When the intelligence engine finds something actionable, it will land here for review."
        case "Active Work":
            return "Approved items will move here while workers are running."
        case "Completed":
            return "Finished results will accumulate here once workers return output."
        default:
            return "Nothing to show yet."
        }
    }

    private func copyToClipboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

private struct InsightStatRow: View {
    let label: String
    let value: String
    let icon: String
    let tint: Color

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(tint)
                .frame(width: 30, height: 30)
                .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 10, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                Text(label)
                    .font(.caption)
                    .foregroundStyle(DashboardPalette.textMuted)
                Text(value)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(DashboardPalette.textPrimary)
            }

            Spacer()
        }
    }
}

private struct SpeakerBalanceBar: View {
    let leftLabel: String
    let rightLabel: String
    let leftValue: Int
    let rightValue: Int

    private var total: Double {
        Double(max(leftValue + rightValue, 1))
    }

    var body: some View {
        VStack(spacing: 8) {
            GeometryReader { geometry in
                let leftWidth = geometry.size.width * (Double(leftValue) / total)

                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(DashboardPalette.surfaceStrong)

                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [DashboardPalette.accentBlue, DashboardPalette.accentTeal],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: max(leftWidth, 12))
                }
            }
            .frame(height: 14)

            HStack {
                Text("\(leftLabel) \(leftValue)")
                    .foregroundStyle(DashboardPalette.textSecondary)
                Spacer()
                Text("\(rightLabel) \(rightValue)")
                    .foregroundStyle(DashboardPalette.textSecondary)
            }
            .font(.caption)
        }
    }
}

private struct MeetingSignalRow: View {
    let signal: MeetingSignal

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                DashboardPill(signal.kind.shortLabel, icon: signal.kind.icon, tint: signal.kind.tint)

                Spacer()

                Text(signal.timestamp.formatted(date: .omitted, time: .shortened))
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(DashboardPalette.textFaint)
            }

            Text(signal.excerpt)
                .font(.callout)
                .foregroundStyle(DashboardPalette.textPrimary)
                .lineSpacing(2)
                .lineLimit(3)

            Text(signal.speaker)
                .font(.caption)
                .foregroundStyle(DashboardPalette.textMuted)
        }
        .padding(14)
        .dashboardSurface(
            cornerRadius: 18,
            stroke: signal.kind.tint.opacity(0.24),
            fillTop: signal.kind.tint.opacity(0.12),
            fillBottom: DashboardPalette.surfaceMuted,
            shadowOpacity: 0.08
        )
    }
}

private struct TopicRow: View {
    let topic: MeetingTopic
    let maxCount: Int

    private var ratio: Double {
        Double(topic.count) / Double(max(maxCount, 1))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(topic.term)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(DashboardPalette.textPrimary)

                Spacer()

                Text("\(topic.count)x")
                    .font(.caption)
                    .foregroundStyle(DashboardPalette.textMuted)
            }

            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(DashboardPalette.surfaceStrong)

                    Capsule()
                        .fill(
                            LinearGradient(
                                colors: [DashboardPalette.accent, DashboardPalette.accentBlue],
                                startPoint: .leading,
                                endPoint: .trailing
                            )
                        )
                        .frame(width: max(geometry.size.width * ratio, 10))
                }
            }
            .frame(height: 10)
        }
    }
}

private struct CompactMetricPill: View {
    let title: String
    let value: Int
    let tint: Color

    var body: some View {
        VStack(spacing: 4) {
            Text("\(value)")
                .font(.system(size: 18, weight: .semibold, design: .rounded))
                .foregroundStyle(DashboardPalette.textPrimary)

            Text(title)
                .font(.caption)
                .foregroundStyle(DashboardPalette.textMuted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(tint.opacity(0.24), lineWidth: 1)
        )
    }
}

private struct EmptyCardState: View {
    let icon: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 24))
                .foregroundStyle(DashboardPalette.textFaint)

            Text(title)
                .font(.headline)
                .foregroundStyle(DashboardPalette.textSecondary)

            Text(message)
                .font(.caption)
                .foregroundStyle(DashboardPalette.textMuted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(18)
        .dashboardSurface(
            cornerRadius: 18,
            stroke: DashboardPalette.stroke,
            fillTop: DashboardPalette.surfaceStrong,
            fillBottom: DashboardPalette.surfaceMuted,
            shadowOpacity: 0.06
        )
    }
}
