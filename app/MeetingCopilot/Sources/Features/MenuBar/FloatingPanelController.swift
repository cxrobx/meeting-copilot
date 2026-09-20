import AppKit
import SwiftUI

// MARK: - Keyboard Action

enum KeyboardAction {
    case approveTop
    case dismissTop
    case toggleSession
}

// MARK: - Floating Panel Controller

/// Manages the NSPanel that hosts the main Meeting Copilot UI.
/// The panel behaves like a normal window for z-order (no always-on-top)
/// but persists when the app is deactivated.
final class FloatingPanelController {
    private var panel: NSPanel?
    private let defaultSize = NSSize(width: 1280, height: 860)
    private let minSize = NSSize(width: 1040, height: 760)
    private var localMonitor: Any?

    var onKeyboardAction: ((KeyboardAction) -> Void)?

    var isVisible: Bool {
        panel?.isVisible ?? false
    }

    var hasPanel: Bool {
        panel != nil
    }

    // MARK: - Show Panel

    func showPanel<Content: View>(contentView: Content) {
        if let existingPanel = panel {
            // A display change (unplugged monitor, resolution switch) can
            // leave the remembered frame off-screen — clamp before fronting.
            clampToVisibleScreen(existingPanel)
            existingPanel.makeKeyAndOrderFront(nil)
            return
        }

        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: defaultSize),
            // .fullSizeContentView puts the web dashboard under the titlebar so
            // the page paints edge to edge — without it a transparent titlebar
            // still reserves a 19pt strip that draws the window's own (dark)
            // background above a cream page, which is the black band the app
            // used to wear. The page clears that strip itself: see the
            // `.native` header rules in server/src/present.
            styleMask: [.titled, .closable, .resizable, .utilityWindow, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        panel.level = .normal
        panel.isFloatingPanel = false
        panel.hidesOnDeactivate = false
        panel.titlebarAppearsTransparent = true
        panel.titleVisibility = .hidden
        panel.title = "Meeting Copilot"
        panel.isMovableByWindowBackground = true
        panel.minSize = minSize
        panel.animationBehavior = .utilityWindow
        panel.isReleasedWhenClosed = false
        // Dark until the page says otherwise — the dashboard reports its theme
        // (and the vault look's mode) through the bridge, so the traffic lights
        // and any native chrome match the palette the page is actually wearing.
        panel.appearance = NSAppearance(named: .darkAqua)
        // Without .moveToActiveSpace, re-fronting a panel that lives on
        // another Space happens invisibly over there — the menubar toggle
        // looks dead. .fullScreenAuxiliary lets it join fullscreen Spaces
        // (meetings often run fullscreen).
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]

        // Use NSHostingView to embed SwiftUI content
        let hostingView = NSHostingView(rootView: contentView)
        panel.contentView = hostingView

        // Position in the bottom-right of the main screen
        positionPanel(panel)
        clampToVisibleScreen(panel)

        panel.makeKeyAndOrderFront(nil)
        self.panel = panel

        // Register local keyboard event monitor
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self else { return event }
            return self.handleKeyEvent(event)
        }
    }

    // MARK: - Toggle

    func toggle() {
        guard let panel = panel else { return }
        if panel.isVisible && panel.isOnActiveSpace {
            panel.orderOut(nil)
        } else {
            // Hidden — or open on a different Space, which reads as hidden.
            // An accessory app's window won't come forward (or pull to the
            // current Space) without explicit activation.
            clampToVisibleScreen(panel)
            panel.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    // MARK: - Close

    func close() {
        panel?.orderOut(nil)
        if let monitor = localMonitor {
            NSEvent.removeMonitor(monitor)
            localMonitor = nil
        }
    }

    // MARK: - Keyboard Handling

    private func handleKeyEvent(_ event: NSEvent) -> NSEvent? {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let chars = event.charactersIgnoringModifiers ?? ""

        // Esc — hide panel
        if event.keyCode == 53 {
            toggle()
            return nil
        }

        // Cmd+Enter — approve top suggestion
        if modifiers == .command && event.keyCode == 36 {
            onKeyboardAction?(.approveTop)
            return nil
        }

        // Cmd+D — dismiss top suggestion
        if modifiers == .command && chars == "d" {
            onKeyboardAction?(.dismissTop)
            return nil
        }

        // Cmd+Shift+S — toggle session
        if modifiers == [.command, .shift] && chars == "s" {
            onKeyboardAction?(.toggleSession)
            return nil
        }

        return event
    }

    // MARK: - Positioning

    private func positionPanel(_ panel: NSPanel) {
        guard let screen = NSScreen.main else { return }
        let screenFrame = screen.visibleFrame
        let panelFrame = panel.frame

        let x = screenFrame.maxX - panelFrame.width - 20
        let y = screenFrame.minY + 20

        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    /// Keep the panel fully inside the visible screen bounds — the min size
    /// (1040×760) plus a fixed bottom-right origin can otherwise push it
    /// partially off small laptop displays or after a display change.
    private func clampToVisibleScreen(_ panel: NSPanel) {
        guard let screen = panel.screen ?? NSScreen.main else { return }
        let visible = screen.visibleFrame
        var frame = panel.frame

        frame.size.width = min(frame.size.width, visible.width)
        frame.size.height = min(frame.size.height, visible.height)
        frame.origin.x = max(visible.minX, min(frame.origin.x, visible.maxX - frame.width))
        frame.origin.y = max(visible.minY, min(frame.origin.y, visible.maxY - frame.height))

        if frame != panel.frame {
            panel.setFrame(frame, display: true)
        }
    }
}
