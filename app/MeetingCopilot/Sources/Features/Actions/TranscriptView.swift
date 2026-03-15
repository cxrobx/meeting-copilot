import SwiftUI

// MARK: - Transcript View

/// Live transcript feed showing labeled segments from mic and meeting audio.
struct TranscriptView: View {
    let segments: [TranscriptSegment]
    let autoScroll: Bool
    let onRedact: (String) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if segments.isEmpty {
                    emptyState
                        .padding(24)
                } else {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(segments) { segment in
                            TranscriptSegmentRow(segment: segment)
                                .id(segment.id)
                                .contextMenu {
                                    Button(segment.isRedacted ? "Unredact" : "Mark as Redacted") {
                                        onRedact(segment.id)
                                    }
                                }
                                .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }
                    }
                    .padding(16)
                }
            }
            .onChange(of: segments.last?.id) { _, lastID in
                guard autoScroll, let lastID else { return }
                withAnimation(.easeOut(duration: 0.22)) {
                    proxy.scrollTo(lastID, anchor: .bottom)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "waveform.and.magnifyingglass")
                .font(.system(size: 28))
                .foregroundStyle(DashboardPalette.textFaint)

            Text("No transcript matches this view yet")
                .font(.headline)
                .foregroundStyle(DashboardPalette.textSecondary)

            Text("The feed updates continuously as audio is transcribed. Adjust the filters or keep listening.")
                .font(.caption)
                .foregroundStyle(DashboardPalette.textMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 280)
        }
        .frame(maxWidth: .infinity, minHeight: 220)
        .dashboardSurface(
            cornerRadius: 22,
            stroke: DashboardPalette.stroke,
            fillTop: DashboardPalette.surfaceStrong,
            fillBottom: DashboardPalette.surfaceMuted,
            shadowOpacity: 0.16
        )
    }
}

// MARK: - Transcript Segment Row

struct TranscriptSegmentRow: View {
    let segment: TranscriptSegment

    private var tags: [MeetingSignalKind] {
        MeetingDashboardAnalyzer.tags(for: segment)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                DashboardPill(displayLabel, icon: sourceIcon, tint: sourceTint)

                if !tags.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(tags) { tag in
                                DashboardPill(tag.shortLabel, icon: tag.icon, tint: tag.tint)
                            }
                        }
                    }
                }

                Spacer(minLength: 8)

                Text(timeFormatter.string(from: segment.timestamp))
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(DashboardPalette.textFaint)
            }

            Text(segment.isRedacted ? "[REDACTED]" : segment.text)
                .font(.system(size: 15, weight: .medium))
                .lineSpacing(3)
                .foregroundStyle(segment.isRedacted ? DashboardPalette.textMuted : DashboardPalette.textPrimary)
                .italic(segment.isRedacted)
                .textSelection(.enabled)

            HStack(spacing: 10) {
                Label("\(segment.wordCount) words", systemImage: "text.word.spacing")
                    .labelStyle(.titleAndIcon)
                Label(durationText, systemImage: "waveform")
                    .labelStyle(.titleAndIcon)
            }
            .font(.caption)
            .foregroundStyle(DashboardPalette.textMuted)
        }
        .padding(16)
        .dashboardSurface(
            cornerRadius: 20,
            stroke: sourceTint.opacity(0.28),
            fillTop: sourceTint.opacity(0.12),
            fillBottom: DashboardPalette.surfaceMuted,
            shadowOpacity: 0.16
        )
    }

    private var displayLabel: String {
        segment.label
            .replacingOccurrences(of: "[", with: "")
            .replacingOccurrences(of: "]", with: "")
    }

    private var sourceIcon: String {
        switch segment.source {
        case .mic:
            return "mic.fill"
        case .meeting:
            return "person.3.fill"
        }
    }

    private var sourceTint: Color {
        switch segment.source {
        case .mic:
            return DashboardPalette.accentBlue
        case .meeting:
            return DashboardPalette.accent
        }
    }

    private var durationText: String {
        String(format: "%.0fs chunk", max(segment.duration, 0))
    }
}

// MARK: - Time Formatter

private let timeFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "h:mm:ss a"
    return formatter
}()
