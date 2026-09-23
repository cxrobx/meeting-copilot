import AppKit
import SwiftUI

// MARK: - Menu Bar Theme

/// The popover's palette. Two sources, the same two the dashboard has:
///
/// - **vault** — the Obsidian vault's palette as Onyx derives it, read from
///   `GET /present/vault-look` (`tokens`, already mapped into the dashboard's
///   token names by `present/vault-look.ts`). Worn while "Match vault
///   appearance" is on. Flat and opaque, like the vault itself.
/// - **cx** — the CX family palette CXNotes wears, over the window's glass.
///   The fallback whenever the switch is off, Onyx is down and nothing is
///   cached, or a token fails to parse.
///
/// As on the dashboard, the vault only overrides surfaces, text, lines, the
/// accent and the font. The status colours and the record red stay the
/// app's own, picked by the vault's light/dark mode.
struct MenuBarTheme: Equatable {
    var isDark: Bool
    /// Glass (CX) paints its surfaces translucent over the window material;
    /// the vault is flat, and any see-through would tint its ground.
    var translucent: Bool

    var ground: Color
    var chrome: Color
    var card: Color
    var input: Color
    var border: Color
    var borderSubtle: Color

    var textPrimary: Color
    var textSecondary: Color
    var textMuted: Color
    var textSubtle: Color

    var accent: Color
    var accentHover: Color
    /// The ink on an accent FILL (primary button). Chosen server-side by contrast.
    var accentInk: Color

    var success: Color
    var warning: Color
    var danger: Color
    /// The ink on a danger fill (Stop session).
    var dangerInk: Color
    /// The record disc — deliberately not `danger`, so start and stop never
    /// read as the same control.
    var record: Color = Color(r: 229, g: 72, b: 77)

    /// A family name to set every string in (the vault's interface font), or
    /// nil for the system font.
    var fontFamily: String?

    // MARK: Fonts

    /// JetBrains Mono sets wider than SF at the same point size, so the vault
    /// face runs a touch smaller to keep the CXNotes proportions.
    private var sizeScale: CGFloat { fontFamily == nil ? 1 : 0.93 }

    func font(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        guard let family = fontFamily else { return .system(size: size, weight: weight) }
        return .custom(family, size: size * sizeScale).weight(Self.cssWeight(weight))
    }

    /// Numbers and chips: the vault face if it has one (JetBrains Mono is
    /// already mono), else SF Mono.
    func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        guard let family = fontFamily else { return .system(size: size, weight: weight, design: .monospaced) }
        return .custom(family, size: size * sizeScale).weight(Self.cssWeight(weight))
    }

    /// A vault face usually ships Regular and Bold only (JetBrains Mono here).
    /// SwiftUI rounds medium UP to Bold; CSS rounds 500 DOWN to Regular — so
    /// follow CSS, or every medium label reads heavier than the dashboard's.
    static func cssWeight(_ weight: Font.Weight) -> Font.Weight {
        [.semibold, .bold, .heavy, .black].contains(weight) ? .bold : .regular
    }

    // MARK: Surfaces

    var groundFill: Color { ground.opacity(translucent ? 0.8 : 1) }
    var chromeFill: Color { chrome.opacity(translucent ? 0.92 : 1) }
    var cardFill: Color { card.opacity(translucent ? 0.9 : 1) }
    /// Hover wash on rows and icon buttons: toward the ink, whatever the mode.
    var hoverWash: Color { textPrimary.opacity(isDark ? 0.08 : 0.07) }
    var buttonFill: Color { textPrimary.opacity(isDark ? 0.07 : 0.05) }
    var buttonFillHover: Color { textPrimary.opacity(isDark ? 0.13 : 0.1) }

    // MARK: Warning box (opaque on purpose: a warning that dissolves into the
    // wallpaper defeats itself)

    var warningBoxFill: Color { isDark ? Color(r: 74, g: 32, b: 28) : Color(r: 253, g: 236, b: 232) }
    var warningBoxStroke: Color { isDark ? Color(r: 150, g: 68, b: 58) : Color(r: 222, g: 160, b: 148) }
    var warningBoxTitle: Color { isDark ? Color(r: 255, g: 226, b: 220) : Color(r: 110, g: 30, b: 20) }
    var warningBoxText: Color { isDark ? Color(r: 240, g: 198, b: 190) : Color(r: 130, g: 50, b: 38) }
}

// MARK: - Palettes

