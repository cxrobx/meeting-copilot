# Known Gotchas

Organized by category. 14 items + recovery playbook, condensed format. Original numbering preserved (gaps intentional).

## Index

| # | Issue | Category |
|---|-------|----------|
| 1 | ScreenCaptureKit permissions | Environment |
| 2 | whisper-server must be running | Environment |
| 3 | Large index.ts monolith (partially addressed) | Backend |
| 4 | TranscriptSegment.timestamp is epoch-ms | Backend |
| 5 | TranscriptSegment.duration is whisper latency | Backend |
| 6 | Finder-launched .app has minimal PATH | Environment |
| 7 | Preflight check endpoint exists | Backend |
| 8 | JSONL writes use O_APPEND for atomicity | Backend |
| 9 | Claude CLI JSON output has escape sequences | Backend |
| 10 | Claude CLI has no --max-tokens flag | Backend |
| 11 | WKWebView needs health polling before load | Frontend |
| 12 | ScreenCaptureKit silent frames — ARK.driver in coreaudiod | Environment |
| 13 | Claude CLI at `~/.local/bin` not on bundle's PATH | Environment |
| 14 | Native-module ABI mismatch between build and runtime Node | Deployment |
| 15 | Bundle PATH and app.log vs stderr — diagnostics go missing | Environment |
| 16 | Silero VAD model required for silence handling + latency; whisper-cpp version gate | Environment |
| 17 | TranscriptSegment.duration is deprecated — use audioDurationSec / transcriptionLatencyMs | Backend |
| 18 | AVAudioEngine input device-change crashes — installTap NSException → SIGABRT | Frontend |
| 19 | Silero VAD Metal graph aborts on pre-M5 Apple Silicon | Frontend |
| — | **Recovery playbook** (system-wide SCK silence, server crash loops, zombie processes) | — |

Standard categories: Environment, Database, Backend, Frontend, Security, Deployment, External APIs

---

## Environment

### 1. ScreenCaptureKit Requires Screen Recording Permission
**Symptom**: Audio capture silently fails, no transcription data
**Cause**: macOS requires explicit Screen Recording permission for ScreenCaptureKit
**Solution**: System Settings → Privacy & Security → Screen Recording → enable Meeting Copilot. Must restart app after granting.
**Pattern**: `app/MeetingCopilot/Core/`

### 2. whisper-server Must Be Running Before Server Start
**Symptom**: Transcription endpoint returns errors, no transcript output
**Cause**: Server assumes whisper-server is available at startup; no automatic retry/discovery
**Solution**: Run `./scripts/start.sh` which launches whisper-server first, or start manually before `npm run dev`
**Pattern**: `scripts/start.sh`

## Backend

### 3. server/src/index.ts Is a ~20KB Monolith (Partially Addressed)
**Symptom**: Difficult to navigate, large diffs, merge conflicts
**Cause**: MVP development concentrated logic in single entry point
**Solution**: WS connection handlers were deduplicated into `handleWsConnection()`. Further extraction to `src/routes/`, `src/websocket.ts` still recommended.
**Pattern**: `server/src/index.ts`

### 4. TranscriptSegment.timestamp Is Epoch Milliseconds, Not Relative Seconds
**Symptom**: Shared transcript produces absurd timestamps (millions of hours) in companion outputs
**Cause**: `segment.timestamp` is `Date.now()` (epoch-ms). Consumers expecting relative seconds get garbage.
**Solution**: `shared.ts` converts to session-relative seconds: `(segment.timestamp - sessionStartMs) / 1000`
**Pattern**: `server/src/session/shared.ts:85-86`

### 5. TranscriptSegment.duration Is Whisper Processing Latency, Not Audio Length
**Symptom**: CSV `end` timestamps nearly identical to `start` (sub-second segments)
**Cause**: `segment.duration` is how long whisper took to process (~0.5-2s), not the audio chunk length (10s)
**Solution**: `shared.ts` uses `CHUNK_DURATION_SECONDS = 10` instead of `segment.duration`
**Pattern**: `server/src/session/shared.ts:78`

### 6. Finder-Launched .app Has Minimal PATH
**Symptom**: `node` command not found when running from `/Applications`
**Cause**: Apps launched from Finder/Spotlight get a stripped PATH without `/opt/homebrew/bin`
**Solution**: `ProcessSupervisor.processEnvironment()` injects homebrew paths before launching child processes
**Pattern**: `app/MeetingCopilot/Sources/Core/Process/ProcessSupervisor.swift:61-70`

