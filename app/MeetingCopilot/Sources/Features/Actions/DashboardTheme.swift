import SwiftUI

enum DashboardPalette {
    static let backgroundTop = Color(red: 0.08, green: 0.08, blue: 0.09)
    static let backgroundBottom = Color(red: 0.02, green: 0.02, blue: 0.03)
    static let panelTop = Color(red: 0.11, green: 0.11, blue: 0.12).opacity(0.96)
    static let panelBottom = Color(red: 0.05, green: 0.05, blue: 0.06).opacity(0.98)
    static let surface = Color.white.opacity(0.06)
    static let surfaceStrong = Color.white.opacity(0.1)
    static let surfaceMuted = Color.white.opacity(0.04)
    static let stroke = Color.white.opacity(0.12)
    static let strokeStrong = Color.white.opacity(0.18)

    static let textPrimary = Color.white.opacity(0.96)
    static let textSecondary = Color.white.opacity(0.76)
    static let textMuted = Color.white.opacity(0.56)
    static let textFaint = Color.white.opacity(0.38)

    static let accent = Color(red: 0.82, green: 0.82, blue: 0.85)
    static let accentBlue = Color(red: 0.55, green: 0.74, blue: 0.96)
    static let accentTeal = Color(red: 0.47, green: 0.81, blue: 0.77)
    static let success = Color(red: 0.34, green: 0.78, blue: 0.43)
    static let warning = Color(red: 0.98, green: 0.66, blue: 0.25)
    static let danger = Color(red: 0.96, green: 0.38, blue: 0.37)
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
