import Foundation
import AppKit
import UniformTypeIdentifiers

// File-based debug logging (stdout invisible when launched from Finder)
func appLog(_ msg: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    let line = "[\(ts)] \(msg)\n"
    let path = NSString("~/.meeting-copilot/app.log").expandingTildeInPath
    if let handle = FileHandle(forWritingAtPath: path) {
        handle.seekToEndOfFile()
        handle.write(line.data(using: .utf8) ?? Data())
        handle.closeFile()
    } else {
        FileManager.default.createFile(atPath: path, contents: line.data(using: .utf8))
    }
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
    var showingConsentDialog: Bool = false
    var degradedReasons: [String] = []
    var totalWordCount: Int = 0
    var sessionElapsedTime: TimeInterval = 0
    var hasNewSuggestion: Bool = false
    var availableProjects: [ProjectInfo] = []
    var selectedProjectNames: [String] = []
    var availableContextSources: [ContextSourceInfo] = []
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

    var completedActions: [ActionSuggestion] {
        actions.filter { $0.state.isTerminal }
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
                guard let url = URL(string: "http://localhost:17890/health") else { break }
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
        guard let url = URL(string: "http://localhost:17890/preflight") else { return }
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

    func requestStartSession() {
        guard state == .idle, serverReady else { return }
        showingConsentDialog = true
    }

    func consentGranted() {
        showingConsentDialog = false
        Task {
            await startSession()
        }
    }

    func consentDenied() {
        showingConsentDialog = false
        selectedProjectNames = []
        // Stay in idle
    }

    func fetchProjects() async {
        guard let url = URL(string: "http://localhost:17890/projects") else { return }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let response = try JSONDecoder().decode(ProjectListResponse.self, from: data)
            availableProjects = response.projects
        } catch {
            print("[SessionManager] Failed to fetch projects: \(error)")
        }
    }

    func toggleProjectSelection(_ name: String) {
        if selectedProjectNames.contains(name) {
            selectedProjectNames.removeAll { $0 == name }
        } else {
            selectedProjectNames.append(name)
        }
    }

    func fetchContextSources() async {
        guard let url = URL(string: "http://localhost:17890/context-sources") else { return }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let response = try JSONDecoder().decode(ContextSourceListResponse.self, from: data)
            availableContextSources = response.items
        } catch {
            print("[SessionManager] Failed to fetch context sources: \(error)")
        }
    }

    func toggleContextSelection(_ path: String) {
        if selectedContextPaths.contains(path) {
            selectedContextPaths.removeAll { $0 == path }
        } else {
            selectedContextPaths.append(path)
        }
    }

    func addContextFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "Select a folder of reference documents"
        panel.prompt = "Add Folder"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            await addContextSource(path: url.path, type: .folder)
        }
    }

    func addContextFile() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [UTType.plainText, UTType.yaml, UTType.json].compactMap { $0 }
        panel.message = "Select reference documents"
        panel.prompt = "Add Files"
        guard panel.runModal() == .OK else { return }
        Task {
            for fileURL in panel.urls {
                await addContextSource(path: fileURL.path, type: .file)
            }
        }
    }

    private func addContextSource(path: String, type: ContextSourceType) async {
        guard let url = URL(string: "http://localhost:17890/context-sources/add") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String] = ["path": path, "type": type.rawValue]
        request.httpBody = try? JSONEncoder().encode(body)
        _ = try? await URLSession.shared.data(for: request)
        await fetchContextSources()
        // Auto-select the newly added item
        if !selectedContextPaths.contains(path) {
            selectedContextPaths.append(path)
        }
    }

    func removeContextSource(path: String) {
        selectedContextPaths.removeAll { $0 == path }
        Task {
            guard let url = URL(string: "http://localhost:17890/context-sources") else { return }
            var request = URLRequest(url: url)
            request.httpMethod = "DELETE"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONEncoder().encode(["path": path])
            _ = try? await URLSession.shared.data(for: request)
            await fetchContextSources()
        }
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
                onChunk: { [weak self] wavData, source in
                    Task { [weak self] in
                        guard let self = self else { return }
                        let isConnected = await self.webSocketClient.getIsConnected()
                        let sessionState = await MainActor.run { self.state }
                        let base64 = wavData.base64EncodedString()
                        let sourceStr = source == .mic ? "mic" : "meeting"
                        if isConnected && sessionState == .live {
                            do {
                                try await self.webSocketClient.send(.audioChunk(data: base64, source: sourceStr))
                            } catch {
                                await MainActor.run {
                                    self.handleDegraded(reason: "Server connection lost")
                                    self.surfaceError("Lost connection to server. Audio is being buffered locally.")
                                }
                            }
                        } else if sessionState == .priming || sessionState == .degraded {
                            // Buffer during degraded mode for replay on reconnect
                            await MainActor.run {
                                self.audioCaptureManager.bufferDegradedChunk(wavData, source: source)
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
            surfaceError("Audio capture failed: \(error.localizedDescription)")
            _ = handleStateTransition(to: .error)
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
        guard handleStateTransition(to: .ending) else { return }

        isRecording = false
        sessionTimerTask?.cancel()
        sessionTimerTask = nil

        // Notify server
        Task {
            try? await webSocketClient.send(.sessionStop)
        }

        // Grace period for in-flight workers
        graceTimer = Timer.scheduledTimer(withTimeInterval: endingGracePeriod, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.finalizeSession()
            }
        }

        // If no running actions, finalize immediately
        if runningActions.isEmpty {
            graceTimer?.invalidate()
            graceTimer = nil
            finalizeSession()
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
        hasNewSuggestion = false
        selectedProjectNames = []
        selectedContextPaths = []
        meetingTitle = ""
        meetingAgenda = ""
        meetingAttendees = ""
        currentSession = nil
        _ = handleStateTransition(to: .idle)
    }

    // MARK: - Error Surfacing

    func surfaceError(_ message: String) {
        errorMessage = message
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

    func cancelAction(id: String) {
        guard let index = actions.firstIndex(where: { $0.id == id }) else { return }
        actions[index].state = .cancelled
        Task {
            try? await webSocketClient.send(.actionCancel(actionId: id))
        }
    }

    func triggerManualAction(type: String, prompt: String? = nil) {
        guard state == .live || state == .degraded else { return }
        Task {
            try? await webSocketClient.send(.actionTrigger(actionType: type, prompt: prompt))
        }
    }

    // MARK: - Session History & Export

    func exportSession(sessionId: String, format: String = "markdown") async -> String? {
        guard let url = URL(string: "http://localhost:17890/sessions/\(sessionId)/export?format=\(format)") else { return nil }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            return String(data: data, encoding: .utf8)
        } catch {
            appLog("[SessionManager] Export failed: \(error)")
            return nil
        }
    }

    func fetchSessionHistory() async -> [SessionHistoryItem] {
        guard let url = URL(string: "http://localhost:17890/sessions") else { return [] }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            let items = try JSONDecoder().decode([SessionHistoryItem].self, from: data)
            return items.sorted { a, b in
                (a.startDate ?? .distantPast) > (b.startDate ?? .distantPast)
            }
        } catch {
            appLog("[SessionManager] Fetch session history failed: \(error)")
            return []
        }
    }

    // MARK: - Server Message Handling

    private func handleServerMessage(_ message: ServerMessage) {
        switch message {
        case .transcriptUpdate(let segment):
            transcriptSegments.append(segment)
            totalWordCount += segment.wordCount

            // Keep last N segments
            if transcriptSegments.count > maxTranscriptSegments {
                transcriptSegments.removeFirst(transcriptSegments.count - maxTranscriptSegments)
            }

        case .actionSuggested(let action):
            actions.append(action)
            hasNewSuggestion = true
            NotificationManager.shared.postSuggestionNotification(
                actionTitle: action.title,
                actionType: action.type.rawValue
            )
            // Auto-clear the badge after a short delay
            Task {
                try? await Task.sleep(nanoseconds: 3_000_000_000) // 3s
                hasNewSuggestion = false
            }

        case .actionStatus(let actionId, let newState, let result):
            if let index = actions.firstIndex(where: { $0.id == actionId }) {
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
