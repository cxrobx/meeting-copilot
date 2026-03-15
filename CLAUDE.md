# Meeting Copilot

AI agent that activates during meetings to generate live research, mockups, and analysis with approval flows.

## Architecture

Two-process design:
- **SwiftUI Menubar App** (`app/MeetingCopilot/`) — audio capture (ScreenCaptureKit + AVAudioEngine), floating panel UI with approval flows
- **Node.js Local Server** (`server/`) — transcription, intelligence eval, worker execution, session storage

Communication: WebSocket over localhost:17890 (MVP), Unix socket `~/.meeting-copilot/copilot.sock` (production)

## Project Structure

```
spike/AudioSpike/     # Spike 0: ScreenCaptureKit audio feasibility test
app/MeetingCopilot/   # SwiftUI macOS menubar app (Swift Package)
server/               # Node.js server (TypeScript)
  src/
    index.ts          # Express + WebSocket on Unix socket + localhost:17890
    transcription/    # Whisper + Deepgram providers
    intelligence/     # Adaptive eval loop, Haiku triage + Sonnet suggestions
    workers/          # Research, Summary, Mockup, CodeGen, Analysis
    session/          # SQLite per-meeting store + JSONL event log
    debug/            # /debug metrics endpoint
fixtures/             # Replay test fixtures
scripts/              # setup.sh, start.sh, replay.sh
```

## Quick Start

```bash
./scripts/setup.sh        # Install deps, download whisper model
./scripts/start.sh        # Launch server + whisper-server

# Build/run spike
cd spike/AudioSpike && swift run

# Build app
cd app/MeetingCopilot && swift build
```

## Key Decisions

- **Audio**: ScreenCaptureKit (meeting) + AVAudioEngine (mic), 16kHz mono PCM
- **Transcription**: whisper-server local (default), Deepgram cloud (optional)
- **Intelligence**: Haiku triage (15s cadence) → Sonnet suggestions (on actionable hits)
- **Workers**: Research, Summary, Analysis (implemented); Mockup, CodeGen (stubs)
- **Storage**: SQLite per session at `~/.meeting-copilot/sessions/<id>/`
- **Privacy**: No raw audio stored. Consent prompt per session. Visible REC indicator.

## Environment

- `ANTHROPIC_API_KEY` — required for intelligence + workers
- `DEEPGRAM_API_KEY` — optional, for cloud transcription
- `COPILOT_PORT` — TCP port (default: 17890)

## Golden Commands

```bash
./scripts/setup.sh                       # Install deps, download whisper model
./scripts/start.sh                       # Launch server + whisper-server
cd server && npm run dev                 # Dev with tsx (hot reload)
cd app/MeetingCopilot && swift build     # Build Swift app
./scripts/build-app.sh                   # Release .app bundle
./scripts/replay.sh                      # Test with fixtures
```

## Critical Invariants (DO NOT BREAK)

1. **No raw audio storage** — audio streams but never persists to disk (privacy)
2. **Session isolation** — each meeting gets its own SQLite DB, never shared
3. **Approval before action** — suggestions require user approval before workers execute
4. **16kHz mono PCM** — both audio sources must output this format

Full list in `.claude/rules/architecture.md`.

## Documentation Index

| File | Purpose | Loaded |
|------|---------|--------|
| `.claude/rules/architecture.md` | System patterns, invariants | Always |
| `.claude/rules/gotchas.md` | Known issues (3 items) | Always |
| `.claude/rules/swift-app.md` | SwiftUI app patterns | Path: `app/**` |
| `.claude/rules/backend.md` | Node.js server patterns | Path: `server/**` |
| `docs/README.md` | Documentation index | On demand |
| `docs/api.md` | WebSocket & REST API reference | On demand |
| `docs/setup.md` | Environment & deployment | On demand |
| `CHANGELOG.md` | Version history | On demand |

## Recent Learnings

- 2026-03-10: Shared transcript protocol added — `server/src/session/shared.ts` writes presence + JSONL, notes4chris reads at processing time
- 2026-03-10: `.app` bundle works — `build-app.sh` produces 45MB bundle; `ProcessSupervisor` prefers bundle path via `isPackaged` check
- 2026-03-10: `segment.timestamp` is epoch-ms, `segment.duration` is whisper latency — shared.ts converts to session-relative seconds and uses fixed 10s chunk duration
- 2026-03-10: Finder-launched apps need PATH injection for `/opt/homebrew/bin` — `processEnvironment()` handles this
- 2026-03-10: Set up compound documentation infrastructure with gold standard pattern
