import SwiftUI
import UniformTypeIdentifiers

struct SessionHistoryView: View {
    let sessionManager: SessionManager

    @State private var sessions: [SessionHistoryItem] = []
    @State private var isLoading = true
    @State private var exportingSessionId: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Session History")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(DashboardPalette.textPrimary)

                    Text("\(sessions.count) past session\(sessions.count == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(DashboardPalette.textMuted)
                }

                Spacer()

                Button(action: { dismiss() }) {
                    Label("Close", systemImage: "xmark.circle.fill")
                }
                .buttonStyle(ActionGhostButtonStyle())
            }
            .padding(20)

            Divider()
                .overlay(DashboardPalette.stroke)

            // Content
            if isLoading {
                Spacer()
                ProgressView()
                    .controlSize(.large)
                Text("Loading sessions...")
                    .font(.callout)
                    .foregroundStyle(DashboardPalette.textMuted)
                    .padding(.top, 8)
                Spacer()
            } else if sessions.isEmpty {
                Spacer()
                VStack(spacing: 12) {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: 36))
                        .foregroundStyle(DashboardPalette.textFaint)

                    Text("No past sessions")
                        .font(.headline)
                        .foregroundStyle(DashboardPalette.textSecondary)

                    Text("Completed meetings will appear here with their transcripts, actions, and export options.")
                        .font(.callout)
                        .foregroundStyle(DashboardPalette.textMuted)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 360)
                }
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(sessions) { session in
                            sessionCard(session)
                        }
                    }
                    .padding(20)
                }
            }
        }
        .frame(minWidth: 560, idealWidth: 640, minHeight: 480, idealHeight: 600)
        .background {
            LinearGradient(
                colors: [DashboardPalette.backgroundTop, DashboardPalette.backgroundBottom],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
        .onAppear {
            Task {
                sessions = await sessionManager.fetchSessionHistory()
                isLoading = false
            }
        }
    }

    // MARK: - Session Card

    private func sessionCard(_ session: SessionHistoryItem) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.title.isEmpty ? "Untitled Meeting" : session.title)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(DashboardPalette.textPrimary)
                        .lineLimit(1)

                    if let date = session.startDate {
                        Text(date.formatted(date: .abbreviated, time: .shortened))
                            .font(.caption)
                            .foregroundStyle(DashboardPalette.textMuted)
                    }
                }

                Spacer()

                DashboardPill(session.state.capitalized, icon: stateIcon(session.state), tint: stateTint(session.state))
            }

            HStack(spacing: 16) {
                metricLabel(icon: "clock", value: session.formattedDuration)
                metricLabel(icon: "text.bubble", value: "\(session.transcriptSegments) segments")
                metricLabel(icon: "sparkles", value: "\(session.actions?.count ?? 0) actions")
            }

            HStack(spacing: 10) {
                Button(action: {
                    exportSession(session, format: "markdown")
                }) {
                    Label("Export Markdown", systemImage: "doc.text")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(ActionGhostButtonStyle())

                Button(action: {
                    exportSession(session, format: "json")
                }) {
                    Label("Export JSON", systemImage: "curlybraces")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(ActionGhostButtonStyle())
            }
        }
        .padding(16)
        .dashboardSurface()
    }

    // MARK: - Helpers

    private func metricLabel(icon: String, value: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption2)
                .foregroundStyle(DashboardPalette.accentBlue)
            Text(value)
                .font(.caption)
                .foregroundStyle(DashboardPalette.textSecondary)
        }
    }

    private func stateIcon(_ state: String) -> String {
        switch state {
        case "ended", "archived": return "checkmark.circle"
        case "active": return "record.circle"
        default: return "circle"
        }
    }

    private func stateTint(_ state: String) -> Color {
        switch state {
        case "ended", "archived": return DashboardPalette.success
        case "active": return DashboardPalette.accentBlue
        default: return DashboardPalette.textMuted
        }
    }

    private func exportSession(_ session: SessionHistoryItem, format: String) {
        Task {
            guard let content = await sessionManager.exportSession(sessionId: session.sessionId, format: format) else {
                return
            }

            let panel = NSSavePanel()
            panel.title = "Export Session"
            panel.nameFieldStringValue = format == "json"
                ? "\(session.title.isEmpty ? "meeting" : sanitizeFilename(session.title)).json"
                : "\(session.title.isEmpty ? "meeting" : sanitizeFilename(session.title)).md"
            panel.allowedContentTypes = format == "json"
                ? [.json]
                : [.plainText]
            panel.canCreateDirectories = true

            let response = panel.runModal()
            if response == .OK, let url = panel.url {
                try? content.write(to: url, atomically: true, encoding: .utf8)
            }
        }
    }

    private func sanitizeFilename(_ name: String) -> String {
        let invalid = CharacterSet(charactersIn: "/\\:*?\"<>|")
        return name.components(separatedBy: invalid).joined(separator: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
