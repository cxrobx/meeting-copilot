import Foundation
import UserNotifications

// MARK: - Notification Manager

/// What the user did on a suggestion banner.
enum SuggestionNotificationAction {
    case approve(String)
    case dismiss(String)
    case open
}

/// Manages local notifications for meeting suggestions and actions.
/// Posts macOS notifications when new suggestions arrive so the user
/// doesn't have to keep the panel visible at all times. Acts as the
/// UNUserNotificationCenter delegate so the banner's Approve/Dismiss
/// buttons actually route back into the session.
@MainActor
final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()

    private let center = UNUserNotificationCenter.current()
    private var hasPermission = false
    private var lastBannerAt: Date?

    /// Wired by AppDelegate: routes banner actions to SessionManager.
    var onAction: ((SuggestionNotificationAction) -> Void)?
    /// Wired by AppDelegate: false when the panel is visible and the app is
    /// active — no point bannering something already on screen.
    var shouldPresentBanner: (() -> Bool)?

    /// Minimum spacing between audible banners. Suggestions arriving faster
    /// still post (grouped under the same thread) but without sound.
    private let bannerSoundSpacing: TimeInterval = 60

    private override init() {
        super.init()
    }

    func requestPermission() {
        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            Task { @MainActor in
                self.hasPermission = granted
            }
        }
    }

    func postSuggestionNotification(actionId: String, actionTitle: String, actionType: String) {
        guard hasPermission else { return }
        if let gate = shouldPresentBanner, !gate() { return }

        let content = UNMutableNotificationContent()
        content.title = "Meeting Copilot"
        content.body = "\(actionType.capitalized): \(actionTitle)"
        content.categoryIdentifier = "SUGGESTION"
        content.threadIdentifier = "suggestions"
        content.userInfo = ["actionId": actionId]

        // Coalesce: rapid-fire suggestions group silently instead of dinging
        // every 15s triage cycle.
        let now = Date()
        if lastBannerAt == nil || now.timeIntervalSince(lastBannerAt!) >= bannerSoundSpacing {
            content.sound = .default
            lastBannerAt = now
        }

        let request = UNNotificationRequest(
            identifier: "suggestion-\(actionId)",
            content: content,
            trigger: nil // deliver immediately
        )

        center.add(request)
    }

    /// Remove a suggestion's banner once it is actioned or expires — a stale
    /// Approve button that silently no-ops is worse than no banner.
    func clearSuggestionNotification(actionId: String) {
        center.removeDeliveredNotifications(withIdentifiers: ["suggestion-\(actionId)"])
        center.removePendingNotificationRequests(withIdentifiers: ["suggestion-\(actionId)"])
    }

    /// The meeting pulse's close-out pass: what to settle before the call ends.
    /// One banner at a time (a newer close-out replaces the older), and it
    /// respects the panel-visible gate like suggestions do. Tapping it opens
    /// the panel, where the full list is.
    func postCloseOutNotification(body: String) {
        guard hasPermission else { return }
        if let gate = shouldPresentBanner, !gate() { return }

        let content = UNMutableNotificationContent()
        content.title = "Before this call ends"
        content.body = body
        content.sound = .default
        content.threadIdentifier = "pulse"

        let request = UNNotificationRequest(
            identifier: "pulse-closeout",
            content: content,
            trigger: nil
        )
        center.add(request)
    }

    /// Your mic has stopped reaching the meeting. Deliberately NOT gated on
    /// the panel being in front, and with sound: a live meeting without your
    /// side is the failure this app exists to prevent (2026-09-25). Cleared
    /// when the mic recovers.
    func postMicDeadNotification(body: String) {
        guard hasPermission else { return }
        let content = UNMutableNotificationContent()
        content.title = "Your mic isn't being heard"
        content.body = body
        content.sound = .default
        content.threadIdentifier = "capture"
        center.add(UNNotificationRequest(identifier: "mic-dead", content: content, trigger: nil))
    }

    func clearMicDeadNotification() {
        center.removeDeliveredNotifications(withIdentifiers: ["mic-dead"])
    }

    /// One of the coach's questions, asked from a button or a ⌃⌥ hotkey. One
    /// banner per question: the answer replaces the "Reading the meeting…"
    /// banner. Silent, unlike the close-out: the meeting track taps system
    /// audio, and the person who asked is already watching for it. Skipped
    /// while the dashboard is in front, where the answer shows anyway.
    func postAskNotification(_ ask: AskState) {
        guard hasPermission else { return }
        let identifier = "ask-\(ask.kind)"
        if let gate = shouldPresentBanner, !gate() {
            center.removeDeliveredNotifications(withIdentifiers: [identifier])
            return
        }
        // Suggest answers in seconds; a "started" banner would only flash.
        if ask.phase == "started" && ask.kind == "suggest" { return }
        guard let title = ask.title, !title.isEmpty else { return }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = ask.body ?? ""
        content.threadIdentifier = "coach"
        center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
    }

    /// Session end: a "Reading the meeting…" banner will never be answered.
    func clearAskNotifications() {
        let identifiers = ["checkin", "missed", "suggest", "wrapup"].map { "ask-\($0)" }
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    /// Fires when the supervisor has exhausted its automatic restart budget.
    /// Surfaces to the user via macOS Notification Center so they know to
    /// check logs / quit-and-relaunch — otherwise the failure is silent.
    func postServerCrashLoopNotification() {
        guard hasPermission else {
            // Fall back to appLog — stderr is NOT redirected to app.log in this
            // app (see gotcha #15). Using stderr here would make a crash-loop
            // failure effectively invisible if notifications aren't authorized.
            appLog("[NotificationManager] Server crash loop — notifications not authorized, no user alert")
            return
        }

        let content = UNMutableNotificationContent()
        content.title = "Meeting Copilot: server keeps crashing"
        content.body = "Automatic restart gave up after multiple failures. Quit and relaunch the app, or check ~/.meeting-copilot/server.log."
        content.sound = .default
        content.categoryIdentifier = "SERVER_CRASH"

        let request = UNNotificationRequest(
            identifier: "meeting-copilot.server-crash-loop",
            content: content,
            trigger: nil
        )
        center.add(request)
    }

    func setupCategories() {
        // Approve deliberately has NO .foreground option — approving from a
        // banner must not steal focus mid-meeting. Tapping the banner body
        // (default action) is the "open the panel" gesture.
        let approveAction = UNNotificationAction(
            identifier: "APPROVE",
            title: "Approve",
            options: []
        )
        let dismissAction = UNNotificationAction(
            identifier: "DISMISS",
            title: "Dismiss",
            options: [.destructive]
        )

        let category = UNNotificationCategory(
            identifier: "SUGGESTION",
            actions: [approveAction, dismissAction],
            intentIdentifiers: []
        )

        center.setNotificationCategories([category])
        center.delegate = self
    }

    // MARK: - UNUserNotificationCenterDelegate
    // Delegate callbacks arrive on arbitrary queues; extract what we need,
    // then hop to the main actor to touch state.

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let identifier = response.actionIdentifier
        let actionId = response.notification.request.content.userInfo["actionId"] as? String

        Task { @MainActor in
            switch identifier {
            case "APPROVE":
                if let id = actionId { NotificationManager.shared.onAction?(.approve(id)) }
            case "DISMISS":
                if let id = actionId { NotificationManager.shared.onAction?(.dismiss(id)) }
            case UNNotificationDefaultActionIdentifier:
                // Banner body tap — open the panel (suggestions AND the
                // crash-loop alert both want eyes on the app).
                NotificationManager.shared.onAction?(.open)
            default:
                break
            }
            completionHandler()
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // Show banners even while the app is frontmost — the "panel already
        // visible" gate runs before posting, so anything that got here was
        // deliberately posted.
        completionHandler([.banner, .sound])
    }
}
