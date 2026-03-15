import Foundation
import UserNotifications

// MARK: - Notification Manager

/// Manages local notifications for meeting suggestions and actions.
/// Posts macOS notifications when new suggestions arrive so the user
/// doesn't have to keep the panel visible at all times.
@MainActor
final class NotificationManager: NSObject {
    static let shared = NotificationManager()

    private let center = UNUserNotificationCenter.current()
    private var hasPermission = false

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

    func postSuggestionNotification(actionTitle: String, actionType: String) {
        guard hasPermission else { return }

        let content = UNMutableNotificationContent()
        content.title = "Meeting Copilot"
        content.body = "\(actionType.capitalized): \(actionTitle)"
        content.sound = .default
        content.categoryIdentifier = "SUGGESTION"

        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil // deliver immediately
        )

        center.add(request)
    }

    func setupCategories() {
        let approveAction = UNNotificationAction(
            identifier: "APPROVE",
            title: "Approve",
            options: [.foreground]
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
    }
}
