import Foundation
import AppKit
import SwiftUI

// Buffered, bounded file logging (stdout is invisible when launched from Finder).
private final class AppFileLogger: @unchecked Sendable {
    static let shared = AppFileLogger()
    private let queue = DispatchQueue(label: "meeting-copilot.app-log", qos: .utility)
    private let path = NSString("~/.meeting-copilot/app.log").expandingTildeInPath
    private let maxBytes: UInt64 = 5 * 1024 * 1024

    func write(_ message: String) {
        let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(message.replacingOccurrences(of: "\n", with: " "))\n"
        queue.async { [self] in
            let manager = FileManager.default
            try? manager.createDirectory(
                atPath: (path as NSString).deletingLastPathComponent,
                withIntermediateDirectories: true
            )
            if let size = (try? manager.attributesOfItem(atPath: path)[.size]) as? UInt64,
               size + UInt64(line.utf8.count) >= maxBytes {
                try? manager.removeItem(atPath: "\(path).2")
                try? manager.moveItem(atPath: "\(path).1", toPath: "\(path).2")
                try? manager.moveItem(atPath: path, toPath: "\(path).1")
            }
            let data = line.data(using: .utf8) ?? Data()
            if let handle = FileHandle(forWritingAtPath: path) {
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
                try? handle.close()
            } else {
                manager.createFile(atPath: path, contents: data)
            }
        }
    }
}

func appLog(_ msg: String) {
    AppFileLogger.shared.write(msg)
}

// MARK: - Session Manager

/// Central manager for the meeting session lifecycle.
/// Coordinates audio capture, WebSocket communication, and action management.
@Observable
@MainActor
final class SessionManager {
    // MARK: - Published State

    var currentSession: Session?
    var state: SessionState = .idle
    var transcriptSegments: [TranscriptSegment] = []
    var actions: [ActionSuggestion] = []
    var isRecording: Bool = false
    var degradedReasons: [String] = []
    var totalWordCount: Int = 0
    var sessionElapsedTime: TimeInterval = 0
    var selectedProjectNames: [String] = []
    var selectedContextPaths: [String] = []
    var serverReady: Bool = false
    var serverStartFailed: Bool = false
    var errorMessage: String? = nil
    var meetingTitle: String = ""
    var meetingAgenda: String = ""
    var meetingAttendees: String = ""

    // MARK: - Dependencies

    let audioCaptureManager = AudioCaptureManager()
    let webSocketClient = WebSocketClient()
    let processSupervisor = ProcessSupervisor()

    // MARK: - Private

    private var sessionTimerTask: Task<Void, Never>?
    private var graceTimer: Timer?
    private let maxTranscriptSegments = 50
    private let endingGracePeriod: TimeInterval = 60.0

    // MARK: - Computed Properties

    var suggestedActions: [ActionSuggestion] {
        actions.filter { $0.state == .suggested }
    }

    var runningActions: [ActionSuggestion] {
        actions.filter { $0.state.isActive }
    }

    var isConnected: Bool {
        // Check synchronously via a cached value; actual status is updated via callbacks
        _isConnectedCache
    }
    private var _isConnectedCache: Bool = false

    // MARK: - Session Lifecycle

    func waitForServer() {
        guard !serverReady else { return }
        Task {
            for _ in 0..<30 { // up to 30 seconds
                let url = ServerConfig.url("/health")
                if let (_, response) = try? await URLSession.shared.data(from: url),
                   (response as? HTTPURLResponse)?.statusCode == 200 {
                    serverReady = true
                    await runPreflightCheck()
                    return
                }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
            self.serverStartFailed = true
            self.surfaceError("Server did not become ready after 30s. Check that Node.js is installed.")
        }
    }

    func retryServerConnection() {
        serverStartFailed = false
        serverReady = false
        waitForServer()
    }

    private func runPreflightCheck() async {
        let url = ServerConfig.url("/preflight")
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let checks = json["checks"] as? [[String: Any]] {
                let failures = checks.filter { ($0["ok"] as? Bool) == false }
                if !failures.isEmpty {
                    let details = failures.compactMap { $0["detail"] as? String }.joined(separator: ". ")
                    surfaceError("Preflight: \(details)")
                }
            }
        } catch {
            appLog("[Preflight] Failed: \(error)")
        }
    }

