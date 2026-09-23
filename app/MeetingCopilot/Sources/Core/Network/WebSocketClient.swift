import Foundation

// MARK: - WebSocket Client

/// Actor-based WebSocket client for communicating with the local Node.js server.
/// Connects via `ws://localhost:<ServerConfig.port>` (TCP) or Unix domain socket when available.
actor WebSocketClient {
    // MARK: - Configuration

    private let serverURL: URL
    private let socketPath: String?
    // Exponential backoff: 1, 2, 4, 8, 16, 30, 30, … seconds. Unlimited retries
    // so the app self-heals through long server outages without the user having
    // to restart it. Counter resets on every successful connect.
    private let reconnectDelaysSeconds: [TimeInterval] = [1, 2, 4, 8, 16, 30]
    private let receiveTimeout: TimeInterval = 120.0 // 2 minutes

    // MARK: - State

    private var webSocketTask: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var reconnectAttempts = 0
    private var isConnected = false
    private var isIntentionalDisconnect = false
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var connectionGeneration = 0

    // MARK: - Callbacks

    var onMessage: ((ServerMessage) -> Void)?
    var onConnect: (() -> Void)?
    var onDisconnect: (() -> Void)?

    // MARK: - Init

    /// Initialize with a TCP URL (default) and an optional Unix socket path.
    /// When `socketPath` is provided and the file exists, the client will prefer it.
    init(
        url: URL = ServerConfig.wsURL,
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
        reconnectTask?.cancel()
        establishConnection()
    }

    func disconnect() {
        isIntentionalDisconnect = true
        receiveTask?.cancel()
        receiveTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        connectionGeneration += 1
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        isConnected = false
        onDisconnect?()
    }

    private func establishConnection() {
        receiveTask?.cancel()
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        urlSession?.invalidateAndCancel()
        connectionGeneration += 1
        let generation = connectionGeneration
        let session = URLSession(configuration: .default)
        self.urlSession = session
        let task = session.webSocketTask(with: serverURL)
        self.webSocketTask = task
        task.resume()

        // Start receiving — connection is confirmed on first successful receive
        receiveTask = Task { [weak self] in
            guard let self = self else { return }
            await self.startReceiving(task: task, generation: generation)
        }
    }

    private func markConnected() {
        guard !isConnected else { return }
        isConnected = true
        reconnectAttempts = 0
        onConnect?()
    }

    private func startReceiving(
        task: URLSessionWebSocketTask,
        generation: Int
    ) async {
        while !Task.isCancelled && generation == connectionGeneration {
            do {
                let message = try await withThrowingTimeout(seconds: receiveTimeout) {
                    try await task.receive()
                }
                guard generation == connectionGeneration else { return }
                markConnected()
                handleRawMessage(message)
            } catch {
                guard generation == connectionGeneration else { return }
                if !isIntentionalDisconnect {
                    handleDisconnect(generation: generation)
                }
                return
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
            // appLog, not print: stderr never reaches app.log (gotcha #15), and
            // a print here is how every transcript.update and action.suggested
            // failed to decode for months without anyone seeing it.
            appLog("[WebSocket] Failed to decode message: \(error)")
        }
    }

    private func handleDisconnect(generation: Int) {
        guard generation == connectionGeneration else { return }
        isConnected = false
        onDisconnect?()

        guard !isIntentionalDisconnect else { return }

        let delayIndex = min(reconnectAttempts, reconnectDelaysSeconds.count - 1)
        let delay = reconnectDelaysSeconds[delayIndex]
        reconnectAttempts += 1
        print("[WebSocket] Reconnecting in \(delay)s (attempt \(reconnectAttempts))…")

        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self = self else { return }
            await self.reconnectIfCurrent(generation: generation)
        }
    }

    private func reconnectIfCurrent(generation: Int) {
        guard !isIntentionalDisconnect, generation == connectionGeneration else { return }
        establishConnection()
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
        decoder.dateDecodingStrategy = .custom(decodeServerDate)
        return decoder
    }()

    /// The server stamps dates with JS `toISOString()`, which always carries
    /// milliseconds (`2026-09-22T19:04:05.123Z`). Foundation's `.iso8601`
    /// strategy rejects fractional seconds outright, so it failed the whole
    /// message. Accept both forms, and epoch milliseconds too.
    private static func decodeServerDate(_ decoder: Decoder) throws -> Date {
        let container = try decoder.singleValueContainer()
        if let ms = try? container.decode(Double.self) {
            return Date(timeIntervalSince1970: ms / 1000)
        }
        let text = try container.decode(String.self)
        if let date = fractionalISO.date(from: text) ?? plainISO.date(from: text) {
            return date
        }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unrecognised date: \(text)")
    }

    private static let fractionalISO: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let plainISO = ISO8601DateFormatter()
}

extension JSONEncoder {
    static let copilotEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
}
