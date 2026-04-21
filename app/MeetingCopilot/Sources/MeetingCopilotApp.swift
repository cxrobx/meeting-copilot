import SwiftUI
import AppKit

// MARK: - App Entry Point

@main
struct MeetingCopilotApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // MenuBarExtra provides the menubar icon and popover
        MenuBarExtra {
            MenuBarView(
                sessionManager: appDelegate.sessionManager,
                onTogglePanel: { appDelegate.togglePanel() },
                onQuit: { NSApplication.shared.terminate(nil) }
            )
        } label: {
            MenuBarLabel(sessionManager: appDelegate.sessionManager)
        }
        .menuBarExtraStyle(.window)

        // Settings window
        Settings {
            SettingsView()
        }
    }
}

// MARK: - Menu Bar Label

/// The menubar icon that changes based on session state.
struct MenuBarLabel: View {
    let sessionManager: SessionManager

    var body: some View {
        Group {
            switch sessionManager.state {
            case .live:
                HStack(spacing: 4) {
                    menuBarGhost
                    Circle()
                        .fill(.red)
                        .frame(width: 6, height: 6)
                }
            case .degraded:
                HStack(spacing: 4) {
                    menuBarGhost
                    Circle()
                        .fill(.orange)
                        .frame(width: 6, height: 6)
                }
            case .priming, .ending:
                menuBarGhost
                    .opacity(0.5)
            case .error:
                Image(systemName: "exclamationmark.triangle")
            default:
                menuBarGhost
            }
        }
    }

    private var menuBarGhost: some View {
        Image(nsImage: Self.ghostIcon)
    }

    private static let ghostIcon: NSImage = {
        // Try app bundle's Resources first (production .app), then SPM module bundle (dev)
        let candidates: [URL?] = [
            Bundle.main.url(forResource: "AppIcon", withExtension: "png"),
            Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
        ]
        for case let url? in candidates {
            if let image = NSImage(contentsOf: url) {
                image.size = NSSize(width: 22, height: 22)
                image.isTemplate = false
                return image
            }
        }
        return NSImage(systemSymbolName: "waveform", accessibilityDescription: "Meeting Copilot")!
    }()
}

// MARK: - App Delegate

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let sessionManager = SessionManager()
    private let floatingPanelController = FloatingPanelController()
    private var hasShownPermissions = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Set as accessory app (no Dock icon)
        NSApplication.shared.setActivationPolicy(.accessory)

        // Kill any orphaned processes from previous launches
        sessionManager.processSupervisor.cleanupOrphans()

        // Start the Node.js server and whisper-server processes
        sessionManager.processSupervisor.startServer()
        sessionManager.processSupervisor.startWhisper()

        // Poll until server is ready
        sessionManager.waitForServer()

        // Sync saved retention setting to server once it's ready
        syncRetentionToServer()

        // Set up notifications
        NotificationManager.shared.setupCategories()
        NotificationManager.shared.requestPermission()

        // Show floating panel with main content
        showPanel()

        // Set up keyboard action callback on floating panel
        floatingPanelController.onKeyboardAction = { [weak self] action in
            guard let self = self else { return }
            switch action {
            case .approveTop:
                if let topSuggestion = self.sessionManager.suggestedActions.first {
                    self.sessionManager.approveAction(id: topSuggestion.id)
                }
            case .dismissTop:
                if let topSuggestion = self.sessionManager.suggestedActions.first {
                    self.sessionManager.dismissAction(id: topSuggestion.id)
                }
            case .exportSession:
                // Export will be handled elsewhere
                break
            case .toggleSession:
                if self.sessionManager.state == .idle || self.sessionManager.state == .archived {
                    self.sessionManager.requestStartSession()
                } else if self.sessionManager.state == .live || self.sessionManager.state == .degraded {
                    self.sessionManager.stopSession()
                }
            }
        }

        // Global hotkey: Cmd+Shift+M to toggle panel
        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.modifierFlags.contains([.command, .shift]) && event.charactersIgnoringModifiers == "m" {
                Task { @MainActor in
                    self?.togglePanel()
                }
            }
        }

        // Check if first launch - show permissions
        if !UserDefaults.standard.bool(forKey: "hasCompletedOnboarding") {
            showPermissionsWindow()
        }
    }

    /// Push the persisted retention value to the server so it survives server restarts.
    private func syncRetentionToServer() {
        let days = UserDefaults.standard.double(forKey: "sessionRetentionDays")
        guard days >= 7 else { return } // Not yet configured or invalid
        guard let url = URL(string: "http://localhost:17890/settings") else { return }

        // Retry a few times — the server may still be starting up
        Task.detached {
            for attempt in 0..<5 {
                if attempt > 0 {
                    try? await Task.sleep(nanoseconds: 2_000_000_000) // 2s between retries
                }
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try? JSONEncoder().encode(["retentionDays": Int(days)])
                if let (_, response) = try? await URLSession.shared.data(for: request),
                   (response as? HTTPURLResponse)?.statusCode == 200 {
                    return // Success
                }
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Graceful shutdown
        Task {
            if sessionManager.state == .live || sessionManager.state == .degraded {
                sessionManager.stopSession()
            }
            await sessionManager.processSupervisor.stopAll()
        }
    }

    // MARK: - Panel Management

    func showPanel() {
        // Web dashboard — loads the Gruvbox-themed /present page in a WKWebView.
        // The web UI handles session control, transcript, approvals, and action results.
        let panelContent = WebDashboardView(sessionManager: sessionManager)

        // NOTE: To restore the native SwiftUI panel, uncomment below and comment out the WebDashboardView line above:
        // let panelContent = ActionPanelView(sessionManager: sessionManager)
        //     .sheet(isPresented: Binding(
        //         get: { self.sessionManager.showingConsentDialog },
        //         set: { _ in }
        //     )) {
        //         ConsentView(
        //             sessionManager: self.sessionManager,
        //             onConsent: { self.sessionManager.consentGranted() },
        //             onCancel: { self.sessionManager.consentDenied() }
        //         )
        //     }

        floatingPanelController.showPanel(contentView: panelContent)
    }

    func togglePanel() {
        if floatingPanelController.isVisible {
            floatingPanelController.toggle()
        } else {
            showPanel()
        }
    }

    // MARK: - Permissions

    private func showPermissionsWindow() {
        guard !hasShownPermissions else { return }
        hasShownPermissions = true

        let permissionsWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 500),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        permissionsWindow.title = "Meeting Copilot Setup"
        permissionsWindow.center()
        permissionsWindow.isReleasedWhenClosed = false

        let permissionsView = PermissionsView {
            UserDefaults.standard.set(true, forKey: "hasCompletedOnboarding")
            permissionsWindow.close()
        }

        permissionsWindow.contentView = NSHostingView(rootView: permissionsView)
        permissionsWindow.makeKeyAndOrderFront(nil)
    }
}
