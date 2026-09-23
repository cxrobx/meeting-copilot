import AppKit

/// Moves the panel on the page's behalf. The dashboard covers the whole window,
/// title bar included, and WKWebView takes every click, so the page decides
/// WHERE a press is a title-bar press (`[data-drag-region]`) and posts
/// `startWindowDrag`; this decides what that press may still become.
enum WindowDrag {
    enum Action: Equatable {
        case drag
        case titleBarDoubleClick
        case none
    }

    /// The page's request lands a few ms after the mouse-down. Anything older
    /// is a press the page never asked about, and dragging from it would grab
    /// the window from where the pointer no longer is.
    static let maxPressAge: TimeInterval = 1.0

    /// `pressedAt` and `now` share a clock: `NSEvent.timestamp` and
    /// `ProcessInfo.systemUptime` both count from boot.
    static func action(clickCount: Int, pressedAt: TimeInterval, now: TimeInterval, buttonHeld: Bool) -> Action {
        let age = now - pressedAt
        guard age >= 0, age <= maxPressAge else { return .none }
        // A quick double-click can be released before the request arrives, so
        // only a drag needs the button still down.
        if clickCount == 2 { return .titleBarDoubleClick }
        return clickCount == 1 && buttonHeld ? .drag : .none
    }

    /// What a title-bar double-click does, from System Settings › Desktop & Dock
    /// ("Double-click a window's title bar to"). Unset means zoom.
    static func doubleClickAction(defaults: UserDefaults = .standard) -> DoubleClick {
        switch defaults.string(forKey: "AppleActionOnDoubleClick") {
        case "Minimize": return .minimize
        case "None": return .none
        case .some: return .zoom  // "Maximize", and "Fill" on macOS 15+
        case nil:
            // Pre-Big Sur boolean, still honored when the newer key is absent.
            return defaults.bool(forKey: "AppleMiniaturizeOnDoubleClick") ? .minimize : .zoom
        }
    }

    enum DoubleClick: Equatable {
        case zoom
        case minimize
        case none
    }

    /// Carry out the page's request for `mouseDown`, the press it was about.
    static func perform(for mouseDown: NSEvent, in window: NSWindow) {
        switch action(clickCount: mouseDown.clickCount,
                      pressedAt: mouseDown.timestamp,
                      now: ProcessInfo.processInfo.systemUptime,
                      buttonHeld: NSEvent.pressedMouseButtons & 1 != 0) {
        case .drag:
            window.performDrag(with: mouseDown)
        case .titleBarDoubleClick:
            switch doubleClickAction() {
            case .zoom: window.zoom(nil)
            case .minimize: window.miniaturize(nil)
            case .none: break
            }
        case .none:
            break
        }
    }
}
