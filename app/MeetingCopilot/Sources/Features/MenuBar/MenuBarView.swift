import SwiftUI

// MARK: - Menu Bar View

/// The menubar extra popover content showing session status and controls.
struct MenuBarView: View {
    let sessionManager: SessionManager
    let onStartSession: () -> Void
    let onTogglePanel: () -> Void
    let onQuit: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 12) {
            // Session Status Header
            HStack {
                statusIcon
                VStack(alignment: .leading, spacing: 2) {
                    Text(statusTitle)
                        .font(.headline)
                    Text(statusSubtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.horizontal, 4)

            Divider()

            // Quick Stats (when recording)
            if sessionManager.isRecording || sessionManager.state == .degraded {
                HStack(spacing: 16) {
                    StatBadge(
                        icon: "text.word.spacing",
                        value: "\(sessionManager.totalWordCount)",
                        label: "words"
                    )
                    StatBadge(
                        icon: "bolt.fill",
                        value: "\(sessionManager.runningActions.count)",
                        label: "active"
                    )
                    StatBadge(
                        icon: "lightbulb.fill",
                        value: "\(sessionManager.suggestedActions.count)",
                        label: "pending"
                    )
                }
                .padding(.horizontal, 4)

                Divider()
            }

            // Actions
            VStack(spacing: 4) {
                if sessionManager.serverStartFailed {
                    // Server never came up — a perpetual spinner with no way
                    // out is a dead end. Show what happened and offer Retry.
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .top, spacing: 6) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.red)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Server failed to start")
                                    .font(.caption)
                                    .fontWeight(.semibold)
                                Text(sessionManager.errorMessage ?? "Check ~/.meeting-copilot/server.log")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(3)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Button(action: {
                            // startServer() is a no-op if the process is alive
                            // and resets the restart budget after a crash-loop
                            // give-up; then re-enter the health poll.
                            sessionManager.processSupervisor.startServer()
                            sessionManager.retryServerConnection()
                        }) {
                            HStack {
                                Image(systemName: "arrow.clockwise")
                                Text("Retry")
                                Spacer()
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 4)
                    .padding(.vertical, 4)
                } else {
                    // Start/Stop Button
                    Button(action: {
                        if sessionManager.state == .idle || sessionManager.state == .archived {
                            dismiss() // close the popover so the panel gets focus
                            onStartSession()
                        } else if sessionManager.state == .live || sessionManager.state == .degraded {
                            sessionManager.stopSession()
                        }
                    }) {
                        HStack {
                            if !sessionManager.serverReady && !sessionManager.isRecording {
                                ProgressView()
                                    .controlSize(.small)
                                    .frame(width: 16, height: 16)
                                Text("Starting server...")
                                    .foregroundStyle(.secondary)
                            } else {
                                Image(systemName: sessionManager.isRecording ? "stop.circle.fill" : "record.circle")
                                    .foregroundStyle(sessionManager.isRecording ? .red : .green)
                                Text(sessionManager.isRecording ? "Stop Session" : "Start Session")
                            }
                            Spacer()
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!sessionManager.serverReady && !sessionManager.isRecording)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 4)
                }

                // Show Panel
                Button(action: {
                    dismiss() // close the popover so the panel can take key
                    onTogglePanel()
                }) {
                    HStack {
                        Image(systemName: "rectangle.on.rectangle")
                        Text("Toggle Panel")
                        Spacer()
                        Text("\u{2318}\u{21E7}M")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 2)
                            .background(.quaternary)
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 4)
                .padding(.vertical, 4)

                Divider()

                // Quit
                Button(action: onQuit) {
                    HStack {
                        Image(systemName: "power")
                        Text("Quit Meeting Copilot")
                        Spacer()
                        Text("\u{2318}Q")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 2)
                            .background(.quaternary)
                            .clipShape(RoundedRectangle(cornerRadius: 3))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 4)
                .padding(.vertical, 4)
            }
        }
        .padding(12)
        .frame(width: 280)
    }

    // MARK: - Status Display

    @ViewBuilder
    private var statusIcon: some View {
        switch sessionManager.state {
        case .idle, .archived:
            Image(nsImage: AppIconProvider.icon)
                .resizable()
                .interpolation(.high)
                .frame(width: 28, height: 28)
                .opacity(0.7)
        case .priming:
            ProgressView()
                .controlSize(.small)
        case .live:
            Image(systemName: "waveform.badge.mic")
                .font(.title2)
                .foregroundStyle(.red)
                .symbolEffect(.pulse, isActive: true)
        case .degraded:
            Image(systemName: "waveform.badge.exclamationmark")
                .font(.title2)
                .foregroundStyle(.orange)
        case .ending:
            ProgressView()
                .controlSize(.small)
        case .error:
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.title2)
                .foregroundStyle(.red)
        }
    }

    private var statusTitle: String {
        switch sessionManager.state {
        case .idle:     return "Ready"
        case .priming:  return "Starting..."
        case .live:     return "Recording"
        case .degraded: return "Degraded"
        case .ending:   return "Ending..."
        case .error:    return "Error"
        case .archived: return "Session Ended"
        }
    }

    private var statusSubtitle: String {
        switch sessionManager.state {
        case .idle:     return sessionManager.serverStartFailed ? "Server failed to start" : "No active session"
        case .priming:  return "Acquiring audio..."
        case .live:     return formatElapsedTime(sessionManager.sessionElapsedTime)
        case .degraded: return sessionManager.degradedReasons.joined(separator: ", ")
        case .ending:   return "Waiting for actions to complete..."
        case .error:    return sessionManager.errorMessage ?? "Something went wrong"
        case .archived: return "All data saved"
        }
    }

    private func formatElapsedTime(_ interval: TimeInterval) -> String {
        let hours = Int(interval) / 3600
        let minutes = (Int(interval) % 3600) / 60
        let seconds = Int(interval) % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        }
        return String(format: "%d:%02d", minutes, seconds)
    }
}

// MARK: - Stat Badge

struct StatBadge: View {
    let icon: String
    let value: String
    let label: String

    var body: some View {
        VStack(spacing: 2) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.system(.caption, design: .monospaced, weight: .semibold))
            }
            Text(label)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }
}
