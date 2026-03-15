import Foundation

// MARK: - Process Supervisor

/// Manages the Node.js server and whisper-server as child processes.
/// Handles launching, monitoring, auto-restart on crash, and graceful shutdown.
@Observable
final class ProcessSupervisor {
    // MARK: - Configuration

    private let maxRestartAttempts = 3
    private let restartDelay: TimeInterval = 5.0
    private let shutdownTimeout: TimeInterval = 5.0

    // MARK: - State

    var serverRunning: Bool = false
    var whisperRunning: Bool = false

    private var serverProcess: Process?
    private var whisperProcess: Process?
    private var serverRestartCount = 0
    private var whisperRestartCount = 0
    private var monitorTasks: [Task<Void, Never>] = []

    // MARK: - Server Paths

    /// Returns true when running from a .app bundle (vs. swift run in dev).
    private var isPackaged: Bool {
        Bundle.main.bundlePath.hasSuffix(".app")
    }

    /// In production (.app bundle), look in Resources first.
    /// In development (swift run), fall back to the project directory.
    private var serverPath: String {
        // Prefer bundle path when running as a packaged app
        if isPackaged, let bundlePath = Bundle.main.resourcePath {
            let bundleServer = "\(bundlePath)/server"
            if FileManager.default.fileExists(atPath: bundleServer) {
                return bundleServer
            }
        }
        // Development fallback
        return NSString("~/Projects/meeting-copilot/server").expandingTildeInPath
    }

    private var whisperPath: String {
        // Prefer bundle path when running as a packaged app
        if isPackaged, let bundlePath = Bundle.main.resourcePath {
            let bundleWhisper = "\(bundlePath)/whisper-server"
            if FileManager.default.fileExists(atPath: bundleWhisper) {
                return bundleWhisper
            }
        }
        // Development fallback: try homebrew, then project bin
        let homebrewPath = "/opt/homebrew/bin/whisper-server"
        if FileManager.default.fileExists(atPath: homebrewPath) {
            return homebrewPath
        }
        return NSString("~/Projects/meeting-copilot/bin/whisper-server").expandingTildeInPath
    }

