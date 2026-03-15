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

- **Meeting audio**: ScreenCaptureKit — captures system audio from meeting apps
- **Microphone**: AVAudioEngine — captures user's mic input
- **Format**: 16kHz mono PCM (required by transcription pipeline)
- Both streams are mixed/interleaved before sending to server

## UI Patterns

- **Menubar app**: No dock icon, lives in system tray
- **Floating panel**: NSPanel overlay for showing suggestions and approval flows
- **REC indicator**: Always visible when recording is active (privacy requirement)
- **Consent prompt**: Shown at session start before any capture begins

## ProcessSupervisor Path Resolution

`ProcessSupervisor` resolves server/whisper paths differently based on context:
- **`isPackaged`** (`Bundle.main.bundlePath.hasSuffix(".app")`) → looks in `Contents/Resources/server/` first
- **Dev mode** (`swift run`) → falls back to `~/Projects/meeting-copilot/server/`
- **PATH injection**: `processEnvironment()` adds `/opt/homebrew/bin` etc. for Finder-launched apps
- **NODE_ENV**: Set to `production` in bundle mode, `development` in dev mode

## Build

```bash
cd app/MeetingCopilot && swift build    # Debug build
cd app/MeetingCopilot && swift run      # Run debug
./scripts/build-app.sh                   # Release .app bundle → /Applications
```
