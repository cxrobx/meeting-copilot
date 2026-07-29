import Foundation

// MARK: - Process Supervisor

/// Manages the Node.js server and whisper-server as child processes.
/// Handles launching, monitoring, auto-restart on crash, and graceful shutdown.
@Observable
@MainActor
final class ProcessSupervisor {
    // MARK: - Configuration

    // Soft ceiling — if we blow past this in a short window, we alert the user
    // instead of silently retrying forever. Counter resets whenever the server
    // stays healthy for `healthCountResetSeconds`.
    private let maxRestartAttempts = 10
    private let restartBackoffSeconds: [TimeInterval] = [1, 2, 4, 8, 16, 30]
    private let shutdownTimeout: TimeInterval = 5.0
    private let healthProbeInterval: TimeInterval = 15.0
    private let healthFailThreshold = 3           // consecutive /health failures = hung
    private let healthCountResetSeconds: TimeInterval = 60  // reset restartCount after stability

    // MARK: - State

    var serverRunning: Bool = false
    var whisperRunning: Bool = false
    /// Exposed so UI can show "reconnecting…" / "server unhealthy" status.
    var serverHealthy: Bool = false

    private var serverProcess: Process?
    private var whisperProcess: Process?
    private var serverRestartCount = 0
    private var whisperRestartCount = 0
    private var serverGeneration = 0
    private var whisperGeneration = 0

    // Parakeet sidecar (NVIDIA Parakeet-TDT via parakeet-mlx) — the DEFAULT
    // transcription backend when `uv` + the sidecar script are present.
    var parakeetRunning: Bool = false
    private var parakeetProcess: Process?
    private var parakeetRestartCount = 0
    private var parakeetGeneration = 0

    private var monitorTasks: [Task<Void, Never>] = []
    private var healthProbeTask: Task<Void, Never>?
    private var lastHealthyAt: Date?
    private var consecutiveHealthFailures = 0
    private var hasAlertedOnCrashLoop = false
    private var isStopping = false