### 9. Claude CLI `--output-format json` Has Terminal Escape Sequences
**Symptom**: Raw JSON blob `{"type":"result",...}` appears in worker output cards
**Cause**: CLI wraps output in OSC escape sequences (`\x1b]0;...\x1b\`) that break `JSON.parse`. Also, `result` field is empty string on `error_max_turns`.
**Solution**: Strip escapes with `/\x1b\].*?(?:\x07|\x1b\\)/gs`, find JSON by `indexOf('{')`/`lastIndexOf('}')`, treat empty `result` as fallback.
**Pattern**: `server/src/claude-cli.ts:62-85`

### 10. Claude CLI Has No `--max-tokens` Flag
**Symptom**: Every intelligence eval silently fails with "unknown option '--max-tokens'"
**Cause**: `--max-tokens` is an API parameter, not a CLI flag. CLI uses `--max-budget-usd` for cost control.
**Solution**: Removed `--max-tokens` from `claudeChat()` args.
**Pattern**: `server/src/claude-cli.ts:31`

### 12. ScreenCaptureKit Silent Frames — ARK.driver in coreaudiod (Applied Workaround)
**Symptom**: Meeting-audio transcript is entirely whisper's silence hallucinations (`you`, `(bell dings)`), while mic transcript is normal. `[Audio] Chunk received … source: meeting` arrives at full cadence with the right byte count. `[AudioCapture] meeting peak=0.0000` every single second in `~/.meeting-copilot/app.log`.
**Root cause** (confirmed cross-app 2026-04-21; affects notes4chris too, i.e. anything using `SCStream`): **Rogue Amoeba's `ARK.driver` has loaded inside `coreaudiod`**. Once ARK is in the HAL graph, a display-scoped `SCContentFilter(display:excludingApplications:[])` returns valid-sized buffers full of zeros because the audio has already been tapped upstream. Confirm with:
```
sudo sample coreaudiod 5 2>&1 | grep -i ARK.driver
```
(non-empty grep = ARK is loaded). Also check `kextstat 2>/dev/null | grep -iE "ARK|ACE"` and `launchctl list | grep rogueamoeba`. Bluetooth output (AirPods) and aggregate/virtual devices (BlackHole, Muse, ZoomAudioDevice) also trigger the same display-filter silence path on macOS 14.x.
**Solution** (applied): Switched `SCContentFilter` to the per-app form: `SCContentFilter(display: display, including: capturedApps, exceptingWindows: [])`, where `capturedApps = content.applications.filter { $0.processID != ownPid }`. This taps per-app audio directly rather than the display's mix, bypassing the ARK interference. Diagnostics are mandatory — `[AudioCapture] meeting peak=…` is logged per second and the output device is logged at stream start, so the next incident is diagnosable in one grep.
**Pattern**: `app/MeetingCopilot/Sources/Core/Audio/AudioCaptureManager.swift:167-225` (filter + per-second peak log + device snapshot)

### 13. Claude CLI Lives at `~/.local/bin/claude`, Not on Bundle's Injected PATH
**Symptom**: Agenda extraction (`/agenda/extract`) returns 502 "Extraction failed — try again or edit manually". Worker cards that call the CLI silently fail. No helpful trace in `server.log` — `execFile` throws `ENOENT` before anything is logged.
**Cause**: `ProcessSupervisor.processEnvironment()` injects `/opt/homebrew/bin`, `/opt/homebrew/sbin`, `/usr/local/bin` into PATH before spawning the server. The Claude CLI is installed via `npm -g` into `~/.local/bin/claude`, which is not on that list. `execFile('claude', …)` resolves via PATH and returns ENOENT.
**Solution**: Two prongs.
  1. `processEnvironment()` now also appends `~/.local/bin` and every `~/.nvm/versions/node/*/bin` directory (globbed at startup) so CLIs installed via npm / nvm remain discoverable after Node version changes.
  2. `extractAgendaItemsFromNotes` prefers the direct Anthropic API via `anthropicTriageJson` when `ANTHROPIC_API_KEY` is set — same path the agenda-eval loop already uses — falling back to the CLI only when no key is present. Sidesteps PATH issues entirely.
**Pattern**: `app/MeetingCopilot/Sources/Core/Process/ProcessSupervisor.swift:69-105` (PATH injection), `server/src/intelligence/agenda.ts:830-900` (API-first extract).

### 14. Native-Module ABI Mismatch Between Build and Runtime Node
**Symptom**: Start Session fails silently; `server.log` shows `WS/TCP Handler error: NODE_MODULE_VERSION 137 … requires 115` with `better_sqlite3.node` in the stack. Every `session.start` throws in `new Database()` before the session is created, which also breaks anything downstream (extraction, agenda tracker) that depended on that session.
**Cause**: `./scripts/build-app.sh` ran `npm ci` using the shell's default Node (e.g. nvm's v24, ABI 137), but `ProcessSupervisor` spawns the server with PATH prepended to include `/opt/homebrew/bin:/usr/local/bin`, where `node` is v20 (ABI 115). The compiled `better-sqlite3.node` is an older-Node binary from the build shell's perspective; at runtime the older Node refuses to load it.
**Solution**: `build-app.sh` now pins `PATH` to the first existing Node in `/opt/homebrew/bin` → `/usr/local/bin` (the same resolution order `ProcessSupervisor` uses), then verifies the native module loads under that runtime Node with `node -e "require('…/better-sqlite3')"` before the bundle is considered good. If it doesn't, the build aborts with a clear rebuild hint instead of shipping a broken bundle.
**Pattern**: `scripts/build-app.sh:11-40` (Node pin + sanity check).

### 15. Diagnostics Go Missing: `fputs(stderr)` ≠ `~/.meeting-copilot/app.log`
**Symptom**: Swift-side `fputs("…", stderr)` lines never appear in `~/.meeting-copilot/app.log` even though "stderr is captured" seems plausible.
**Cause**: `app.log` is written only by the `appLog(_:)` function in `SessionManager.swift`, which calls `FileHandle.seekToEndOfFile()` directly. Nothing redirects the Swift process's stderr to that file — stderr goes to the launchd-backed system log instead. Child processes (node server, whisper) also write to `server.log` directly, not via `app.log`.
**Solution**: All diagnostic logging from the Swift side must use `appLog("…")` (free function, globally accessible). Reserve `fputs(stderr)` for absolute last-resort fallbacks (e.g. `NotificationManager` failure path).
**Pattern**: `app/MeetingCopilot/Sources/Core/Session/SessionManager.swift:6-17` (appLog definition).

### 16. Silero VAD Model Required; whisper-cpp Version Gate
**Symptom**: Transcript panel shows lots of "you"/"[ Silence ]"/"[typing sounds]" hallucinations on silent audio, AND chunks on sparse-speech audio take as long to transcribe as chunks on fully-spoken audio.
**Cause**: Silero VAD (`ggml-silero-v5.1.2.bin`) trims silent regions INSIDE `whisper_full()` before decoding. Without it, whisper runs the decoder on silence and emits hallucinations (and the text filter catches them after the fact). The flag `--vad-model` was added in a recent whisper-cpp release; older Homebrew installs reject it.
**Solution** (applied): Model is downloaded by `scripts/setup.sh` into `~/.meeting-copilot/models/`, bundled by `scripts/build-app.sh` into `Contents/Resources/models/`, and passed to whisper-server via `--vad --vad-model <path>`. Both `scripts/start.sh` and `ProcessSupervisor.launchWhisper()` first check `whisper-server --help` for `--vad-model`; if absent, they log a loud warning and launch without VAD (graceful degrade — text-level hallucination filter still catches residuals).
**Pattern**: `scripts/start.sh:46-76`, `app/MeetingCopilot/Sources/Core/Process/ProcessSupervisor.swift:79-120` (vadModelPath + whisperSupportsVAD), `scripts/build-app.sh:153-162` (bundling).

### 17. TranscriptSegment.duration Is Deprecated (v2)
**Symptom**: Code reads `segment.duration` and gets inconsistent values — sometimes audio length (seconds), sometimes whisper latency (ms).
**Cause**: Historical conflation — `server/src/transcription/index.ts` wrote whisper latency into `duration`, but `shared.ts` and UI treated it as audio seconds.
**Solution** (applied): Split into two explicit fields — `audioDurationSec` (real audio length in seconds) and `transcriptionLatencyMs` (provider processing time in milliseconds). `duration` kept as alias of `audioDurationSec` during v2 rollout; remove after Swift decoder + any external consumers migrate.
**Pattern**: `server/src/transcription/types.ts`, `app/MeetingCopilot/Sources/Models/TranscriptSegment.swift`.

### 18. AVAudioEngine Input Device-Change Crashes — installTap NSException → SIGABRT
**Symptom**: App aborts mid-session (SIGABRT, std::terminate from `_dispatch_main_queue_drain`) right after a route change — most reliably when AirPods (re)connect or you switch the default input. Crash report stack:
```
AVAE_RaiseException
AVAudioIONodeImpl::SetOutputFormat
-[AVAudioNode installTapOnBus:bufferSize:format:]
AudioCaptureManager.startMicrophoneCapture()
AudioCaptureManager.handleInputDeviceChange()
HALPropertyListener::Call
```
**Root cause**: HAL property listener fires on the main queue when `kAudioHardwarePropertyDefaultInputDevice` changes. The handler tore down the engine and immediately called `startMicrophoneCapture()`, which read `inputNode.inputFormat(forBus: 0)` and passed it back into `installTap(onBus:0,…,format:capturedFormat)`. During the transient window of a device flip the bus's format is mid-update, so the format we read doesn't match what `installTap` actually accepts — AVFoundation raises an Obj-C `NSException`. Swift cannot catch Obj-C exceptions with `do/try`, so it bubbles to `std::terminate` and the process aborts. ProcessSupervisor + the WS clients all die with it; whisper-server is left as an orphan on :8078.
**Solution** (applied 2026-04-22): Five-part hardening in `AudioCaptureManager.swift`, all gated by gotcha #15's `appLog`.
  1. Tiny Obj-C bridge target (`ObjCExceptionBridge/`) exposes `+catching:error:` so Swift can catch `NSException`. Imported as `try ObjCExceptionBridge.catching { … }` (renamed from `tryBlock` because Swift's importer would force backticks around `try`).
  2. `installTap` is now called with `format: nil` so AVAudioEngine uses the bus's *actual* current format (the documented robust pattern). The `AVAudioConverter` is rebuilt lazily inside the tap closure when `buffer.format` changes — handles devices whose native format changes mid-stream.
  3. `installTap` and the engine teardown are both wrapped in `ObjCExceptionBridge.catching` as a safety net for other malformed states (no input device, wedged engine).
  4. HAL listener events are debounced — `handleInputDeviceChange` schedules a single `DispatchWorkItem` 350ms in the future and cancels any prior one, coalescing the 3-5 events AirPods reconnects fire in ≤100ms. The work item is also cancelled in `stopCapture()` so it can never resurrect the engine after teardown.
  5. Failed restarts retry up to 3× with exponential backoff (200/400/800ms). If all retries fail, `onDeviceChangeError?()` surfaces a notification but the meeting keeps going (SCK / meeting audio is independent).
**Verification**: After applying, manually unplug/replug the input device (or AirPods reconnect) mid-session and confirm `[AudioCapture] mic restarted successfully after device change` appears in `~/.meeting-copilot/app.log`.
**Pattern**: `app/MeetingCopilot/Sources/Core/Audio/AudioCaptureManager.swift` (the entire mic path); `app/MeetingCopilot/ObjCExceptionBridge/` (bridge target); `app/MeetingCopilot/Package.swift` (target wiring).

### 19. Silero VAD Metal Graph Aborts on Pre-M5 Apple Silicon
**Symptom**: Starting real VAD processing aborts the entire Swift process in
`ggml_backend_sched_buffer_supported` with a message about a tensor allocated in
a Metal buffer that cannot run the operation. Because whisper.cpp aborts instead
of returning an error, Swift cannot recover or fall back.
**Cause**: whisper.cpp 1.8.3 can build an invalid mixed Metal/CPU graph for the
Silero VAD on Apple Silicon without the newer tensor API (confirmed on M2 Max).
The VAD model is only about 0.88 MB, so GPU setup provides no useful latency
benefit.
**Solution**: `VADProbe` defaults `useGPU` to `false`. Keep it on CPU unless a
new whisper.cpp release is explicitly soak-tested on every supported Mac tier.
Run the opt-in `RealAudioVADTests` against a private recording before changing
this default.
**Pattern**: `app/MeetingCopilot/Sources/Core/Audio/VADProbe.swift`,
`app/MeetingCopilot/Tests/RealAudioVADTests.swift`.

### 11. WKWebView Needs Health Polling Before Loading Localhost
**Symptom**: Blank white panel on app launch
**Cause**: WKWebView loads `/present` before the Node server finishes starting. Failed navigation shows blank page, `reload()` does nothing after failed provisional navigation.
**Solution**: `WebDashboardView.Coordinator.loadWhenReady()` polls `/health` until 200, then loads. Retries on navigation failure with `load(URLRequest(...))` not `reload()`.
**Pattern**: `app/MeetingCopilot/Sources/Features/WebPanel/WebDashboardView.swift`

---

## Recovery Playbook

When the app or session is stuck, work this ladder top-to-bottom. Each step is cheap and narrows the cause.

### A. Is the server even up?
```
lsof -i :17890 -i :8078                # ports (17890 server, 8078 whisper)
pgrep -fl "Meeting Copilot.app|whisper-server|meeting-copilot/server"
tail -30 ~/.meeting-copilot/server.log
tail -30 ~/.meeting-copilot/app.log
```
- No listener on :17890 → server crashed or never started; app will be in degraded mode. Relaunch the app (ProcessSupervisor respawns). If it won't come up, check `server.log` for the real error.
- `NODE_MODULE_VERSION … requires 115` → gotcha #14. Run `./scripts/build-app.sh` — the new script self-verifies native modules.

### B. Zombie / orphan processes after start-stop cycles
```
# Safe: only targets our server + whisper, not other Node apps.
pkill -f "Meeting Copilot.app/Contents/Resources/server"
pkill -f whisper-server
sleep 1
lsof -i :17890 -i :8078
```
Relaunch the app. `ProcessSupervisor.cleanupOrphans()` also targets :17890 on its own at startup, but only the server port — whisper (8078) is intentionally not killed because notes4chris may share it.

### C. Meeting audio silent while mic works
```
grep "peak=" ~/.meeting-copilot/app.log | tail -20
```
- `meeting peak=0.0000` consistently → gotcha #12. Identify ARK.driver:
  ```
  sudo sample coreaudiod 5 2>&1 | grep -i ARK.driver
  sudo launchctl list | grep rogueamoeba
  ```
  If ARK is loaded, the `including: apps` filter workaround (already in code) should already be capturing audio — if it still isn't, quarantine the Rogue Amoeba daemons during the session:
  ```
  sudo launchctl bootout system/com.rogueamoeba.arkaudiod 2>/dev/null
  sudo launchctl bootout system/com.rogueamoeba.loopbackd 2>/dev/null
  ```
- `mic peak=0.0000` while speaking → macOS TCC issue. Reset and re-grant:
  ```
  tccutil reset Microphone com.christopherrobinson.meeting-copilot
  tccutil reset ScreenCapture com.christopherrobinson.meeting-copilot
  ```

### D. Extraction / worker cards failing silently
```
grep -E "Extraction failed|api/anthropic|api/openai" ~/.meeting-copilot/server.log | tail -20
```
With `ANTHROPIC_API_KEY` set in `~/.meeting-copilot/.env`, extraction goes directly to the API (no CLI). If you see no API log line and a bare 502, the key isn't loading — verify `grep ANTHROPIC_API_KEY ~/.meeting-copilot/.env` returns a line and the server was restarted after you added it.

### E. Nothing else has worked
Restart the Mac. This genuinely clears stuck CoreAudio tap state (ARK, HAL plug-ins, aggregate devices) that no userspace command resets. Reserve for after A-D, but don't hesitate if they all come up clean and the symptom persists.

---

## Lifecycle Management

- **SUPERSEDED**: When a gotcha is resolved, mark it: `## #N: [Title] ~~SUPERSEDED~~`
- **Merging**: If two gotchas describe same root cause, merge and note consolidated numbers
- **Pruning**: When gotchas exceed 30 items or 15k chars, prune SUPERSEDED entries older than 90 days
- **Numbering**: Original numbers are permanent — gaps are intentional. Never renumber.
