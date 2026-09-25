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
                feed: appDelegate.menuBarFeed,
                actions: appDelegate.menuBarActions
            )
        } label: {
            MenuBarLabel(sessionManager: appDelegate.sessionManager)
        }
        .menuBarExtraStyle(.window)
        // Settings live in the web dashboard (gear icon) — the native Settings
        // scene was unreachable in an LSUIElement app (no app menu → no ⌘,).
    }
}

// MARK: - Menu Bar Label

/// The menubar icon that changes based on session state.
struct MenuBarLabel: View {
    let sessionManager: SessionManager

    var body: some View {
        Group {
            switch sessionManager.state {
            case .live where sessionManager.micDead, .degraded where sessionManager.micDead:
                // Your side isn't being heard: this has to be impossible to
                // miss, so it replaces the REC timer until the mic recovers.
                HStack(spacing: 4) {
                    menuBarGhost
                    Image(systemName: "mic.slash.fill")
                    Text("NO MIC")
                        .font(.system(size: 11, weight: .bold, design: .monospaced))
                }
                .foregroundStyle(.yellow)
            case .live:
                // The persistent recording cue (privacy requirement): the old
                // 6px dot was easy to miss and the panel is not always-on-top.
                // "REC + ticking timer" is unambiguous even in monochrome
                // menubar rendering. sessionElapsedTime already ticks 1/s, so
                // the label re-renders for free via @Observable.
                recLabel(color: .red)
            case .degraded:
                // Degraded is STILL recording — must not look stopped.
                recLabel(color: .orange)
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

    private func recLabel(color: Color) -> some View {
        HStack(spacing: 4) {
            menuBarGhost
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text("REC \(Self.elapsedText(sessionManager.sessionElapsedTime))")
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .monospacedDigit()
                .foregroundStyle(color)
        }
    }

    private static func elapsedText(_ interval: TimeInterval) -> String {
        let hours = Int(interval) / 3600
        let minutes = (Int(interval) % 3600) / 60
        let seconds = Int(interval) % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, seconds)
        }
        return String(format: "%d:%02d", minutes, seconds)
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
    let menuBarFeed = MenuBarFeed()
    private let floatingPanelController = FloatingPanelController()
    private let coachHotkeys = CoachHotkeys()
    private var hasShownPermissions = false
    private var terminationInProgress = false

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

        // Set up notifications — including routing banner Approve/Dismiss taps
        // back into the session, and suppressing banners while the panel is
        // already on screen.
        NotificationManager.shared.setupCategories()
        NotificationManager.shared.requestPermission()
        NotificationManager.shared.onAction = { [weak self] action in
            guard let self = self else { return }
            switch action {
            case .approve(let id):
                self.sessionManager.approveAction(id: id)
            case .dismiss(let id):
                self.sessionManager.dismissAction(id: id)
            case .open:
                self.showPanel()
                NSApp.activate(ignoringOtherApps: true)
            }
        }
        NotificationManager.shared.shouldPresentBanner = { [weak self] in
            guard let self = self else { return true }
            return !(self.floatingPanelController.isVisible && NSApp.isActive)
        }

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
            case .toggleSession:
                if self.sessionManager.state == .idle || self.sessionManager.state == .archived {
                    // The web start form owns session setup — front it.
                    self.showPanelAndFocusStart()
                } else if self.sessionManager.state == .live || self.sessionManager.state == .degraded {
                    self.sessionManager.stopSession()
                }
            }
        }

