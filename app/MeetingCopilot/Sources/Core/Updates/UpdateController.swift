import AppKit
import Foundation
import Sparkle

// MARK: - Policy

/// The rules that keep Sparkle out of meetings, apart from Sparkle so the
/// tests can hold them (UpdatePolicyTests).
enum UpdatePolicy {
    /// A background check that finds an update opens a window, which must
    /// never land on a shared screen mid-meeting. A check the user asks for
    /// always runs.
    static func mayCheck(userInitiated: Bool, inMeeting: Bool) -> Bool {
        userInitiated || !inMeeting
    }

    /// Installing quits the app, and quitting ends the session
    /// (applicationShouldTerminate), so an update waits for the meeting.
    static func postponeInstall(inMeeting: Bool) -> Bool {
        inMeeting
    }

    /// Work the server is still doing for a meeting that has just ended (its
    /// summary and review run after the session stops). Quitting kills the
    /// server, so a held install waits for this to reach zero. Reads
    /// `workers.byState` from GET /debug.
    static func busyWorkers(debugJSON: Data) -> Int? {
        guard let root = try? JSONSerialization.jsonObject(with: debugJSON) as? [String: Any],
              let workers = root["workers"] as? [String: Any],
              let byState = workers["byState"] as? [String: Any] else { return nil }
        return ["approved", "queued", "running"].reduce(0) { total, state in
            total + ((byState[state] as? NSNumber)?.intValue ?? 0)
        }
    }

    /// How long a held install waits for that work before going ahead anyway.
    static let closeOutWaitLimit: TimeInterval = 15 * 60
}

// MARK: - Controller

/// Sparkle 2: checks the appcast named by SUFeedURL once a day and from the
/// menu bar's Updates button, verifies the archive's EdDSA signature against
/// SUPublicEDKey before extracting it, and asks before installing
/// (SUAutomaticallyUpdate is off). It stays out of meetings: background checks
/// wait until the meeting is over, and an install the user accepted mid-meeting
/// waits until the meeting and its close-out work have finished
/// (docs/updates.md).
@MainActor
final class UpdateController: NSObject {
    private var controller: SPUStandardUpdaterController?
    private let inMeeting: () -> Bool
    private var heldInstall: (() -> Void)?
    private var heldBackgroundCheck = false
    private var releaseTask: Task<Void, Never>?

    init(inMeeting: @escaping () -> Bool) {
        self.inMeeting = inMeeting
        super.init()
    }

    /// Starts Sparkle in a packaged app whose Info.plist names a feed and a
    /// key. `swift run` has neither, and Sparkle would put up an alert.
    func start() {
        guard Bundle.main.bundlePath.hasSuffix(".app"),
              let feed = Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String,
              Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") != nil else {
            appLog("[Updates] Not a packaged app with a feed: Sparkle not started")
            return
        }
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
        appLog("[Updates] Sparkle started (feed \(feed))")
    }

    var isAvailable: Bool { controller != nil }

    func checkForUpdates() {
        guard let controller else {
            appLog("[Updates] Check for Updates asked, but Sparkle is not running in this build")
            return
        }
        controller.checkForUpdates(nil)
    }

    /// Called whenever a meeting ends: run what was held back for it, once the
    /// server has finished the meeting's close-out work.
    func meetingEnded() {
        guard heldInstall != nil || heldBackgroundCheck else { return }
        releaseTask?.cancel()
        releaseTask = Task { [weak self] in
            let deadline = Date().addingTimeInterval(UpdatePolicy.closeOutWaitLimit)
            while !Task.isCancelled, Date() < deadline {
                guard let self, !self.inMeeting() else { return }
                let busy = await Self.serverBusyWorkers()
                if busy == nil || busy == 0 { break }
                try? await Task.sleep(nanoseconds: 10_000_000_000)
            }
            guard !Task.isCancelled, let self, !self.inMeeting() else { return }
            if let install = self.heldInstall {
                self.heldInstall = nil
                appLog("[Updates] Meeting over and its close-out done: installing the held update")
                install()
            } else if self.heldBackgroundCheck {
                self.heldBackgroundCheck = false
                appLog("[Updates] Meeting over: running the update check held back for it")
                self.controller?.updater.checkForUpdatesInBackground()
            }
        }
    }

    /// nil when the server can't be asked, which means there is nothing of
    /// its to wait for.
    private static func serverBusyWorkers() async -> Int? {
        let request = URLRequest(url: ServerConfig.url("/debug"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
        guard let (data, _) = try? await URLSession.shared.data(for: request) else { return nil }
        return UpdatePolicy.busyWorkers(debugJSON: data)
    }
}

// MARK: - SPUUpdaterDelegate

extension UpdateController: SPUUpdaterDelegate {
    // Sparkle calls its delegate on the main thread.

    nonisolated func updater(_ updater: SPUUpdater, mayPerform updateCheck: SPUUpdateCheck) throws {
        let allowed = MainActor.assumeIsolated { () -> Bool in
            let meeting = inMeeting()
            guard UpdatePolicy.mayCheck(userInitiated: updateCheck == .updates, inMeeting: meeting) else {
                heldBackgroundCheck = true
                appLog("[Updates] Background update check held until the meeting ends")
                return false
            }
            return true
        }
        if !allowed {
            throw NSError(domain: "com.christopherrobinson.meeting-copilot.updates", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Update checks wait until the meeting is over."])
        }
    }

    nonisolated func updater(_ updater: SPUUpdater,
                             shouldPostponeRelaunchForUpdate item: SUAppcastItem,
                             untilInvokingBlock installHandler: @escaping () -> Void) -> Bool {
        MainActor.assumeIsolated {
            guard UpdatePolicy.postponeInstall(inMeeting: inMeeting()) else { return false }
            heldInstall = installHandler
            appLog("[Updates] \(item.displayVersionString) is ready: installing after the meeting")
            return true
        }
    }

    nonisolated func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        let message = (error as NSError).localizedDescription
        MainActor.assumeIsolated { appLog("[Updates] Update aborted: \(message)") }
    }

    nonisolated func updaterWillRelaunchApplication(_ updater: SPUUpdater) {
        MainActor.assumeIsolated { appLog("[Updates] Relaunching to finish the update") }
    }
}