    /// Start a session initiated from the embedded web UI.
    /// The web form collects title/agenda/context AND the per-session consent
    /// affirmation (architecture invariant #3) — native enforces it here so a
    /// stale/modified page can't start capture without it. `consent == nil`
    /// (older dashboard without the checkbox) is allowed with a log during
    /// the transition; tighten to refuse once no pre-checkbox pages remain.
    func startSessionFromWeb(title: String, agenda: String, attendees: String, projectNames: [String], contextPaths: [String], consent: Bool?) {
        guard serverReady else {
            surfaceError("Server not ready yet.")
            return
        }
        guard state == .idle || state == .archived else {
            appLog("[Session] startSessionFromWeb ignored — state=\(state.rawValue)")
            return
        }
        if consent == false {
            surfaceError("Confirm recording consent to start the session.")
            return
        }
        if consent == nil {
            appLog("[Session] startSessionFromWeb without consent field (pre-checkbox dashboard) — allowing")
        }
        meetingTitle = title
        meetingAgenda = agenda
        meetingAttendees = attendees
        selectedProjectNames = projectNames
        selectedContextPaths = contextPaths
        Task { await startSession() }
    }

    /// Stop a session initiated from the embedded web UI.
    func stopSessionFromWeb() {
        guard state == .live || state == .degraded else { return }
        stopSession()
    }

