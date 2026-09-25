# Known Gotchas

Organized by category. 30 items + recovery playbook, condensed format. Original numbering preserved (gaps intentional).

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
| 20 | Phone / FaceTime calls invisible to ScreenCaptureKit — meeting track is a Core Audio process tap | Environment |
| 21 | gpt-6-luna writes past its JSON object — parse the first complete object | External APIs |
| 22 | Dashboard JS lives in a TS template literal — escapes decode twice | Frontend |
| 23 | Swift's `.iso8601` rejects the server's milliseconds — messages silently dropped | Frontend |
| 24 | Dashboard JS is one scope — a second `var` silently replaces the first | Frontend |
| 25 | The title bar doesn't drag the panel — the page does (`data-drag-region`) | Frontend |
| 26 | Grok's stream restates the whole utterance — lines double unless compared by words | External APIs |
| 27 | A popover inside the sticky evidence tab bar hit-tests but never paints | Frontend |
| 28 | The mic engine stops mid-meeting on a configuration change, silently | Environment |
| 29 | An aborted OpenAI stream ends quietly: it looks finished and reports no usage | External APIs |
| 30 | Playwright newer than 1.61 cannot drive WebKit on macOS 14 — the ship gate breaks | Environment |
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

### 20. Phone / FaceTime Calls Are Invisible to ScreenCaptureKit — Meeting Track Is a Core Audio Process Tap
**Symptom**: On an iPhone call handed off to the Mac, or a FaceTime call, only your side is transcribed: `meeting peak=0.0000` for the whole call while `mic peak` moves.
**Cause**: The remote party is played by system daemons, not an app: `avconferenced` (confirmed on a live Continuity call, 2026-09-21, macOS 14.5, AirPods) and `callservicesd`. `SCShareableContent.applications` never lists them, so the per-app SCK filter (#12's workaround) cannot include them. Apple does not block this: nothing in the SDK headers, entitlements, or sandbox profiles excludes call audio, and the only gate is the System Audio Recording check (`kTCCServiceAudioCapture`) on the capturing app.
**Solution** (applied 2026-09-21): `SystemAudioTap` — `CATapDescription(monoGlobalTapButExcludeProcesses: [own process])`, `.unmuted`, a private **tap-only** aggregate device, IOProc → `AVAudioConverter` → 16 kHz mono → the same sink SCK uses (`ingestMeetingSamples`). It is the default backend; SCK is the automatic fallback when the tap fails to start or macOS is older than 14.2.
**Landmines**:
- **Tap-only aggregate — never add the output device as a subdevice.** A subdevice that has input streams (headsets, the Teams/Zoom virtual devices) puts its mic in the IOProc's buffer list ahead of the tap, i.e. your voice on the meeting track. Measured: buffers `[2ch + 1ch]` with ZoomAudioDevice as subdevice, `[1ch]` tap-only.
- **`.unmuted` only.** `.mutedWhenTapped` on `avconferenced` mutes the call itself and makes the remote party hear themselves (FineTune #113).
- **A missing `NSAudioCaptureUsageDescription` means silent zeros, `noErr`, and no prompt.** `verify-app.sh` refuses a bundle without it. A *denied* grant looks identical and no API reads it, so the 25 s all-zero watchdog names the permission when the tap is the backend.
- **The grant is keyed to the code signature.** The Developer ID build persists across rebuilds; an ad-hoc build re-prompts every time (seen with the CallTapProbe spike).
- **AirPods drop to a call sample rate without the default output device changing** (tap callbacks fell 86/s → 47/s when the call connected). The tap re-reads the aggregate's nominal rate every second and snaps to the measured rate after two consecutive >25% mismatches — grep app.log for `[SystemAudioTap] reported rate changed` / `RATE MISMATCH`.
- `AudioDeviceStart` blocks while the first-run permission prompt is up, so `start()` runs off the main thread.
- macOS 26.0 / 26.0.1 had an Apple bug that silenced FaceTime/Phone capture (fixed in 26.1).
- On laptop speakers the mic also hears the remote party, so their lines land on both tracks (`dedup.ts` only trims chunk-boundary overlap). Headphones for calls.
**Rollback**: `defaults write com.christopherrobinson.meeting-copilot meetingAudioSource sck` (next session), or launch with `MC_MEETING_AUDIO=sck`.
**Pattern**: `app/MeetingCopilot/Sources/Core/Audio/SystemAudioTap.swift`, `AudioCaptureManager.startMeetingAudioCapture()`, `app/MeetingCopilot/Tests/SystemAudioTapTests.swift`.

### 28. The Mic Engine Stops Mid-Meeting on a Configuration Change, Silently
**Symptom**: Only the other side is transcribed. `mic peak=` lines stop partway through the session with no `Input device changed` line and no warning; the server gets no `source: mic` chunks.
**Cause**: AVAudioEngine stops itself when the audio configuration changes under it (AirPods renegotiating their call profile, a sample-rate change) and posts `AVAudioEngineConfigurationChange`. Nothing listened for it, and the watchdog only judged the *first* buffer, so one early buffer made the mic healthy for the rest of the meeting. Seen 2026-09-25: AirPods mic at 24 kHz stopped 28 s in, with the process tap starting at the same time.
**Solution** (applied 2026-09-25): an observer per engine schedules the debounced mic restart when the engine has stopped (a running one is left alone, so a fresh engine's own notification can't loop). The watchdog also treats 5 s without a buffer, after any were delivered, as dead, with the same 2-restart ladder, earned back after 30 s of delivery. Log lines: `mic engine configuration changed`, `WATCHDOG mic stalled`.
**Hardening (2026-09-25, same day), modelled on CXNotes: judge by the audio, restart in place, fail loudly.**
- **The mic is pinned to the built-in mic** (`MicDevicePicker`), not the system default. The default was the AirPods mic, the one that died; CXNotes, pinned to the built-in mic, recorded the same call cleanly. Falls back to the default when there is no built-in mic (lid closed). Change it with `defaults write com.christopherrobinson.meeting-copilot micDevice default|builtin|"<exact name>"` or `MC_MIC_DEVICE`. A pinned mic ignores default-input changes.
- **Exact-zero buffers for 15 s count as dead** (a working mic's noise floor is never exact zero). After the 2-restart ladder the watchdog keeps retrying every 30 s, never gives up, and clears its alarm on recovery.
- **A second watchdog in the server** (`capture/track-watch.ts`) judges the 100 ms frames that actually arrive: mic `stalled` (no frames for 10 s while the meeting track streams) or `silent` (exact zeros for 15 s). It broadcasts `capture.health`, which shows a red dashboard banner with **Restart mic** (→ `capture.restartMic` → the app) and tells the app, which restarts the mic at once.
- **Loud warnings:** either watchdog sets `SessionManager.micDead`, which swaps the menu bar's REC for a yellow **NO MIC** and posts a notification with sound that ignores the panel-in-front gate. Both clear themselves when audio returns.
**Check**: `Tests/CaptureHealthTests.swift` (`testMicThatStopsMidSessionIsCaught`, `testMicDeliveringOnlyExactZerosIsCaught`), `Tests/MicDevicePickerTests.swift`, `Tests/ServerMessageTests.swift` (capture messages), `server/src/__tests__/track-watch.test.ts`. End to end (2026-09-25): a fake app on a second server stopped mic frames; `capture.health` flagged the mic at exactly 10 s, the banner painted (screenshot), Restart mic reached the app, and the recovery cleared it.
**Workaround on an old build**: switch the input device in System Settings → Sound; the device-change listener restarts the mic.
**Pattern**: `app/MeetingCopilot/Sources/Core/Audio/AudioCaptureManager.swift` (`micVerdict`, `checkCaptureHealth`, `engineConfigObserver`, `pinMicrophone`), `Audio/MicDevicePicker.swift`, `server/src/capture/track-watch.ts`, `server/src/present/index.ts` (`capShowHealth`).

### 30. Playwright Newer Than 1.61 Cannot Drive WebKit on macOS 14 — the Ship Gate Breaks
**Symptom**: `npm run e2e` (so `ship.sh` step 3) fails every spec with `browserContext.newPage: Protocol error (Page.overrideSetting): Unknown setting: PushAPIEnabled` (1.63), or hangs at `newPage` until the test timeout (1.62). The server and seed are fine.
**Cause**: Playwright no longer builds WebKit for macOS 14. On mac14 every version from 1.59 on uses a frozen build (revision 2251, `webkit_mac14_arm64_special-2251` in `~/Library/Caches/ms-playwright`), and from 1.62 the driver expects settings that build does not have. Measured 2026-09-25: 1.59.1 and 1.61.1 work; 1.62.1 and 1.63.0 do not.
**Solution**: `@playwright/test` is pinned exact to **1.61.1** in `server/package.json`. Do not bump it (`npm update`, `npm audit fix --force`) while this Mac is on macOS 14. After macOS 15+, move to the latest and confirm with `npm run e2e`.
**Check**: the gate itself. A broken driver fails all six specs, so it can never pass silently.
**Pattern**: `server/package.json`, `server/e2e/playwright.config.ts`.

### 11. WKWebView Needs Health Polling Before Loading Localhost
**Symptom**: Blank white panel on app launch
**Cause**: WKWebView loads `/present` before the Node server finishes starting. Failed navigation shows blank page, `reload()` does nothing after failed provisional navigation.
**Solution**: `WebDashboardView.Coordinator.loadWhenReady()` polls `/health` until 200, then loads. Retries on navigation failure with `load(URLRequest(...))` not `reload()`.
**Pattern**: `app/MeetingCopilot/Sources/Features/WebPanel/WebDashboardView.swift`

## External APIs

### 21. gpt-6-luna Writes Past Its JSON Object — Parse the First Complete Object
**Symptom**: A live lane silently loses answers: triage returns `Failed to parse triage response` (read as *not actionable*), the coach or an agenda lane gets `null`. Nothing errors; the model call itself succeeded.
**Cause**: gpt-6-luna under a strict `json_schema` keeps writing after a valid object: a stray `"}`, `(Remember output contract…)`, `</|end|>`, or a second copy (16 of 128 agenda reconciles, 2026-09-22 replay). Once it wrote a *malformed* object (`{"id":"id":…`), then garbled text and "JSON malformed … Should correct", then a corrected one. gpt-5.6-luna never did either. Every parser sliced first `{` to LAST `}`, which swallows the tail, so `JSON.parse` threw.
**Solution** (applied 2026-09-22): all live-path parsers go through `intelligence/first-json.ts`: each complete top-level object in order (string/escape-aware), the first that parses **and** passes the caller's shape check, with the old slice as the last resort. Never hand-roll `indexOf('{')`/`lastIndexOf('}')` for model output again.
**Check**: `__tests__/first-json.test.ts` carries every real tail shape. `npm run eval:agenda` reports `schema` per model; a model swap that drops it below the baseline fails the gate.
**Pattern**: `server/src/intelligence/first-json.ts`; callers in `agenda.ts`, `coach.ts`, `index.ts` (triage), `factcheck.ts`.

### 26. Grok's Stream Restates the Whole Utterance — Lines Double Unless Compared by Words
**Symptom**: A long answer appears twice in one transcript line, or a second line repeats the first before continuing.
**Cause**: Grok's streaming events are cumulative: each partial, and the final `speech_final` event, carries the utterance from its start, and formatting shifts between them ("about like," → "about, like,"). Two places appended instead of replacing: an exact `startsWith(locked)` test missed the reworded repeat, and the 80-word cap closed a line while Grok's utterance went on, so the next event restated the closed text. Found by `npm run eval:gate` on the 2026-09-21 recording, where it cut apparent recall to 71%.
**Solution** (applied 2026-09-23): `streaming.ts` compares by words (`restatesLocked`, ≥80% of the locked words in place). A restating final replaces the locked text; a restating partial is shown alone; text of cap-closed lines is `carried` and stripped (`dropLeadingWords`) from the rest of that utterance.
**Check**: `__tests__/transcription-streaming.test.ts` replays both real shapes. `npm run eval:gate -- <recording> --noise` compares against a second ungated run; a duplication regression shows as ungated-vs-ungated recall collapsing.
**Pattern**: `server/src/transcription/streaming.ts` (`onPartial`).

### 29. An Aborted OpenAI Stream Ends Quietly: It Looks Finished and Reports No Usage
**Symptom**: The meeting chat's Stop left a half answer marked done (2026-09-25, "## Northwind next"), and the session's dollar ceiling fell behind whenever a stream was cut short.
**Cause**: With an `AbortSignal`, the `openai` SDK's `for await` over `responses.create({ stream: true })` just ends: no throw and no `response.completed`, so no `usage`. A caller that checks only for an exception reads a stopped answer as finished, and `recordLlmUsage` was told zero tokens for text that was billed.
**Solution** (applied 2026-09-25): after the answer returns, check `signal.aborted` yourself (`chat/service.ts`, marks it `cancelled`). `openaiFastResearchStream` counts a stream with no usage at a pessimistic estimate (`estimatedUsage`, three characters a token).
**Check**: `__tests__/chat.test.ts` ("keeps what streamed when stopped") uses an answerer that resolves on abort, the SDK's shape; `__tests__/openai-usage.test.ts` fakes a stream that ends without `response.completed`. Both fail without the fix (verified).
**Pattern**: `server/src/api/openai.ts` (`estimatedUsage`), `server/src/chat/service.ts` (`answerTurn`).

## Frontend (dashboard)

### 22. Dashboard JS Lives in a TS Template Literal — Escapes Decode Twice
**Symptom**: `/present` is blank except for the header; the browser console says `Invalid or unexpected token`. `tsc` and every other test pass.
**Cause**: `PRESENT_HTML` is one TypeScript template literal holding the page's JavaScript, so TS decodes escapes before the browser sees them. `join('\n')` written as JS ships as a raw newline inside a JS string (2026-09-22). The same applies to `\u2014`, `\'` and CSS `content: '\25B8'`.
**Solution**: Write every escape doubled for the browser (`'\\n'`, `'\\u2014'`, `\\'`), as the rest of the file does. Never a backtick or `${` in the embedded JS.
**Check**: `__tests__/present-script.test.ts` extracts each inline `<script>` from `PRESENT_HTML` and parses it with `vm.Script`. It fails on exactly this bug (verified by reintroducing it).
**Pattern**: `server/src/present/index.ts` (`export const PRESENT_HTML`).
**Structural fix, waiting on a trigger**: moving the dashboard out of the template literal ends this class (`docs/quality-plan.md` §0, A1). Hitting this bug again is one of A1's triggers.

### 23. Swift's `.iso8601` Rejects the Server's Milliseconds — Messages Silently Dropped
**Symptom**: The app's word count stays 0, suggestion banners (Approve/Dismiss) never appear, and the menu bar's Copilot list stays empty, while the dashboard shows everything. Nothing in `app.log`.
**Cause**: The server stamps dates with JS `toISOString()`, which always carries milliseconds (`…05.123Z`). `JSONDecoder`'s `.iso8601` strategy rejects fractional seconds, so every `transcript.update` and `action.suggested` threw, and the failure was a `print` to stderr, which never reaches `app.log` (#15). Two more of the same kind: `ActionType` had no `fast-research` (the default suggested type) or `review`, and an `html` artifact failed `action.status`, leaving a finished action "running".
**Solution** (applied 2026-09-22): `JSONDecoder.copilotDecoder` takes ISO with or without milliseconds, and epoch ms. `ActionType` falls back to `.other`, `action.status` decodes its `result` with `try?` so the state always lands, and decode failures go to `appLog`. Behaviour that was designed but dormant is now live: suggestion banners fire when the panel isn't frontmost, and session end waits (60 s grace at most) for running actions.
**Check**: `Tests/ServerMessageTests.swift` decodes real wire payloads with the app's own decoder, never a bare `JSONDecoder()`. With the old strategy it fails 4 of 8 (verified). A new server message or field the app reads gets a real-payload case there.
**Pattern**: `app/MeetingCopilot/Sources/Core/Network/WebSocketClient.swift` (`copilotDecoder`), `Models/ActionSuggestion.swift`, `Models/Messages.swift`.

### 24. Dashboard JS Is One Scope — A Second `var` Silently Replaces the First
**Symptom**: A dashboard feature throws on its first render (`Cannot read properties of undefined`) while tsc and every test pass; the object it reads belongs to some other feature.
**Cause**: The main `<script>` is one IIFE with ~310 top-level names, and `var` allows redeclaration. The coach's `ASK_LABELS` (2026-09-22) was reassigned by highlight-to-ask's `ASK_LABELS` further down, which runs later, so `ASK_LABELS.checkin` was undefined.
**Solution**: Prefix a new feature's names (`COACH_ASK_LABELS`). Wire clicks through `data-*` attributes and one delegated listener rather than `onclick="fn(\\'x\\')"`, which also sidesteps #22's escaping.
**Check**: `__tests__/present-script.test.ts` fails when a two-space-indented `var`/`let`/`const`/`function` name repeats in an inline script (verified by reintroducing the bug).
**Pattern**: `server/src/present/index.ts`.
**Structural fix, waiting on a trigger**: A1 then A2 (`no-redeclare`) in `docs/quality-plan.md` §0. Hitting this bug again is one of A1's triggers.

### 25. The Title Bar Doesn't Drag the Panel — the Page Does
**Symptom**: The panel can only be moved by its one-point border; pressing the top of the window does nothing.
**Cause**: The panel is `.fullSizeContentView` with a transparent titlebar, and the WKWebView fills all of it. AppKit only drags from a titlebar press when the view under it says `mouseDownCanMoveWindow`, and WKWebView never does, so it takes every click, the 19pt strip included. `isMovableByWindowBackground` doesn't help for the same reason. The page's comments said until 2026-09-22 that the strip "still hit-tests to the window". It never did.
**Solution** (applied 2026-09-22): the page marks its title bars with `data-drag-region` (`.header`, `.stage-top`). A capture-phase `mousedown` on empty space there calls `preventDefault()` and posts `startWindowDrag`. The app records every left mouse-down in a local monitor and hands that event to `performDrag(with:)` if the button is still down and the press is under 1 s old. A second click (`clickCount == 2`) zooms or minimizes per `AppleActionOnDoubleClick`. Controls are exempt (`DRAG_EXEMPT`: buttons, inputs, links, `[onclick]`, `[data-no-drag]`), and anything layered over the header (the Settings modal) blocks the drag, because the check is the element actually pressed. A new bar the window should drag by gets `data-drag-region`. A non-control element inside one that must stay clickable gets `data-no-drag`.
**Check**: `__tests__/window-drag.test.ts` pins the regions and the exemptions; `Tests/WindowDragTests.swift` pins the press rules, the double-click setting, and that this utility panel really zooms (it has no zoom button). The drag itself needs a real pointer: verified 2026-09-22 on the installed build with synthetic HID presses (moved exactly with the pointer; double-click zoomed, a second restored).
**Pattern**: `server/src/present/index.ts` ("Window drag"), `app/MeetingCopilot/Sources/Features/WebPanel/WindowDrag.swift`, `WebDashboardView.swift` (`mouseDownMonitor`, `startWindowDrag`).

### 27. A Popover Inside the Sticky Evidence Tab Bar Hit-Tests but Never Paints
**Symptom**: The evidence tabs' ⌄ All tabs button seems dead: nothing appears. Yet `aria-expanded` flips to true, `document.elementFromPoint` over the menu returns the menu, and a Playwright click on a menu row works, so a test that only asserts "open and clickable" passes.
**Cause**: The menu was `position: absolute` inside `#evTabBar`, which is `position: sticky` inside `.main`, the column's `overflow-y: auto` scroller. Chromium (2026-09-24) laid it out and hit-tested it, but painted nothing of it outside the 40 px bar.
**Solution** (applied 2026-09-24): the menu goes on `<body>`, `position: fixed`, placed from the button's `getBoundingClientRect()` (as Onyx's `OnyxMenu` does), and closes on the column's scroll and on resize, since it no longer moves with the button.
**Only Chromium** (checked 2026-09-25): WebKit, both Playwright's build and the app's own WKWebView, paints the old layout, so this never reached the app. The fix stays: it is the layout any engine draws.
**Check**: `__tests__/present-script.test.ts` asserts `.ev-menu` is fixed and `evOpenMenu` appends to `document.body`. The ship gate's `e2e/06-popovers.spec.ts` guards the class in WebKit: it compares each popover's box shown vs hidden, pixel by pixel, and every row must paint (a menu clipped to its bar paints 42% of its box but 0% of its last row, and fails). For any new popover, verify with a **screenshot**, never only by clicking it, and add it to that spec.
**Pattern**: `server/src/present/index.ts` (`evOpenMenu`, `.ev-menu`).

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
- First check which backend ran: `grep -E "Process tap started|falling back to ScreenCaptureKit|ScreenCaptureKit started" ~/.meeting-copilot/app.log | tail -3`. With the process tap (default since 2026-09-21), `meeting peak=0.0000` while the other side is audibly talking means the System Audio Recording permission is missing or denied → gotcha #20, not ARK.
- `meeting peak=0.0000` consistently on the ScreenCaptureKit backend → gotcha #12. Identify ARK.driver:
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
