---
paths:
  - "app/**/*.swift"
  - "spike/**/*.swift"
---

# Swift App Patterns

## Tech Stack

- SwiftUI macOS menubar app (Swift Package Manager)
- ScreenCaptureKit for meeting audio capture
- AVAudioEngine for microphone capture
- WebSocket client for server communication

## Directory Structure

```
app/MeetingCopilot/
├── Core/              # Audio capture engine, WebSocket client
├── Features/          # Floating panel UI, approval flows
├── Models/            # Data models (transcripts, suggestions)
├── Sources/           # App entry point, menubar setup
└── Package.swift      # Swift Package manifest
```

## Audio Capture

- **Meeting audio**: Core Audio process tap (`SystemAudioTap`, macOS 14.2+) — every process's output, including the `avconferenced` / `callservicesd` daemons that play phone and FaceTime calls. ScreenCaptureKit per-app capture is the fallback (`meetingAudioSource=sck`). Gotcha #20
- **Microphone**: AVAudioEngine — captures user's mic input
- **Format**: 16kHz mono PCM (required by transcription pipeline)
- Both streams are mixed/interleaved before sending to server

## UI Patterns

- **Menubar app**: No dock icon, lives in system tray
- **Floating panel**: NSPanel hosting the web dashboard (`/present` in a WKWebView) — the app's only session UI; suggestions/approvals/results all live there
- **REC indicator**: Always visible when recording is active (privacy requirement)
- **Consent affirmation**: Required checkbox on the web start form, once per session; `SessionManager.startSessionFromWeb` refuses `consent == false` (native enforcement)
- **Settings**: Web dashboard gear icon → `GET/POST /settings` (persisted server-side to `~/.meeting-copilot/settings.json`); there is no native Settings window
- **Global hotkeys**: anything that must work while the user is in Zoom/Meet goes through Carbon `RegisterEventHotKey` (`Core/Hotkeys/CoachHotkeys.swift`), never an NSEvent global monitor (needs Accessibility, cannot swallow the key) or a page-level keydown (never fires with another app in front). Always include ⌃ or ⌘ in the chord: macOS 15 refuses hotkeys whose only modifiers are ⌥ or ⌥⇧. Register with `kEventHotKeyExclusive` so a taken chord fails loudly, and hold chords only while they mean something (the coach's ⌃⌥1-3 only while a meeting is live)

## ProcessSupervisor Path Resolution

`ProcessSupervisor` resolves server/whisper paths differently based on context:
- **`isPackaged`** (`Bundle.main.bundlePath.hasSuffix(".app")`) → looks in `Contents/Resources/server/` first
- **Dev mode** (`swift run`) → falls back to `~/Projects/meeting-copilot/server/`
- **PATH injection**: `processEnvironment()` adds `/opt/homebrew/bin` etc. for Finder-launched apps (for the `claude` CLI and friends; the server itself never runs on them)
- **Node**: packaged → the bundled `Contents/Resources/node/bin/node`; dev → the pinned cache's `~/Library/Caches/meeting-copilot/node/current`, then the system's. Never `env node` (gotcha #14)
- **uv** (Parakeet): packaged → the bundled `Contents/Resources/uv/bin/uv`, run as `uv run --frozen --script` beside its lock; dev → the user's `uv`
- **First-run setup**: while Parakeet isn't up 12 s after launch, `transcriptionSetup` carries the menu bar's "Preparing transcription" text (download %); whisper mode downloads its model, sha256-checked, on first use
- **NODE_ENV**: Set to `production` in bundle mode, `development` in dev mode

## Updates (Sparkle)

- `Core/Updates/UpdateController.swift` owns `SPUStandardUpdaterController`. It starts only in a packaged app whose Info.plist has a feed and key, since `swift run` has neither
- `UpdatePolicy` holds the meeting rules (`UpdatePolicyTests`). Background checks wait for the meeting to end. An install is postponed through `updater(_:shouldPostponeRelaunchForUpdate:untilInvokingBlock:)`, then waits for the server's close-out workers (`GET /debug`)
- A meeting is `SessionState.isMeeting` (priming → ending); `SessionManager.onMeetingEnded` fires on leaving it
- `--capture-selftest <out.json>` launches no server: it measures both tracks and exits (`CaptureSelfTest`, driven by `scripts/capture-selftest.sh`)

## Build

```bash
cd app/MeetingCopilot && swift build    # Debug build
cd app/MeetingCopilot && swift run      # Run debug
./scripts/build-app.sh                   # Signed .app → dist/ (does not install; ship.sh installs)
```