    private func startSession() async {
        appLog("[Session] startSession() called, state=\(state.rawValue)")
        guard handleStateTransition(to: .priming) else {
            appLog("[Session] Failed to transition to priming")
            return
        }

        // Create new session — use user-provided title if non-empty, otherwise auto-generate
        let title = meetingTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "Meeting \(DateFormatter.sessionFormatter.string(from: Date()))"
            : meetingTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let session = Session(title: title)
        currentSession = session

        // Set up WebSocket callbacks
        await webSocketClient.setCallbacks(
            onMessage: { [weak self] message in
                Task { @MainActor in
                    self?.handleServerMessage(message)
                }
            },
            onConnect: { [weak self] in
                Task { @MainActor in
                    appLog("[Session] WebSocket onConnect fired")
                    self?._isConnectedCache = true
                    self?.recoverFromDegraded()
                }
            },
            onDisconnect: { [weak self] in
                Task { @MainActor in
                    appLog("[Session] WebSocket onDisconnect fired, state=\(self?.state.rawValue ?? "nil")")
                    self?._isConnectedCache = false
                    if self?.state == .live || self?.state == .priming {
                        self?.handleDegraded(reason: "Server connection lost")
                        self?.surfaceError("Lost connection to server. Audio is being buffered locally.")
                    }
                }
            }
        )

        // Connect to server
        appLog("[Session] Connecting WebSocket...")
        await webSocketClient.connect()

        // Wait briefly for the connection handshake (server sends session.state on connect)
        try? await Task.sleep(nanoseconds: 500_000_000) // 500ms

        let connected = await webSocketClient.getIsConnected()
        appLog("[Session] WebSocket connected=\(connected)")

        // Start audio capture
        appLog("[Session] Starting audio capture...")
        do {
            try await audioCaptureManager.startCapture(
                onChunk: { [weak self] wavData, source, meta in
                    Task { [weak self] in
                        guard let self = self else { return }
                        let isConnected = await self.webSocketClient.getIsConnected()
                        let sessionState = await MainActor.run { self.state }
                        let base64 = wavData.base64EncodedString()
                        let sourceStr = source == .mic ? "mic" : "meeting"
                        if isConnected && sessionState == .live {
                            do {
                                try await self.webSocketClient.send(.audioChunk(
                                    data: base64,
                                    source: sourceStr,
                                    chunkId: meta.chunkId,
                                    audioDurationSec: meta.audioDurationSec,
                                    captureStartedAt: meta.captureStartedAt,
                                    captureEndedAt: meta.captureEndedAt,
                                    sequence: meta.sequence,
                                    isContinuation: meta.isContinuation
                                ))
                            } catch {
                                await MainActor.run {
                                    self.handleDegraded(reason: "Server connection lost")
                                    self.surfaceError("Lost connection to server. Audio is being buffered locally.")
                                }
                            }
                        } else if sessionState == .priming || sessionState == .degraded {
                            // Buffer during degraded mode for replay on reconnect
                            await MainActor.run {
                                self.audioCaptureManager.bufferDegradedChunk(wavData, source: source, meta: meta)
                            }
                        }
                    }
                },
                onDeviceError: { [weak self] in
                    Task { @MainActor in
                        self?.handleDegraded(reason: "Audio device lost")
                    }
                }
            )
        } catch {
            appLog("[Session] Audio capture FAILED: \(error)")
            let description = error.localizedDescription
            // -3801 = user declined TCC for screen/audio capture
            let isTCCDecline = description.contains("TCC") || description.contains("declined") || (error as NSError).code == -3801
            if isTCCDecline {
                surfaceError("Screen Recording permission is required to capture meeting audio. Open System Settings → Privacy & Security → Screen Recording, enable Meeting Copilot, then quit and relaunch the app.")
            } else {
                surfaceError("Audio capture failed: \(description)")
            }
            // Roll back to idle so the user can retry (e.g., after granting permission)
            // instead of getting stuck in .error until relaunch.
            _ = handleStateTransition(to: .error)
            _ = handleStateTransition(to: .idle)
            currentSession = nil
            return
        }
        appLog("[Session] Audio capture started OK")

        // Re-check connection (may have dropped during audio setup)
        let stillConnected = await webSocketClient.getIsConnected()
        appLog("[Session] Pre-send check: initial connected=\(connected), still connected=\(stillConnected), state=\(state.rawValue)")

        if stillConnected {
            // Notify server; transition to live only after the server acknowledges it.
            let agendaToSend = meetingAgenda.trimmingCharacters(in: .whitespacesAndNewlines)
            let attendeesToSend = meetingAttendees.trimmingCharacters(in: .whitespacesAndNewlines)
            do {
                try await webSocketClient.send(.sessionStart(
                    title: currentSession?.title,
                    projectNames: selectedProjectNames.isEmpty ? nil : selectedProjectNames,
                    agenda: agendaToSend.isEmpty ? nil : agendaToSend,
                    attendees: attendeesToSend.isEmpty ? nil : attendeesToSend,
                    contextPaths: selectedContextPaths.isEmpty ? nil : selectedContextPaths
                ))
                appLog("[Session] session.start sent OK")
            } catch {
                appLog("[Session] session.start send FAILED: \(error)")
                _ = handleStateTransition(to: .degraded)
                if !degradedReasons.contains("Server session start failed") {
                    degradedReasons.append("Server session start failed")
                }
                surfaceError("Failed to start session on the server. Audio is being buffered locally.")
            }
        } else {
            appLog("[Session] Server not reachable — entering degraded")
            _ = handleStateTransition(to: .degraded)
            if !degradedReasons.contains("Server connection failed") {
                degradedReasons.append("Server connection failed")
            }
        }

        isRecording = true
        currentSession?.startedAt = Date()

        // Start session timer as a Task (Timer.scheduledTimer can miss RunLoop in async contexts)
        sessionTimerTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000) // 1s
                guard let self = self, let startedAt = self.currentSession?.startedAt else { break }
                self.sessionElapsedTime = Date().timeIntervalSince(startedAt)
            }
        }
    }

    func stopSession() {
        guard state == .live || state == .degraded else { return }

        isRecording = false
        sessionTimerTask?.cancel()
        sessionTimerTask = nil

        // CRITICAL ORDERING: state must stay .live until the VAD flush
        // chunks finish sending. The onChunk Task only forwards when
        // state == .live; transitioning to .ending first would drop the
        // trailing utterance. Order is:
        //   1. Collect flushed chunks (syncs on VAD emitter queues)
        //   2. Serially await webSocketClient.send for each
        //   3. Send audio.flush — tells server to await transcription.flushPending
        //   4. Flip state to .ending
        //   5. Send session.stop
        //   6. Grace period → finalize
        Task {
            let flushedChunks = audioCaptureManager.flushPendingAudio()
            for (wav, source, meta) in flushedChunks {
                let base64 = wav.base64EncodedString()
                let sourceStr = source == .mic ? "mic" : "meeting"
                do {
                    try await webSocketClient.send(.audioChunk(
                        data: base64,
                        source: sourceStr,
                        chunkId: meta.chunkId,
                        audioDurationSec: meta.audioDurationSec,
                        captureStartedAt: meta.captureStartedAt,
                        captureEndedAt: meta.captureEndedAt,
                        sequence: meta.sequence,
                        isContinuation: meta.isContinuation
                    ))
                } catch {
                    appLog("[Session] Flush-chunk send failed: \(error) — continuing to stop")
                }
            }

            try? await webSocketClient.send(.audioFlush)

            // Now it's safe to flip state; all trailing audio is in the server's queue.
            await MainActor.run {
                _ = self.handleStateTransition(to: .ending)
            }

            try? await webSocketClient.send(.sessionStop)

            await MainActor.run {
                self.graceTimer = Timer.scheduledTimer(withTimeInterval: self.endingGracePeriod, repeats: false) { [weak self] _ in
                    Task { @MainActor in
                        self?.finalizeSession()
                    }
                }
                if self.runningActions.isEmpty {
                    self.graceTimer?.invalidate()
                    self.graceTimer = nil
                    self.finalizeSession()
                }
            }
        }
    }

    private func finalizeSession() {
        Task {
            await audioCaptureManager.stopCapture()
            await webSocketClient.disconnect()
        }

        currentSession?.endedAt = Date()
        _ = handleStateTransition(to: .archived)

        // Reset for next session
        resetSessionState()
    }

    private func resetSessionState() {
        transcriptSegments = []
        actions = []
        totalWordCount = 0
        sessionElapsedTime = 0
        degradedReasons = []
        selectedProjectNames = []
        selectedContextPaths = []
        meetingTitle = ""
        meetingAgenda = ""
        meetingAttendees = ""
        currentSession = nil
        _ = handleStateTransition(to: .idle)
    }

    // MARK: - Error Surfacing

    /// External observer for error messages (e.g., the web dashboard bridges these
    /// into a JS toast so the user sees them without a native error panel).
    var onError: ((String) -> Void)?

    /// Evaluates JavaScript inside the dashboard WKWebView (wired by
    /// WebDashboardView). Nil until the web panel has been created.
    var runDashboardJS: ((String) -> Void)?

    /// Menubar / hotkey "Start Session": the web start form owns title, agenda,
    /// projects, and context — there is no native start form — so front-of-app
    /// callers focus it instead of starting with an empty payload. Safe no-op
    /// while a session is live (the idle overlay, and #startTitle with it, is
    /// not in the DOM) or before the page loads.
    func focusWebStartForm() {
        let js = "(function(){var el=document.getElementById('startTitle');" +
            "if(el){el.focus();el.scrollIntoView({block:'center'});}})();"
        runDashboardJS?(js)
    }

    func surfaceError(_ message: String) {
        errorMessage = message
        onError?(message)
        // Auto-dismiss after 8 seconds
        Task {
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            if errorMessage == message {
                errorMessage = nil
            }
        }
    }

    func dismissError() {
        errorMessage = nil
    }

    // MARK: - State Transitions

    @discardableResult
    func handleStateTransition(to newState: SessionState) -> Bool {
        guard state.canTransition(to: newState) else {
            print("[SessionManager] Invalid transition: \(state.rawValue) -> \(newState.rawValue)")
            return false
        }
        print("[SessionManager] State: \(state.rawValue) -> \(newState.rawValue)")
        state = newState
        currentSession?.state = newState
        return true
    }

    // MARK: - Degraded Mode

    private func handleDegraded(reason: String) {
        if state == .live || state == .priming {
            _ = handleStateTransition(to: .degraded)
        }
        if !degradedReasons.contains(reason) {
            degradedReasons.append(reason)
        }
    }

    func recoverFromDegraded() {
        if state == .degraded && _isConnectedCache {
            Task {
                let agendaToSend = meetingAgenda.trimmingCharacters(in: .whitespacesAndNewlines)
                let attendeesToSend = meetingAttendees.trimmingCharacters(in: .whitespacesAndNewlines)
                do {
                    try await webSocketClient.send(.sessionStart(
                        title: currentSession?.title,
                        projectNames: selectedProjectNames.isEmpty ? nil : selectedProjectNames,
                        agenda: agendaToSend.isEmpty ? nil : agendaToSend,
                        attendees: attendeesToSend.isEmpty ? nil : attendeesToSend,
                        contextPaths: selectedContextPaths.isEmpty ? nil : selectedContextPaths
                    ))
                    appLog("[Session] Recovery session.start sent OK")
                } catch {
                    appLog("[Session] Recovery session.start FAILED: \(error)")
                    await MainActor.run {
                        self.surfaceError("Reconnected to the server, but failed to resume the session.")
                    }
                }
            }
        }
    }

    // MARK: - Action Management

    func approveAction(id: String) {
        guard let index = actions.firstIndex(where: { $0.id == id }) else { return }
        actions[index].state = .approved
        actions[index].approvedAt = Date()
        Task {
            try? await webSocketClient.send(.actionApprove(actionId: id))
        }
    }

    func dismissAction(id: String) {
        guard let index = actions.firstIndex(where: { $0.id == id }) else { return }
        actions[index].state = .cancelled
        Task {
            try? await webSocketClient.send(.actionDismiss(actionId: id))
        }
    }

    // MARK: - Server Message Handling

    private func handleServerMessage(_ message: ServerMessage) {
        switch message {
        case .transcriptUpdate(let segment):
            // The server's transcript stitcher emits the same stable id
            // repeatedly as an open sentence grows in place, then once more
            // when it closes. Replace the existing row instead of appending a
            // duplicate fragment, adjusting the running word count by the delta.
            if let idx = transcriptSegments.firstIndex(where: { $0.id == segment.id }) {
                totalWordCount += segment.wordCount - transcriptSegments[idx].wordCount
                transcriptSegments[idx] = segment
            } else {
                transcriptSegments.append(segment)
                totalWordCount += segment.wordCount

                // Keep last N segments
                if transcriptSegments.count > maxTranscriptSegments {
                    transcriptSegments.removeFirst(transcriptSegments.count - maxTranscriptSegments)
                }
            }

        case .actionSuggested(let action):
            actions.append(action)
            NotificationManager.shared.postSuggestionNotification(
                actionId: action.id,
                actionTitle: action.title,
                actionType: action.type.rawValue
            )

        case .actionStatus(let actionId, let newState, let result):
            if let index = actions.firstIndex(where: { $0.id == actionId }) {
                if newState == .expired {
                    // Suggestion is gone — a stale banner's Approve would no-op.
                    NotificationManager.shared.clearSuggestionNotification(actionId: actionId)
                    withAnimation(.easeOut(duration: 0.3)) {
                        _ = actions.remove(at: index)
                    }
                    return
                }
                if newState != .suggested {
                    // Actioned (approved/dismissed/running/…) — retire the banner.
                    NotificationManager.shared.clearSuggestionNotification(actionId: actionId)
                }
                actions[index].state = newState
                if let result = result {
                    actions[index].result = result
                }
                if newState == .running {
                    actions[index].startedAt = Date()
                }
                if newState.isTerminal {
                    actions[index].completedAt = Date()

                    // If we're ending and no more running actions, finalize
                    if state == .ending && runningActions.isEmpty {
                        graceTimer?.invalidate()
                        graceTimer = nil
                        finalizeSession()
                    }
                }
            }

        case .sessionState(let newState, _):
            let previousState = state
            // Ignore server's initial "idle" during startup — it arrives before our
            // session.start message reaches the server and would reset the state machine.
            if state == .priming && newState == .idle {
                break
            }
            if handleStateTransition(to: newState),
               newState == .live,
               previousState == .priming || previousState == .degraded {
                degradedReasons = []
                audioCaptureManager.flushDegradedBuffer()
            }

        case .metrics:
            // Store for debug panel if needed
            break
        }
    }
}

// MARK: - WebSocket Client Extension for Callbacks

extension WebSocketClient {
    func setCallbacks(
        onMessage: @escaping (ServerMessage) -> Void,
        onConnect: @escaping () -> Void,
        onDisconnect: @escaping () -> Void
    ) {
        self.onMessage = onMessage
        self.onConnect = onConnect
        self.onDisconnect = onDisconnect
    }
}

// MARK: - Date Formatter

extension DateFormatter {
    static let sessionFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        formatter.doesRelativeDateFormatting = false
        return formatter
    }()
}
