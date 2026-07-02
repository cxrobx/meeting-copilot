import Foundation

/// Single source of truth for the local server address. The Node server has
/// honored COPILOT_PORT for a long time, but the app used to hardcode 17890
/// in six places — setting the env var desynced the two halves. The port is
/// resolved once at launch (env → UserDefaults "copilotPort" → 17890) and
/// ProcessSupervisor passes it to the child server, so they always agree.
enum ServerConfig {
    static let port: Int = {
        if let env = ProcessInfo.processInfo.environment["COPILOT_PORT"],
           let value = Int(env), (1...65535).contains(value) {
            return value
        }
        let stored = UserDefaults.standard.integer(forKey: "copilotPort")
        if (1...65535).contains(stored) {
            return stored
        }
        return 17890
    }()

    static var baseURL: URL {
        URL(string: "http://localhost:\(port)")!
    }

    static var wsURL: URL {
        URL(string: "ws://localhost:\(port)")!
    }

    /// Convenience for REST endpoints: `ServerConfig.url("/health")`.
    static func url(_ pathAndQuery: String) -> URL {
        URL(string: "http://localhost:\(port)\(pathAndQuery)")!
    }
}
