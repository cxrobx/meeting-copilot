# Environment & Setup

## Prerequisites

- macOS 14+ (ScreenCaptureKit requirement)
- Node.js 20+
- Swift 5.9+ / Xcode 15+
- whisper.cpp with server mode

## Quick Start

```bash
./scripts/setup.sh        # Install npm deps, download whisper model
./scripts/start.sh        # Launch whisper-server + Node.js server
```

## Environment Variables

Create `server/.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...   # Required — intelligence + workers
DEEPGRAM_API_KEY=...           # Optional — cloud transcription fallback
COPILOT_PORT=17890             # Optional — default 17890
```

## Building

### Server

```bash
cd server && npm install       # Install dependencies
cd server && npm run dev       # Dev mode (tsx hot reload)
cd server && npm run build     # Compile TypeScript → dist/
cd server && npm start         # Run compiled
```

### Swift App

```bash
cd app/MeetingCopilot && swift build    # Debug build
cd app/MeetingCopilot && swift run      # Run debug
./scripts/build-app.sh                   # Release .app bundle → build/
```

### Spike

```bash
cd spike/AudioSpike && swift build
cd spike/AudioSpike && swift run
```

## macOS Permissions

The app requires these system permissions:
- **Screen Recording**: System Settings → Privacy & Security → Screen Recording (for ScreenCaptureKit audio capture)
- **Microphone**: Prompted automatically on first use

Must restart the app after granting Screen Recording permission.

## Testing with Fixtures

```bash
./scripts/replay.sh           # Replay test fixtures against running server
```

## Production Deployment

The app bundle at `build/Meeting Copilot.app` includes the bundled server. The production communication channel uses Unix socket at `~/.meeting-copilot/copilot.sock` instead of TCP.