extension MenuBarTheme {
    /// CXNotes' panel palette (renderer/menubar-panel.html).
    static let cx = MenuBarTheme(
        isDark: true,
        translucent: true,
        ground: Color(r: 30, g: 28, b: 25),
        chrome: Color(r: 46, g: 43, b: 38),
        card: Color(r: 26, g: 24, b: 21),
        input: Color(r: 26, g: 24, b: 21),
        border: Color.white.opacity(0.12),
        borderSubtle: Color.white.opacity(0.08),
        textPrimary: .white,
        textSecondary: Color(r: 222, g: 220, b: 217),
        textMuted: Color(r: 182, g: 179, b: 175),
        textSubtle: Color(r: 150, g: 147, b: 143),
        accent: Color(r: 10, g: 132, b: 255),
        accentHover: Color(r: 8, g: 106, b: 204),
        accentInk: .white,
        success: Color(r: 143, g: 179, b: 136),
        warning: Color(r: 212, g: 168, b: 90),
        danger: Color(r: 212, g: 118, b: 106),
        dangerInk: Color(r: 38, g: 18, b: 15),
        fontFamily: nil
    )

    /// The vault palette from `/present/vault-look`'s `tokens`, or nil when
    /// any colour the popover needs is missing or malformed — never a
    /// half-applied theme.
    static func vault(tokens: [String: String], mode: String) -> MenuBarTheme? {
        func rgb(_ name: String) -> [Double]? {
            guard let value = tokens[name] else { return nil }
            let parts = value.split(separator: " ").compactMap { Int($0) }
            guard parts.count == 3, parts.allSatisfy({ (0...255).contains($0) }) else { return nil }
            return parts.map(Double.init)
        }
        func color(_ name: String) -> Color? {
            rgb(name).map(Color.init(rgb:))
        }
        guard let ground = color("bg-primary"),
              let elevated = color("bg-elevated"),
              let surface = color("bg-surface"),
              let input = color("bg-input"),
              let border = color("border-default"),
              let borderSubtle = color("border-subtle"),
              let ink = rgb("text-primary"),
              let secondary = rgb("text-secondary"),
              let muted = rgb("text-muted"),
              color("text-faint") != nil,
              let accent = color("accent"),
              let accentHover = color("accent-hover"),
              let accentInk = color("accent-ink") else { return nil }

        let dark = mode != "light"
        return MenuBarTheme(
            isDark: dark,
            translucent: false,
            ground: ground,
            // Header and footer are chrome laid OVER the work, so they take the
            // raised surface; cards are wells cut into the ground.
            chrome: elevated,
            card: surface,
            input: input,
            border: border,
            borderSubtle: borderSubtle,
            // The vault's inks step much further apart than CXNotes' four
            // (196/152/106/79 against 255/222/182/150), so the popover's
            // in-between steps are mixed from them: body text stays near the
            // ink, and the 10.5pt meta lines never drop to the faint step,
            // which the vault keeps for disabled text.
            textPrimary: Color(rgb: ink),
            textSecondary: Color(rgb: mix(ink, secondary, 0.4)),
            textMuted: Color(rgb: secondary),
            textSubtle: Color(rgb: mix(secondary, muted, 0.5)),
            accent: accent,
            accentHover: accentHover,
            accentInk: accentInk,
            // The dashboard's own semantics for this mode (present/index.ts
            // [data-theme] blocks) — the vault has no opinion about them.
            success: dark ? Color(r: 143, g: 179, b: 136) : Color(r: 125, g: 155, b: 118),
            warning: dark ? Color(r: 212, g: 168, b: 90) : Color(r: 196, g: 146, b: 58),
            danger: dark ? Color(r: 212, g: 118, b: 106) : Color(r: 196, g: 92, b: 74),
            dangerInk: dark ? Color(r: 38, g: 18, b: 15) : .white,
            fontFamily: installedFamily(from: tokens["font-sans"])
        )
    }

    /// The first family in a CSS font stack that is installed on this Mac.
    /// Generic names (`ui-sans-serif`, `system-ui`, …) mean the system font.
    static func installedFamily(from stack: String?) -> String? {
        guard let stack else { return nil }
        let installed = Set(NSFontManager.shared.availableFontFamilies)
        for raw in stack.split(separator: ",") {
            let name = raw.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            if name.hasPrefix("-") || name.hasPrefix("ui-") || name.contains("system-ui") || name == "sans-serif" {
                return nil
            }
            if installed.contains(name) { return name }
        }
        return nil
    }
}

// MARK: - Environment

private struct MenuBarThemeKey: EnvironmentKey {
    static let defaultValue = MenuBarTheme.cx
}

extension EnvironmentValues {
    var menuBarTheme: MenuBarTheme {
        get { self[MenuBarThemeKey.self] }
        set { self[MenuBarThemeKey.self] = newValue }
    }
}

private func mix(_ a: [Double], _ b: [Double], _ t: Double) -> [Double] {
    zip(a, b).map { $0 + ($1 - $0) * t }
}

extension Color {
    init(r: Int, g: Int, b: Int) {
        self.init(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255)
    }

    init(rgb: [Double]) {
        self.init(red: rgb[0] / 255, green: rgb[1] / 255, blue: rgb[2] / 255)
    }
}
