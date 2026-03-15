import Foundation

// MARK: - WebSocket Client

/// Actor-based WebSocket client for communicating with the local Node.js server.
/// Connects via `ws://localhost:17890` (TCP) or Unix domain socket when available.
actor WebSocketClient {
    // MARK: - Configuration

    private let serverURL: URL
    private let socketPath: String?
    private let maxReconnectAttempts = 3
    private let reconnectDelay: TimeInterval = 5.0
    private let receiveTimeout: TimeInterval = 120.0 // 2 minutes

    // MARK: - State

    private var webSocketTask: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var reconnectAttempts = 0
    private var isConnected = false
    private var isIntentionalDisconnect = false
    private var receiveTask: Task<Void, Never>?

    // MARK: - Callbacks

    var onMessage: ((ServerMessage) -> Void)?
    var onConnect: (() -> Void)?
    var onDisconnect: (() -> Void)?

    // MARK: - Init

    /// Initialize with a TCP URL (default) and an optional Unix socket path.
    /// When `socketPath` is provided and the file exists, the client will prefer it.
    init(
        url: URL = URL(string: "ws://localhost:17890")!,
        socketPath: String? = NSString("~/.meeting-copilot/copilot.sock").expandingTildeInPath
    ) {
        self.serverURL = url
        self.socketPath = socketPath
    }

    /// Returns true if the Unix domain socket file exists.
    private var socketAvailable: Bool {
        guard let path = socketPath else { return false }
        return FileManager.default.fileExists(atPath: path)
    }

    // MARK: - Connection

    func connect() {
        isIntentionalDisconnect = false
        reconnectAttempts = 0
        establishConnection()
    }

    func disconnect() {
        isIntentionalDisconnect = true
        receiveTask?.cancel()
        receiveTask = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        isConnected = false
        onDisconnect?()
    }

    private func establishConnection() {
        let session = URLSession(configuration: .default)
        self.urlSession = session
        let task = session.webSocketTask(with: serverURL)
        self.webSocketTask = task
        task.resume()

        // Start receiving — connection is confirmed on first successful receive
        receiveTask = Task { [weak self] in
            guard let self = self else { return }
            await self.startReceiving()
        }
    }

    private func markConnected() {
        guard !isConnected else { return }
        isConnected = true
        reconnectAttempts = 0
        onConnect?()
    }

    private func startReceiving() {
        guard let task = webSocketTask else { return }

        Task {
            while !Task.isCancelled {
                do {
                    // Race the receive against a timeout so we detect hung sockets
                    let message = try await withThrowingTimeout(seconds: receiveTimeout) {
                        try await task.receive()
                    }
                    // First successful receive confirms the connection is live
                    if !isConnected {
                        await markConnected()
                    }
                    await handleRawMessage(message)
                } catch {
                    if !isIntentionalDisconnect {
                        await handleDisconnect()
                    }
                    break
                }
            }
        }
    }

    /// Run an async operation with a deadline. Throws `CancellationError` on timeout.
    private func withThrowingTimeout<T: Sendable>(
        seconds: TimeInterval,
        operation: @Sendable @escaping () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask {
                try await operation()
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw CancellationError()
            }
            guard let result = try await group.next() else {
                throw CancellationError()
            }
            group.cancelAll()
            return result
        }
    }

    private func handleRawMessage(_ message: URLSessionWebSocketTask.Message) {
        let data: Data

        switch message {
        case .string(let text):
            guard let textData = text.data(using: .utf8) else { return }
            data = textData
        case .data(let rawData):
            data = rawData
        @unknown default:
            return
        }

        do {
            let serverMessage = try JSONDecoder.copilotDecoder.decode(ServerMessage.self, from: data)
            onMessage?(serverMessage)
        } catch {
            print("[WebSocket] Failed to decode message: \(error)")
        }
    }

    private func handleDisconnect() {
        isConnected = false
        onDisconnect?()

        guard !isIntentionalDisconnect, reconnectAttempts < maxReconnectAttempts else {
            if reconnectAttempts >= maxReconnectAttempts {
                print("[WebSocket] Max reconnection attempts reached")
            }
            return
        }

        reconnectAttempts += 1
        print("[WebSocket] Reconnecting (attempt \(reconnectAttempts)/\(maxReconnectAttempts))...")

        Task {
            try? await Task.sleep(nanoseconds: UInt64(reconnectDelay * 1_000_000_000))
            guard !isIntentionalDisconnect else { return }
            establishConnection()
        }
    }

    // MARK: - Sending

    func send(_ message: ClientMessage) async throws {
        guard let task = webSocketTask, isConnected else {
            throw WebSocketError.notConnected
        }

        let data = try JSONEncoder.copilotEncoder.encode(message)
        try await task.send(.data(data))
    }

    // MARK: - Connection Status

    func getIsConnected() -> Bool {
        return isConnected
    }
}

// MARK: - WebSocket Errors

enum WebSocketError: Error, LocalizedError {
    case notConnected
    case encodingFailed

    var errorDescription: String? {
        switch self {
        case .notConnected: return "WebSocket is not connected"
        case .encodingFailed: return "Failed to encode message"
        }
    }
}

// MARK: - JSON Coding Helpers

extension JSONDecoder {
    static let copilotDecoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

extension JSONEncoder {
    static let copilotEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}