    /// A FileHandle readability callback fires again at EOF unless it removes
    /// itself. Leaving it installed caused a tight loop after child exit.
    private func makeOutputPipe(prefix: String) -> Pipe {
        let pipe = Pipe()
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                try? handle.close()
                return
            }
            if let output = String(data: data, encoding: .utf8), !output.isEmpty {
                print("[\(prefix)] \(output.trimmingCharacters(in: .whitespacesAndNewlines))")
            }
        }
        return pipe
    }

    private func closeOutputPipe(for process: Process) {
        guard let pipe = process.standardOutput as? Pipe else { return }
        pipe.fileHandleForReading.readabilityHandler = nil
        try? pipe.fileHandleForReading.close()
    }

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
        // Prefer bundle path when running as a packaged app.
        // The bundled layout is Resources/whisper/{bin,lib}/ so the binary's
        // baked-in rpath (@loader_path/../lib) finds its dylib deps.
        if isPackaged, let bundlePath = Bundle.main.resourcePath {
            let bundleWhisper = "\(bundlePath)/whisper/bin/whisper-server"
            if FileManager.default.fileExists(atPath: bundleWhisper) {
                return bundleWhisper
            }
            // Back-compat: older bundles placed the binary directly in Resources
            // without its dylibs — skip those (they can't launch anyway).
        }
        // Development fallback: try homebrew, then project bin
        let homebrewPath = "/opt/homebrew/bin/whisper-server"
        if FileManager.default.fileExists(atPath: homebrewPath) {
            return homebrewPath
        }
        return NSString("~/Projects/meeting-copilot/bin/whisper-server").expandingTildeInPath
    }

    // MARK: - Parakeet Backend

    /// Fixed local port for the Parakeet sidecar — shared with the Node server's
    /// PARAKEET_PORT default and ./scripts/start.sh.
    private let parakeetPort = "8077"

    /// Resolve the `uv` binary (Astral installer drops it in ~/.local/bin).
    private var uvPath: String? {
        let candidates = [
            NSString("~/.local/bin/uv").expandingTildeInPath,
            "/opt/homebrew/bin/uv",
            "/usr/local/bin/uv",
        ]
        return candidates.first { FileManager.default.fileExists(atPath: $0) }
    }

    /// Resolve the Parakeet sidecar script (bundle → dev).
    private var parakeetScriptPath: String? {
        if isPackaged, let res = Bundle.main.resourcePath {
            let p = "\(res)/parakeet-server.py"
            if FileManager.default.fileExists(atPath: p) { return p }
        }
        let dev = NSString("~/Projects/meeting-copilot/scripts/parakeet-server.py").expandingTildeInPath
        return FileManager.default.fileExists(atPath: dev) ? dev : nil
    }

    /// Decide the transcription backend ONCE. Honors an explicit
    /// TRANSCRIPTION_PROVIDER override; otherwise defaults to Parakeet when
    /// `uv` + the sidecar are available, else whisper. Read by both the backend
    /// launcher and the Node server's env so they always agree.
    private var transcriptionProvider: String {
        let override = ProcessInfo.processInfo.environment["TRANSCRIPTION_PROVIDER"]?.lowercased()
        if let o = override, !o.isEmpty { return o }
        if uvPath != nil, parakeetScriptPath != nil { return "parakeet" }
        return "whisper"
    }

    /// Resolve the Silero VAD model path (user → bundle → nil).
    /// Trimming silent audio inside whisper_full() eliminates most silence
    /// hallucinations and cuts decode time on mostly-silent chunks. If this
    /// returns nil, whisper-server launches without VAD (graceful degrade).
    ///
    /// Size gate: a real Silero model is ~864 KB. If setup.sh wrote an error
    /// body (Hugging Face 404 returns ~15 bytes of plain text), skip it —
    /// whisper-server would crash loading that as a GGML file.
    private var vadModelPath: String? {
        let candidates = [
            NSString("~/.meeting-copilot/models/ggml-silero-v5.1.2.bin").expandingTildeInPath,
            Bundle.main.resourcePath.map { "\($0)/models/ggml-silero-v5.1.2.bin" } ?? "",
        ]
        for path in candidates where !path.isEmpty {
            guard FileManager.default.fileExists(atPath: path) else { continue }
            if let attrs = try? FileManager.default.attributesOfItem(atPath: path),
               let size = attrs[.size] as? Int, size >= 500_000 {
                return path
            } else {
                appLog("[ProcessSupervisor] VAD model at \(path) is too small (likely corrupt / error body) — ignoring.")
            }
        }
        return nil
    }

    /// Quick preflight: confirm the installed whisper-cpp recognises the
    /// --vad-model flag. Older builds will abort on unknown flag, so we
    /// detect by checking --help output rather than running a probe.
    /// Returns true if VAD flags are safe to pass.
    private func whisperSupportsVAD(at binaryPath: String) -> Bool {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: binaryPath)
        task.arguments = ["--help"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = pipe
        do {
            try task.run()
            task.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""
            return output.contains("--vad-model")
        } catch {
            return false
        }
    }

    /// Build a process environment with every location our spawned subprocesses
    /// rely on. Finder-launched apps get a minimal PATH; the Node server in
    /// turn spawns `claude`, `gemini`, `codex`, and `node` itself, each of
    /// which may live in a different directory depending on how the user
    /// installed them:
    ///   - Homebrew:   /opt/homebrew/bin, /usr/local/bin
    ///   - npm global: ~/.local/bin, ~/.nvm/versions/node/*/bin
    ///   - Claude CLI: ~/.local/bin  (npm -g install @anthropic-ai/claude-code)
    /// Missing any of these makes extraction/triage/suggestions fail silently
    /// with ENOENT that never surfaces to the user. Scan the home directory at
    /// startup so we self-heal against new nvm versions.
    private func processEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let home = NSHomeDirectory()
        var extraPaths: [String] = [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "\(home)/.local/bin",
        ]
        // Include every nvm-installed Node's bin directory so CLIs installed via
        // `npm -g` remain discoverable even after the user switches Node versions.
        let nvmRoot = "\(home)/.nvm/versions/node"
        if let versionDirs = try? FileManager.default.contentsOfDirectory(atPath: nvmRoot) {
            for v in versionDirs {
                let binDir = "\(nvmRoot)/\(v)/bin"
                if FileManager.default.fileExists(atPath: binDir) {
                    extraPaths.append(binDir)
                }
            }
        }
        // Build PATH so the system/homebrew paths ALWAYS come first, even if
        // they already appear later in the inherited PATH. This matters when
        // the app is launched from a shell where nvm has injected its own
        // Node bin dir — without this, child processes spawned via `env node`
        // would pick up a different Node ABI than the one the bundle was
        // compiled against (gotcha #14). Downstream CLIs spawned by the
        // Node server (claude, gemini, codex) may still live under ~/.nvm,
        // so we still append those dirs — just LAST.
        let currentPath = env["PATH"] ?? "/usr/bin:/bin"
        let currentComponents = currentPath.split(separator: ":").map(String.init)
        let priorityPaths = extraPaths // /opt/homebrew/bin, /usr/local/bin, ~/.local/bin, nvm/*
        let prioritySet = Set(priorityPaths)
        let leftover = currentComponents.filter { !prioritySet.contains($0) }
        env["PATH"] = (priorityPaths + leftover).joined(separator: ":")
        // The child server binds COPILOT_PORT — pass the app's resolved port
        // so the two halves can never disagree about where the server lives.
        env["COPILOT_PORT"] = String(ServerConfig.port)
        return env
    }

    // MARK: - Port Checks

    /// Check if a port already has a healthy process listening.
    /// Returns true if the port is in use by another process (not ours).
    private func isPortInUse(_ port: String) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-ti", "tcp:\(port)"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            guard let output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !output.isEmpty else { return false }
            return true
        } catch {
            return false
        }
    }

    /// Kill orphaned processes on the copilot server port only.
    /// Whisper port (8078) is NOT killed — it may be shared with notes4chris.
    func cleanupOrphans() {
        // Only clean up the copilot server port — whisper may be shared
        let port = String(ServerConfig.port)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-ti", "tcp:\(port)"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            guard let output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !output.isEmpty else { return }
            let pids = output.components(separatedBy: "\n").compactMap { Int32($0.trimmingCharacters(in: .whitespaces)) }
            let myPID = ProcessInfo.processInfo.processIdentifier
            for pid in pids where pid != myPID {
                print("[ProcessSupervisor] Killing orphaned Server process (PID: \(pid)) on port \(port)")
                kill(pid, SIGKILL)
            }
        } catch {
            print("[ProcessSupervisor] Failed to check port \(port): \(error)")
        }
    }

    // MARK: - Start Server

    func startServer() {
        guard !serverRunning else { return }
        isStopping = false
        serverRestartCount = 0
        hasAlertedOnCrashLoop = false
        launchServer()
        startHealthProbe()
    }

    // MARK: - Health Probe

    /// Periodically poll `/health` to detect servers that are running but
    /// unresponsive (hung event loop, stuck Node process). When probes fail
    /// `healthFailThreshold` times in a row we force-restart the server.
    /// Also resets the restart budget when the server has been healthy for
    /// `healthCountResetSeconds` — so a long-running session that recovers
    /// from one hiccup doesn't carry a maxed-out restart counter forever.
    private func startHealthProbe() {
        healthProbeTask?.cancel()
        healthProbeTask = Task.detached { [weak self] in
            guard let self = self else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(self.healthProbeInterval * 1_000_000_000))
                await self.runHealthProbe()
            }
        }
    }

    @MainActor
    private func runHealthProbe() async {
        // Don't probe if we're not supposed to be running
        guard serverRunning else { return }

        let healthURL = ServerConfig.url("/health")
        var request = URLRequest(url: healthURL, timeoutInterval: 3.0)
        request.cachePolicy = .reloadIgnoringLocalCacheData

        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            if ok {
                onHealthSuccess()
            } else {
                onHealthFailure(reason: "non-200")
            }
        } catch {
            onHealthFailure(reason: error.localizedDescription)
        }
    }

    @MainActor
    private func onHealthSuccess() {
        serverHealthy = true
        consecutiveHealthFailures = 0
        let now = Date()
        if let lastHealthy = lastHealthyAt,
           now.timeIntervalSince(lastHealthy) > healthCountResetSeconds,
           serverRestartCount > 0 {
            print("[ProcessSupervisor] Server has been healthy — resetting restart count")
            serverRestartCount = 0
            hasAlertedOnCrashLoop = false
        }
        lastHealthyAt = now
    }

    @MainActor
    private func onHealthFailure(reason: String) {
        serverHealthy = false
        consecutiveHealthFailures += 1
        print("[ProcessSupervisor] Health probe failed (\(consecutiveHealthFailures)/\(healthFailThreshold)): \(reason)")

        guard consecutiveHealthFailures >= healthFailThreshold else { return }

        // Server is hung or unreachable for >= threshold * interval seconds.
        // Force-kill it so the exit monitor relaunches it.
        consecutiveHealthFailures = 0
        if let proc = serverProcess, proc.isRunning {
            print("[ProcessSupervisor] Health probe threshold reached — killing hung server (PID: \(proc.processIdentifier))")
            kill(proc.processIdentifier, SIGKILL)
        } else {
            // Process already gone but we never caught the exit — relaunch directly.
            print("[ProcessSupervisor] Server process missing — relaunching")
            launchServer()
        }
    }

    @MainActor
    private func notifyCrashLoop() {
        guard !hasAlertedOnCrashLoop else { return }
        hasAlertedOnCrashLoop = true
        // Surface via appLog (writes to ~/.meeting-copilot/app.log directly —
        // stderr is NOT redirected there, see gotcha #15) and a user
        // notification so the user knows to check logs / quit-and-relaunch
        // instead of waiting for a server that isn't coming back.
        appLog("[ProcessSupervisor] CRASH LOOP: server has failed \(serverRestartCount) times. Giving up until next manual restart.")
        NotificationManager.shared.postServerCrashLoopNotification()
    }

    /// Resolve Node to an absolute path using the same ranked list that
    /// scripts/build-app.sh uses when compiling native modules. Falling back
    /// to `env node` lets the PATH the Swift app inherits from its launcher
    /// (shell / Finder / Xcode) pick a different Node — and when nvm's v24
    /// (ABI 137) ends up ahead of /usr/local/bin's v20 (ABI 115), the
    /// better-sqlite3 native module built at bundle time fails to load at
    /// runtime (gotcha #14). Resolving to an absolute path is immune to
    /// inherited PATH.
    private var nodeBinaryPath: String? {
        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
        ]
        for candidate in candidates {
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    private func launchServer() {
        serverGeneration += 1
        let generation = serverGeneration
        let process = Process()
        let serverDir = serverPath

        // In dev: use npx tsx to run TypeScript directly
        // In production: dist/index.js would be pre-compiled
        let distPath = "\(serverDir)/dist/index.js"
        if FileManager.default.fileExists(atPath: distPath), let nodePath = nodeBinaryPath {
            process.executableURL = URL(fileURLWithPath: nodePath)
            process.arguments = ["dist/index.js"]
            print("[ProcessSupervisor] Spawning server with \(nodePath)")
        } else if FileManager.default.fileExists(atPath: distPath) {
            // Fallback: no system Node on the usual paths — best-effort via env.
            // Likely to hit ABI mismatch but at least tries to start.
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["node", "dist/index.js"]
            print("[ProcessSupervisor] WARNING: no /opt/homebrew/bin/node or /usr/local/bin/node — falling back to env node")
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["npx", "tsx", "src/index.ts"]
        }
        process.currentDirectoryURL = URL(fileURLWithPath: serverDir)

        // Inherit environment with homebrew paths and set NODE_ENV
        var env = processEnvironment()
        env["NODE_ENV"] = isPackaged ? "production" : "development"
        // Pin the Node server to the transcription backend the supervisor runs,
        // so createProvider() in transcription/index.ts always matches what is
        // actually listening (Parakeet sidecar vs whisper-server).
        env["TRANSCRIPTION_PROVIDER"] = transcriptionProvider
        if transcriptionProvider == "parakeet" {
            env["PARAKEET_PORT"] = parakeetPort
        }
        process.environment = env

        // Pipe output for logging
        let pipe = makeOutputPipe(prefix: "Server")
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
            self.serverProcess = process
            self.serverRunning = true
            print("[ProcessSupervisor] Server started (PID: \(process.processIdentifier))")

            // Monitor for unexpected termination
            let task = Task.detached { [self] in
                process.waitUntilExit()
                await MainActor.run {
                    guard self.serverGeneration == generation, self.serverProcess === process else { return }
                    self.closeOutputPipe(for: process)
                    self.serverProcess = nil
                    self.serverRunning = false
                    self.serverHealthy = false
                    print("[ProcessSupervisor] Server exited (code: \(process.terminationStatus))")

                    // Auto-restart on any unexpected exit. Code 0 usually means we
                    // called stopAll() intentionally; anything else (including
                    // SIGKILL from the health probe) should trigger recovery.
                    guard !self.isStopping, process.terminationStatus != 0 else { return }

                    if self.serverRestartCount >= self.maxRestartAttempts {
                        self.notifyCrashLoop()
                        return
                    }
                    self.serverRestartCount += 1
                    let idx = min(self.serverRestartCount - 1, self.restartBackoffSeconds.count - 1)
                    let delay = self.restartBackoffSeconds[idx]
                    print("[ProcessSupervisor] Restarting server in \(delay)s (attempt \(self.serverRestartCount)/\(self.maxRestartAttempts))…")
                    let restartTask = Task { [weak self] in
                        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                        guard let self = self, !Task.isCancelled, !self.isStopping,
                              self.serverProcess == nil else { return }
                        self.launchServer()
                    }
                    self.monitorTasks.append(restartTask)
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
        // The default backend is Parakeet (see transcriptionProvider). Dispatch
        // to the sidecar when selected; otherwise run whisper-server as before.
        if transcriptionProvider == "parakeet" {
            startParakeet()
            return
        }

        guard !whisperRunning else { return }
        isStopping = false

        // If whisper-server is already running on 8078 (e.g. from notes4chris), reuse it
        if isPortInUse("8078") {
            print("[ProcessSupervisor] Whisper already running on port 8078 — reusing existing instance")
            whisperRunning = true
            return
        }

        whisperRestartCount = 0
        launchWhisper()
    }

    private func launchWhisper() {
        whisperGeneration += 1
        let generation = whisperGeneration
        let path = whisperPath
        guard FileManager.default.fileExists(atPath: path) else {
            print("[ProcessSupervisor] whisper-server not found at \(path)")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)

        // Prefer user model, fall back to bundle model
        let userModelPath = NSString("~/.meeting-copilot/models/ggml-base.en.bin").expandingTildeInPath
        let bundleModelPath = Bundle.main.resourcePath.map { "\($0)/models/ggml-base.en.bin" }
        let modelPath: String
        if FileManager.default.fileExists(atPath: userModelPath) {
            modelPath = userModelPath
        } else if let bPath = bundleModelPath, FileManager.default.fileExists(atPath: bPath) {
            modelPath = bPath
        } else {
            modelPath = userModelPath // Will fail, but gives a clear error
        }
        var args: [String] = [
            "--model", modelPath,
            "--port", "8078",
            "--threads", "4",
            "--no-timestamps",
        ]

        // VAD: trims silence inside whisper_full(), slashing decode time on
        // sparse-speech chunks and killing silence hallucinations at the
        // source. Requires whisper-cpp ≥ the release that added --vad-model.
        if let vadPath = vadModelPath {
            if whisperSupportsVAD(at: path) {
                args.append(contentsOf: [
                    "--vad",
                    "--vad-model", vadPath,
                    "--vad-threshold", "0.50",
                    "--vad-min-speech-duration-ms", "250",
                    "--vad-min-silence-duration-ms", "100",
                    "--vad-speech-pad-ms", "30",
                ])
                appLog("[ProcessSupervisor] whisper VAD enabled (\(vadPath))")
            } else {
                appLog("[ProcessSupervisor] whisper-cpp is too old for --vad-model; upgrade with `brew upgrade whisper-cpp`. Launching without VAD.")
            }
        } else {
            appLog("[ProcessSupervisor] VAD model not found — run `./scripts/setup.sh` or rebuild the .app to bundle it. Launching without VAD.")
        }

        process.arguments = args

        let pipe = makeOutputPipe(prefix: "Whisper")
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
            self.whisperProcess = process
            self.whisperRunning = true
            print("[ProcessSupervisor] Whisper started (PID: \(process.processIdentifier))")

            let task = Task.detached { [self] in
                process.waitUntilExit()
                await MainActor.run {
                    guard self.whisperGeneration == generation, self.whisperProcess === process else { return }
                    self.closeOutputPipe(for: process)
                    self.whisperProcess = nil
                    self.whisperRunning = false
                    print("[ProcessSupervisor] Whisper exited (code: \(process.terminationStatus))")

                    if !self.isStopping && process.terminationStatus != 0 && self.whisperRestartCount < self.maxRestartAttempts {
                        self.whisperRestartCount += 1
                        let idx = min(self.whisperRestartCount - 1, self.restartBackoffSeconds.count - 1)
                        let delay = self.restartBackoffSeconds[idx]
                        print("[ProcessSupervisor] Restarting whisper in \(delay)s (attempt \(self.whisperRestartCount)/\(self.maxRestartAttempts))…")
                        let restartTask = Task { [weak self] in
                            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                            guard let self = self, !Task.isCancelled, !self.isStopping,
                                  self.whisperProcess == nil else { return }
                            self.launchWhisper()
                        }
                        self.monitorTasks.append(restartTask)
                    }
                }
            }
            monitorTasks.append(task)
        } catch {
            print("[ProcessSupervisor] Failed to start whisper: \(error)")
            whisperRunning = false
        }
    }

    // MARK: - Start Parakeet (default backend)

    func startParakeet() {
        guard !parakeetRunning else { return }
        isStopping = false
        // Reuse an already-running sidecar (e.g. from ./scripts/start.sh or a
        // prior launch) — mirrors the whisper-on-8078 reuse.
        if isPortInUse(parakeetPort) {
            appLog("[ProcessSupervisor] Parakeet sidecar already running on \(parakeetPort) — reusing existing instance")
            parakeetRunning = true
            return
        }
        parakeetRestartCount = 0
        launchParakeet()
    }

    private func launchParakeet() {
        parakeetGeneration += 1
        let generation = parakeetGeneration
        guard let uv = uvPath, let script = parakeetScriptPath else {
            appLog("[ProcessSupervisor] Parakeet sidecar unavailable (uv or script missing). Transcription will be degraded — install uv (curl -LsSf https://astral.sh/uv/install.sh | sh) or set TRANSCRIPTION_PROVIDER=whisper.")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: uv)
        // `uv run` resolves the script's inline (PEP 723) deps + the Parakeet
        // model on first launch (setup.sh pre-pulls them), then serves
        // /inference on parakeetPort — the same contract whisper-server exposes.
        process.arguments = ["run", script, "--port", parakeetPort]
        process.environment = processEnvironment()

        let pipe = makeOutputPipe(prefix: "Parakeet")
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
            self.parakeetProcess = process
            self.parakeetRunning = true
            appLog("[ProcessSupervisor] Parakeet sidecar started (PID: \(process.processIdentifier)) via \(uv)")

            let task = Task.detached { [self] in
                process.waitUntilExit()
                await MainActor.run {
                    guard self.parakeetGeneration == generation, self.parakeetProcess === process else { return }
                    self.closeOutputPipe(for: process)
                    self.parakeetProcess = nil
                    self.parakeetRunning = false
                    print("[ProcessSupervisor] Parakeet exited (code: \(process.terminationStatus))")

                    if !self.isStopping && process.terminationStatus != 0 && self.parakeetRestartCount < self.maxRestartAttempts {
                        self.parakeetRestartCount += 1
                        let idx = min(self.parakeetRestartCount - 1, self.restartBackoffSeconds.count - 1)
                        let delay = self.restartBackoffSeconds[idx]
                        print("[ProcessSupervisor] Restarting Parakeet in \(delay)s (attempt \(self.parakeetRestartCount)/\(self.maxRestartAttempts))…")
                        let restartTask = Task { [weak self] in
                            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                            guard let self = self, !Task.isCancelled, !self.isStopping,
                                  self.parakeetProcess == nil else { return }
                            self.launchParakeet()
                        }
                        self.monitorTasks.append(restartTask)
                    }
                }
            }
            monitorTasks.append(task)
        } catch {
            appLog("[ProcessSupervisor] Failed to start Parakeet sidecar: \(error)")
            parakeetRunning = false
        }
    }

    // MARK: - Stop All

    func stopAll() async {
        isStopping = true
        serverGeneration += 1
        whisperGeneration += 1
        parakeetGeneration += 1
        // Cancel monitor + health tasks
        for task in monitorTasks {
            task.cancel()
        }
        monitorTasks = []
        healthProbeTask?.cancel()
        healthProbeTask = nil
        serverHealthy = false

        // Graceful shutdown: SIGTERM, wait, then SIGKILL if needed
        await stopProcess(serverProcess, name: "Server")
        await stopProcess(whisperProcess, name: "Whisper")
        await stopProcess(parakeetProcess, name: "Parakeet")

        serverProcess = nil
        whisperProcess = nil
        parakeetProcess = nil
        serverRunning = false
        whisperRunning = false
        parakeetRunning = false
    }

    private func stopProcess(_ process: Process?, name: String) async {
        guard let process = process else { return }
        if !process.isRunning {
            closeOutputPipe(for: process)
            return
        }

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
        closeOutputPipe(for: process)
    }
}
