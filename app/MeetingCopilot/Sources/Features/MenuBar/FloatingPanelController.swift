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

    // MARK: - Show Panel

    func showPanel<Content: View>(contentView: Content) {
        if let existingPanel = panel {
            existingPanel.makeKeyAndOrderFront(nil)
            return
        }

        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: defaultSize),
            styleMask: [.titled, .closable, .resizable, .utilityWindow],
            backing: .buffered,
            defer: false
        )

        panel.level = .normal
        panel.isFloatingPanel = false
        panel.hidesOnDeactivate = false
        panel.titlebarAppearsTransparent = true
        panel.title = "Meeting Copilot"
        panel.isMovableByWindowBackground = true
        panel.minSize = minSize
        panel.animationBehavior = .utilityWindow
        panel.isReleasedWhenClosed = false
        panel.appearance = NSAppearance(named: .darkAqua)

        // Use NSHostingView to embed SwiftUI content
        let hostingView = NSHostingView(rootView: contentView)
        panel.contentView = hostingView

        // Position in the bottom-right of the main screen
        positionPanel(panel)

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
        if panel.isVisible {
            panel.orderOut(nil)
        } else {
            panel.makeKeyAndOrderFront(nil)
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
}