        // Global hotkey: Cmd+Shift+M to toggle panel. Global key monitoring
        // only receives events when the app has Accessibility trust — without
        // it the hotkey silently works ONLY while a Copilot window is focused
        // (the panel's local monitor). Log the truth instead of failing mute;
        // PermissionsView offers the grant as an optional step. No forced
        // prompt — a meeting tool must not nag.
        NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.modifierFlags.contains([.command, .shift]) && event.charactersIgnoringModifiers == "m" {
                Task { @MainActor in
                    self?.togglePanel()
                }
            }
        }
        if !AXIsProcessTrusted() {
            appLog("[Hotkey] ⌘⇧M works only while the app is focused — grant Accessibility (System Settings → Privacy & Security → Accessibility) for the global hotkey")
        }

        // ⌃⌥1/2/3: the coach's questions from any app, held only while a
        // meeting is live (see CoachHotkeys for why Carbon, and why ⌃).
        coachHotkeys.onPress = { [weak self] ask in
            guard let self = self else { return }
            appLog("[Hotkey] \(ask.chord) \(ask.label)")
            Task { @MainActor in
                if !(await self.sessionManager.askCoach(ask)) {
                    // The only feedback possible from inside another app.
                    NSSound.beep()
                }
            }
        }
        sessionManager.onMeetingLiveChanged = { [weak self] live in
            guard let self = self else { return }
            if live {
                let failed = self.coachHotkeys.register()
                if failed.isEmpty {
                    appLog("[Hotkey] ⌃⌥1/2/3 registered for the meeting")
                }
                for (ask, status) in failed {
                    appLog("[Hotkey] \(ask.chord) not registered (status \(status)): another app holds it")
                    self.sessionManager.surfaceError("\(ask.chord) is taken by another app. Use the \(ask.label) button in the coach bar.")
                }
            } else if self.coachHotkeys.isRegistered {
                self.coachHotkeys.unregister()
                NotificationManager.shared.clearAskNotifications()
                appLog("[Hotkey] ⌃⌥1/2/3 released")
            }
        }

        // Check if first launch - show permissions
        if !UserDefaults.standard.bool(forKey: "hasCompletedOnboarding") {
            showPermissionsWindow()
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminationInProgress else { return .terminateLater }
        terminationInProgress = true
        // Keep the application alive until its async child cleanup completes.
        // A Task launched from applicationWillTerminate is abandoned as soon as
        // AppKit exits the process, which was leaving Node/Parakeet orphaned.
        Task { @MainActor in
            if sessionManager.state == .live || sessionManager.state == .degraded {
                sessionManager.stopSession()
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
            await sessionManager.processSupervisor.stopAll()
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    // MARK: - Panel Management

    func showPanel() {
        // Web dashboard — loads the Gruvbox-themed /present page in a WKWebView.
        // The web UI handles session control, transcript, approvals, and action results.
        let panelContent = WebDashboardView(sessionManager: sessionManager)
        floatingPanelController.showPanel(contentView: panelContent)
    }

    func togglePanel() {
        if floatingPanelController.hasPanel {
            // toggle() hides when visible on the current Space, otherwise
            // fronts + activates + pulls to this Space.
            floatingPanelController.toggle()
        } else {
            showPanel()
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    /// Menubar "Start Session" / ⌘⇧S while idle: the web start form owns
    /// title, agenda, projects, and context, so front the panel and put the
    /// caret in the form instead of starting with an empty payload.
    func showPanelAndFocusStart() {
        showPanelAndRun("start")
    }

    /// Front the panel, then hand the dashboard a menu bar command
    /// (`SessionManager.runDashboardCommand`).
    private func showPanelAndRun(_ command: String, _ argument: String? = nil) {
        showPanel()
        // The web view must be in the key window for .focus() to take.
        NSApp.activate(ignoringOtherApps: true)
        sessionManager.runDashboardCommand(command, argument)
    }

    var menuBarActions: MenuBarActions {
        MenuBarActions(
            startSession: { [weak self] in self?.showPanelAndFocusStart() },
            setUpInvite: { [weak self] key in self?.showPanelAndRun("invite", key) },
            openSession: { [weak self] id in self?.showPanelAndRun("session", id) },
            openHistory: { [weak self] in self?.showPanelAndRun("history") },
            togglePanel: { [weak self] in self?.togglePanel() },
            openChat: { [weak self] in self?.showPanelAndRun("chat") },
            openSettings: { [weak self] in self?.showPanelAndRun("settings") },
            openNotesFolder: {
                // Summaries are filed here when auto-save is on (workers/summary.ts).
                Self.openFolder("~/Documents/CX/Meetings", fallback: "~/Documents/CX")
            },
            quit: { NSApplication.shared.terminate(nil) }
        )
    }

    private static func openFolder(_ path: String, fallback: String? = nil) {
        let expanded = NSString(string: path).expandingTildeInPath
        if FileManager.default.fileExists(atPath: expanded) {
            NSWorkspace.shared.open(URL(fileURLWithPath: expanded, isDirectory: true))
        } else if let fallback {
            openFolder(fallback)
        } else {
            appLog("[MenuBar] Folder not found: \(expanded)")
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
