import AppKit
import SwiftUI

// MARK: - Action Card View

/// Individual action suggestion/result card with approve, dismiss, and expand controls.
struct ActionCardView: View {
    let action: ActionSuggestion
    let onApprove: () -> Void
    let onDismiss: () -> Void
    let onCancel: () -> Void
    let onRetry: () -> Void
    let onCopy: (String) -> Void
    let onPin: () -> Void
    var isPinned: Bool = false

    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header

            if !action.description.isEmpty {
                Text(action.description)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(DashboardPalette.textSecondary)
                    .lineSpacing(2)
            }

            if !action.triggerQuote.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Trigger")
                        .font(.system(size: 10, weight: .bold))
                        .tracking(0.8)
                        .foregroundStyle(DashboardPalette.textFaint)

                    Text("“\(action.triggerQuote)”")
                        .font(.callout)
                        .foregroundStyle(DashboardPalette.textPrimary)
                        .italic()
                        .lineLimit(isExpanded ? nil : 3)
                }
                .padding(12)
                .dashboardSurface(
                    cornerRadius: 16,
                    stroke: DashboardPalette.stroke,
                    fillTop: DashboardPalette.surfaceStrong,
                    fillBottom: DashboardPalette.surfaceMuted,
                    shadowOpacity: 0.08
                )
            }

            metadataRow

            controls

            if action.state == .completed, let result = action.result {
                resultSection(result)
            }
        }
        .padding(18)
        .dashboardSurface(
            cornerRadius: 24,
            stroke: borderColor,
            fillTop: stateColor.opacity(0.14),
            fillBottom: DashboardPalette.surfaceMuted,
            shadowOpacity: 0.18
        )
        .animation(.easeInOut(duration: 0.22), value: action.state)
        .animation(.easeInOut(duration: 0.22), value: isExpanded)
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(stateColor.opacity(0.14))

                Image(systemName: action.type.icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(stateColor)
            }
            .frame(width: 42, height: 42)

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 8) {
                    Text(action.title)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(DashboardPalette.textPrimary)
                        .lineLimit(2)

                    Spacer(minLength: 8)

                    DashboardPill(stateLabel, icon: stateIcon, tint: stateColor)
                }

                HStack(spacing: 8) {
                    DashboardPill(action.type.displayName, icon: action.type.icon, tint: DashboardPalette.accent)
                    DashboardPill("~\(action.estimatedDurationSec)s", icon: "timer", tint: DashboardPalette.textMuted)
                }
            }
        }
    }

    private var metadataRow: some View {
        HStack(spacing: 10) {
            Label(createdTime, systemImage: "clock")
                .labelStyle(.titleAndIcon)

            if action.state.isTerminal, let completedAt = action.completedAt {
                Label(completionText(completedAt), systemImage: "checkmark.circle")
                    .labelStyle(.titleAndIcon)
            }

            Spacer()

            if isPinned {
                DashboardPill("Pinned", icon: "pin.fill", tint: DashboardPalette.warning)
            }
        }
        .font(.caption)
        .foregroundStyle(DashboardPalette.textMuted)
    }

    @ViewBuilder
    private var controls: some View {
        switch action.state {
        case .suggested:
            HStack(spacing: 10) {
                Button(action: onDismiss) {
                    Label("Dismiss", systemImage: "xmark")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(ActionGhostButtonStyle())

                Button(action: onApprove) {
                    Label("Approve", systemImage: "checkmark")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(ActionProminentButtonStyle(tint: DashboardPalette.success))
            }

        case .approved, .queued, .running:
            HStack(spacing: 10) {
                ProgressView()
                    .tint(stateColor)

                if let startedAt = action.startedAt {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(elapsedString(since: startedAt, now: context.date))
                            .font(.caption)
                            .foregroundStyle(DashboardPalette.textSecondary)
                            .monospacedDigit()
                    }
                } else {
                    Text(action.state == .queued ? "Queued for execution" : "Starting work")
                        .font(.caption)
                        .foregroundStyle(DashboardPalette.textSecondary)
                }

                Spacer()

                Button(action: onCancel) {
                    Label("Cancel", systemImage: "xmark.circle")
                }
                .buttonStyle(ActionGhostButtonStyle())
            }

        case .failed:
            HStack(spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(DashboardPalette.danger)

                Text(action.result?.error ?? "Action failed")
                    .font(.caption)
                    .foregroundStyle(DashboardPalette.textSecondary)
                    .lineLimit(2)

                Spacer()

                Button(action: onRetry) {
                    Label("Retry", systemImage: "arrow.clockwise")
                }
                .buttonStyle(ActionGhostButtonStyle())
            }
            .padding(12)
            .dashboardSurface(
                cornerRadius: 16,
                stroke: DashboardPalette.danger.opacity(0.24),
                fillTop: DashboardPalette.danger.opacity(0.12),
                fillBottom: DashboardPalette.surfaceMuted,
                shadowOpacity: 0.08
            )

        case .completed, .cancelled, .expired:
            EmptyView()
        }
    }

    private func resultSection(_ result: ActionResult) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                DashboardSectionHeader(
                    title: result.success ? "Output" : "Error",
                    icon: result.success ? "sparkles" : "exclamationmark.octagon",
                    detail: result.success ? "Worker result is ready to review" : "The worker returned an error"
                )

                Spacer()

                Button(action: { onCopy(result.summary) }) {
                    Image(systemName: "doc.on.doc")
                        .foregroundStyle(DashboardPalette.textSecondary)
                        .frame(width: 30, height: 30)
                        .background(DashboardPalette.surfaceStrong, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)

                Button(action: onPin) {
                    Image(systemName: isPinned ? "pin.fill" : "pin")
                        .foregroundStyle(isPinned ? DashboardPalette.warning : DashboardPalette.textSecondary)
                        .frame(width: 30, height: 30)
                        .background(DashboardPalette.surfaceStrong, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
            }

            Text(result.summary)
                .font(.callout)
                .foregroundStyle(DashboardPalette.textPrimary)
                .lineSpacing(2)
                .lineLimit(isExpanded ? nil : 4)
                .textSelection(.enabled)

            if isExpanded, let artifacts = result.artifacts, !artifacts.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(artifacts) { artifact in
                        artifactView(artifact)
                    }
                }
            }

            Button(action: { isExpanded.toggle() }) {
                Label(isExpanded ? "Collapse" : "Expand Result", systemImage: isExpanded ? "chevron.up" : "chevron.down")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(ActionGhostButtonStyle())
        }
        .padding(14)
        .dashboardSurface(
            cornerRadius: 18,
            stroke: DashboardPalette.stroke,
            fillTop: DashboardPalette.surfaceStrong,
            fillBottom: DashboardPalette.surfaceMuted,
            shadowOpacity: 0.1
        )
    }

    @ViewBuilder
    private func artifactView(_ artifact: Artifact) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                if let title = artifact.title {
                    Text(title)
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(DashboardPalette.textPrimary)
                }

                Spacer()

                DashboardPill(artifact.type.rawValue.capitalized, tint: DashboardPalette.textMuted)
            }

            switch artifact.type {
            case .text, .markdown:
                Text(artifact.content)
                    .font(.caption)
                    .foregroundStyle(DashboardPalette.textSecondary)
                    .lineSpacing(2)
                    .textSelection(.enabled)

            case .code:
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(artifact.content)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(DashboardPalette.textPrimary)
                        .textSelection(.enabled)
                        .padding(10)
                }
                .dashboardSurface(
                    cornerRadius: 14,
                    stroke: DashboardPalette.stroke,
                    fillTop: DashboardPalette.surfaceStrong,
                    fillBottom: DashboardPalette.surfaceMuted,
                    shadowOpacity: 0.04
                )

            case .image:
                if let nsImage = parseImageData(artifact.content) {
                    Image(nsImage: nsImage)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(maxWidth: .infinity, maxHeight: 300)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                } else if artifact.content.hasPrefix("http://") || artifact.content.hasPrefix("https://") {
                    if let url = URL(string: artifact.content) {
                        AsyncImage(url: url) { phase in
                            switch phase {
                            case .success(let image):
                                image
                                    .resizable()
                                    .aspectRatio(contentMode: .fit)
                                    .frame(maxWidth: .infinity, maxHeight: 300)
                                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                            case .failure:
                                Text("Failed to load image")
                                    .font(.caption)
                                    .foregroundStyle(DashboardPalette.danger)
                            case .empty:
                                ProgressView()
                                    .frame(maxWidth: .infinity, maxHeight: 100)
                            @unknown default:
                                EmptyView()
                            }
                        }
                    } else {
                        Text("Invalid image URL")
                            .font(.caption)
                            .foregroundStyle(DashboardPalette.textMuted)
                    }
                } else {
                    Text("Unsupported image format")
                        .font(.caption)
                        .foregroundStyle(DashboardPalette.textMuted)
                }
            }
        }
        .padding(12)
        .dashboardSurface(
            cornerRadius: 16,
            stroke: DashboardPalette.stroke,
            fillTop: DashboardPalette.surfaceStrong,
            fillBottom: DashboardPalette.surfaceMuted,
            shadowOpacity: 0.06
        )
    }

    // MARK: - Image Parsing

    private func parseImageData(_ content: String) -> NSImage? {
        // Handle data URL: data:image/...;base64,<data>
        if content.hasPrefix("data:image/") {
            if let commaIndex = content.firstIndex(of: ",") {
                let base64String = String(content[content.index(after: commaIndex)...])
                if let data = Data(base64Encoded: base64String) {
                    return NSImage(data: data)
                }
            }
        }

        // Try raw base64
        if let data = Data(base64Encoded: content) {
            return NSImage(data: data)
        }

        return nil
    }

    // MARK: - Helpers

    private var stateLabel: String {
        switch action.state {
        case .suggested: return "Suggested"
        case .approved: return "Approved"
        case .queued: return "Queued"
        case .running: return "Running"
        case .completed: return "Complete"
        case .failed: return "Failed"
        case .cancelled: return "Cancelled"
        case .expired: return "Expired"
        }
    }

    private var stateIcon: String {
        switch action.state {
        case .suggested: return "lightbulb"
        case .approved: return "checkmark.circle"
        case .queued: return "clock.arrow.circlepath"
        case .running: return "bolt.fill"
        case .completed: return "checkmark.circle.fill"
        case .failed: return "xmark.octagon.fill"
        case .cancelled: return "minus.circle.fill"
        case .expired: return "clock.badge.xmark"
        }
    }

    private var stateColor: Color {
        switch action.state {
        case .suggested: return DashboardPalette.accentBlue
        case .approved, .queued, .running: return DashboardPalette.warning
        case .completed: return DashboardPalette.success
        case .failed: return DashboardPalette.danger
        case .cancelled, .expired: return DashboardPalette.textMuted
        }
    }

    private var borderColor: Color {
        switch action.state {
        case .suggested: return DashboardPalette.accentBlue.opacity(0.28)
        case .approved, .queued, .running: return DashboardPalette.warning.opacity(0.28)
        case .completed: return DashboardPalette.success.opacity(0.22)
        case .failed: return DashboardPalette.danger.opacity(0.28)
        case .cancelled, .expired: return DashboardPalette.stroke
        }
    }

    private var createdTime: String {
        action.createdAt.formatted(date: .omitted, time: .shortened)
    }

    private func completionText(_ date: Date) -> String {
        "Completed \(date.formatted(date: .omitted, time: .shortened))"
    }

    private func elapsedString(since date: Date, now: Date) -> String {
        let elapsed = Int(now.timeIntervalSince(date))
        if elapsed < 60 {
            return "\(elapsed)s elapsed"
        }
        return "\(elapsed / 60)m \(elapsed % 60)s elapsed"
    }
}

struct ActionProminentButtonStyle: ButtonStyle {
    let tint: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(tint.opacity(configuration.isPressed ? 0.72 : 0.9))
            )
            .scaleEffect(configuration.isPressed ? 0.99 : 1)
    }
}

struct ActionGhostButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(DashboardPalette.textSecondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(DashboardPalette.surfaceStrong.opacity(configuration.isPressed ? 0.72 : 1))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(DashboardPalette.stroke, lineWidth: 1)
            )
            .scaleEffect(configuration.isPressed ? 0.99 : 1)
    }
}