    /// Build a process environment with homebrew paths included.
    /// Apps launched from Finder have a minimal PATH that misses /opt/homebrew/bin.
    private func processEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let extraPaths = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]
        let currentPath = env["PATH"] ?? "/usr/bin:/bin"
        let missing = extraPaths.filter { !currentPath.contains($0) }
        if !missing.isEmpty {
            env["PATH"] = missing.joined(separator: ":") + ":" + currentPath
        }
        return env
    }

    // MARK: - Cleanup Orphans

    /// Kill any orphaned processes from previous launches that hold our ports.
    /// Called before starting new server/whisper processes to avoid EADDRINUSE.
    func cleanupOrphans() {
        let ports = [("17890", "Server"), ("8078", "Whisper")]
        for (port, name) in ports {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/lsof")
            process.arguments = ["-ti", "tcp:\(port)"]
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = Pipe()
            do {
                try process.run()
                process.waitUntilExit()
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                guard let output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !output.isEmpty else { continue }
                let pids = output.components(separatedBy: "\n").compactMap { Int32($0.trimmingCharacters(in: .whitespaces)) }
                let myPID = ProcessInfo.processInfo.processIdentifier
                for pid in pids where pid != myPID {
                    print("[ProcessSupervisor] Killing orphaned \(name) process (PID: \(pid)) on port \(port)")
                    kill(pid, SIGKILL)
                }
            } catch {
                print("[ProcessSupervisor] Failed to check port \(port): \(error)")
            }
        }
    }

    // MARK: - Start Server

    func startServer() {
        guard !serverRunning else { return }
        serverRestartCount = 0
        launchServer()
    }

    private func launchServer() {
        let process = Process()
        let serverDir = serverPath

        // In dev: use npx tsx to run TypeScript directly
        // In production: dist/index.js would be pre-compiled
        let distPath = "\(serverDir)/dist/index.js"
        if FileManager.default.fileExists(atPath: distPath) {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["node", "dist/index.js"]
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["npx", "tsx", "src/index.ts"]
        }
        process.currentDirectoryURL = URL(fileURLWithPath: serverDir)

        // Inherit environment with homebrew paths and set NODE_ENV
        var env = processEnvironment()
        env["NODE_ENV"] = isPackaged ? "production" : "development"
        process.environment = env

        // Pipe output for logging
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if let output = String(data: data, encoding: .utf8), !output.isEmpty {
                print("[Server] \(output.trimmingCharacters(in: .whitespacesAndNewlines))")
            }
        }

        do {
            try process.run()
            self.serverProcess = process
            self.serverRunning = true
            print("[ProcessSupervisor] Server started (PID: \(process.processIdentifier))")

            // Monitor for unexpected termination
            let task = Task.detached { [weak self] in
                process.waitUntilExit()
                await MainActor.run {
                    guard let self = self else { return }
                    self.serverRunning = false
                    print("[ProcessSupervisor] Server exited (code: \(process.terminationStatus))")

                    // Auto-restart if not intentionally stopped
                    if process.terminationStatus != 0 && self.serverRestartCount < self.maxRestartAttempts {
                        self.serverRestartCount += 1
                        print("[ProcessSupervisor] Restarting server (attempt \(self.serverRestartCount)/\(self.maxRestartAttempts))...")
                        Task {
                            try? await Task.sleep(nanoseconds: UInt64(self.restartDelay * 1_000_000_000))
                            self.launchServer()
                        }
                    }
                }
            }
            monitorTasks.append(task)
        } catch {
            print("[ProcessSupervisor] Failed to start server: \(error)")
            serverRunning = false
        }
    }

    // MARK: - Start Whisper

    func startWhisper() {
        guard !whisperRunning else { return }
        whisperRestartCount = 0
        launchWhisper()
    }

    private func launchWhisper() {
        let path = whisperPath
        guard FileManager.default.fileExists(atPath: path) else {
            print("[ProcessSupervisor] whisper-server not found at \(path)")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        let modelPath = NSString("~/.meeting-copilot/models/ggml-base.en.bin").expandingTildeInPath
        process.arguments = ["--model", modelPath, "--port", "8078", "--threads", "4", "--no-timestamps"]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if let output = String(data: data, encoding: .utf8), !output.isEmpty {
                print("[Whisper] \(output.trimmingCharacters(in: .whitespacesAndNewlines))")
            }
        }

        do {
            try process.run()
            self.whisperProcess = process
            self.whisperRunning = true
            print("[ProcessSupervisor] Whisper started (PID: \(process.processIdentifier))")

            let task = Task.detached { [weak self] in
                process.waitUntilExit()
                await MainActor.run {
                    guard let self = self else { return }
                    self.whisperRunning = false
                    print("[ProcessSupervisor] Whisper exited (code: \(process.terminationStatus))")

                    if process.terminationStatus != 0 && self.whisperRestartCount < self.maxRestartAttempts {
                        self.whisperRestartCount += 1
                        print("[ProcessSupervisor] Restarting whisper (attempt \(self.whisperRestartCount)/\(self.maxRestartAttempts))...")
                        Task {
                            try? await Task.sleep(nanoseconds: UInt64(self.restartDelay * 1_000_000_000))
                            self.launchWhisper()
                        }
                    }
                }
            }
            monitorTasks.append(task)
        } catch {
            print("[ProcessSupervisor] Failed to start whisper: \(error)")
            whisperRunning = false
        }
    }

    // MARK: - Stop All

    func stopAll() async {
        // Cancel monitor tasks
        for task in monitorTasks {
            task.cancel()
        }
        monitorTasks = []

        // Graceful shutdown: SIGTERM, wait, then SIGKILL if needed
        await stopProcess(serverProcess, name: "Server")
        await stopProcess(whisperProcess, name: "Whisper")

        serverProcess = nil
        whisperProcess = nil
        serverRunning = false
        whisperRunning = false
    }

    private func stopProcess(_ process: Process?, name: String) async {
        guard let process = process, process.isRunning else { return }

        print("[ProcessSupervisor] Sending SIGTERM to \(name) (PID: \(process.processIdentifier))")
        process.terminate()

        // Wait for graceful shutdown
        let deadline = Date().addingTimeInterval(shutdownTimeout)
        while process.isRunning && Date() < deadline {
            try? await Task.sleep(nanoseconds: 100_000_000) // 100ms
        }

        // Force kill if still running
        if process.isRunning {
            print("[ProcessSupervisor] Force killing \(name) (PID: \(process.processIdentifier))")
            kill(process.processIdentifier, SIGKILL)
        }
    }
}
