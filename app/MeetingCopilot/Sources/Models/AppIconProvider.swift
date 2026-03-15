import AppKit

/// Loads the app icon from the main bundle, working in both dev (SPM) and production (.app) contexts.
enum AppIconProvider {
    static let icon: NSImage = {
        // Try PNG first (copied into .app Resources), then icns
        let candidates: [URL?] = [
            Bundle.main.url(forResource: "AppIcon", withExtension: "png"),
            Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
        ]
        for case let url? in candidates {
            if let image = NSImage(contentsOf: url) {
                return image
            }
        }
        // Dev mode: look for SPM resource bundle adjacent to the executable
        let execURL = Bundle.main.executableURL?.deletingLastPathComponent()
        if let bundleURL = execURL?.appendingPathComponent("MeetingCopilot_MeetingCopilot.bundle"),
           let bundle = Bundle(url: bundleURL),
           let url = bundle.url(forResource: "AppIcon", withExtension: "png"),
           let image = NSImage(contentsOf: url) {
            return image
        }
        return NSImage(systemSymbolName: "waveform", accessibilityDescription: "Meeting Copilot")!
    }()
}
