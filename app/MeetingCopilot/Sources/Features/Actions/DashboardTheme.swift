import SwiftUI

// CXMail aesthetic palette — warm taupe/brown neutrals + iOS-blue accent.
// Dark-only for now: light-mode support would require restructuring the
// gradient-based `dashboardSurface` modifier; tracked as a follow-up.
enum DashboardPalette {
    // Backgrounds (warm taupe/brown)
    static let backgroundTop = Color(red: 0.110, green: 0.102, blue: 0.090)    // rgb(28,26,23) CXMail bg-primary
    static let backgroundBottom = Color(red: 0.086, green: 0.078, blue: 0.067) // rgb(22,20,17)
    static let panelTop = Color(red: 0.165, green: 0.153, blue: 0.133).opacity(0.96)    // rgb(42,39,34) bg-surface
    static let panelBottom = Color(red: 0.137, green: 0.125, blue: 0.110).opacity(0.98) // rgb(35,32,28) bg-sidebar

    // White-overlay surfaces read as warm-neutral over the taupe base
    static let surface = Color.white.opacity(0.06)
    static let surfaceStrong = Color.white.opacity(0.10)
    static let surfaceMuted = Color.white.opacity(0.04)

    // Warm brown strokes (rgb(74,68,57) / rgb(115,113,110))
    static let stroke = Color(red: 0.290, green: 0.267, blue: 0.224).opacity(0.60)
    static let strokeStrong = Color(red: 0.451, green: 0.443, blue: 0.431).opacity(0.55)

    static let textPrimary = Color.white.opacity(0.96)
    static let textSecondary = Color.white.opacity(0.82)   // rgb(210,208,205)
    static let textMuted = Color.white.opacity(0.60)       // rgb(155,153,150)
    static let textFaint = Color.white.opacity(0.45)

    // Accents (iOS blue + CXMail semantic)
    static let accent = Color(red: 0.039, green: 0.518, blue: 1.000)      // rgb(10,132,255) iOS blue
    static let accentBlue = Color(red: 0.039, green: 0.518, blue: 1.000)
    static let accentTeal = Color(red: 0.627, green: 0.549, blue: 0.471)  // rgb(160,140,120) CXMail ai-accent
    static let success = Color(red: 0.039, green: 0.518, blue: 1.000)     // rgb(10,132,255) iOS blue (no green in UI)
    static let warning = Color(red: 0.831, green: 0.659, blue: 0.353)     // rgb(212,168,90) warm gold
    static let danger = Color(red: 0.831, green: 0.463, blue: 0.416)      // rgb(212,118,106) warm coral
}

extension View {
    func dashboardSurface(
        cornerRadius: CGFloat = 24,
        stroke: Color = DashboardPalette.stroke,
        fillTop: Color = DashboardPalette.panelTop,
        fillBottom: Color = DashboardPalette.panelBottom,
        shadowOpacity: Double = 0.28
    ) -> some View {
        background(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [fillTop, fillBottom],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .stroke(stroke, lineWidth: 1)
        )
        .shadow(color: .black.opacity(shadowOpacity), radius: 24, x: 0, y: 14)
    }
}

struct DashboardSectionHeader: View {
    let title: String
    let icon: String
    var count: Int? = nil
    var detail: String? = nil

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(DashboardPalette.accentBlue)
                .frame(width: 26, height: 26)
                .background(DashboardPalette.surfaceStrong, in: RoundedRectangle(cornerRadius: 8, style: .continuous))

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(DashboardPalette.textPrimary)

                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(DashboardPalette.textMuted)
                }
            }

            Spacer()

            if let count {
                Text("\(count)")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(DashboardPalette.textPrimary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(DashboardPalette.surfaceStrong, in: Capsule())
            }
        }
    }
}

struct DashboardPill: View {
    let text: String
    let icon: String?
    let tint: Color

    init(_ text: String, icon: String? = nil, tint: Color = DashboardPalette.accentBlue) {
        self.text = text
        self.icon = icon
        self.tint = tint
    }

    var body: some View {
        HStack(spacing: 6) {
            if let icon {
                Image(systemName: icon)
                    .font(.caption2)
            }

            Text(text)
                .font(.system(size: 11, weight: .semibold))
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(tint.opacity(0.12), in: Capsule())
        .overlay(
            Capsule()
                .stroke(tint.opacity(0.24), lineWidth: 1)
        )
    }
}

struct DashboardMetricTile: View {
    let title: String
    let value: String
    let icon: String
    var accent: Color = DashboardPalette.accentBlue

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.caption)
                    .foregroundStyle(accent)
                    .frame(width: 26, height: 26)
                    .background(accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))

                Text(title.uppercased())
                    .font(.system(size: 10, weight: .bold))
                    .tracking(1.1)
                    .foregroundStyle(DashboardPalette.textFaint)
            }

            Text(value)
                .font(.system(size: 20, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(DashboardPalette.textPrimary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .dashboardSurface(
            cornerRadius: 18,
            stroke: DashboardPalette.stroke,
            fillTop: DashboardPalette.surfaceStrong,
            fillBottom: DashboardPalette.surfaceMuted,
            shadowOpacity: 0.18
        )
    }
}
