# Architecture Patterns

## Tech Stack

| Component | Technology |
|-----------|------------|
| App | SwiftUI menubar app + WKWebView dashboard (Swift Package Manager) |
| Server | Node.js + TypeScript (Express, WebSocket) |
| AI Triage | gpt-6-luna via the OpenAI API; Haiku 4.5 on the subscription CLI when the API is off or failing |
| AI Suggest | Claude Sonnet 4.6 (via `claude --print`) |
| Database | better-sqlite3 per-session SQLite |
| Audio | Core Audio process tap (meeting, macOS 14.2+; ScreenCaptureKit fallback) + AVAudioEngine (mic) — see gotcha #20 |
| Transcription | Grok Voice Transcribe 2.0 streamed live (default, consent-gated) over 100 ms frames; local Parakeet/whisper on the VAD chunks as its fallback, or alone without consent. `server/src/transcription/streaming.ts` |
| Dashboard | Web UI at `/present` in WKWebView — CX family tokens (shared with cxmail/cxtasks/cxnotes), dark default + light toggle |

## Two-Process Architecture

```
┌─────────────────────┐     WebSocket      ┌─────────────────────┐
│  SwiftUI Menubar    │◄──────────────────►│  Node.js Server     │
│  app/MeetingCopilot │   localhost:17890   │  server/src/        │
│                     │                     │                     │
│  - Audio capture    │                     │  - Transcription    │
│  - Floating panel   │                     │  - Intelligence     │
│  - Approval flows   │                     │  - Workers          │
│  - REC indicator    │                     │  - Session storage  │
└─────────────────────┘                     └─────────────────────┘
```

**Communication**: WebSocket over localhost:17890 (MVP), Unix socket `~/.meeting-copilot/copilot.sock` (production)

## Directory Structure

```
meeting-copilot/
├── app/MeetingCopilot/    # SwiftUI macOS menubar app (Swift Package)
│   ├── Core/              # Audio capture, WebSocket client
│   ├── Features/          # UI features (floating panel, approval)
│   ├── Models/            # Data models
│   └── Sources/           # App entry point
├── server/src/            # Node.js TypeScript server
│   ├── index.ts           # Express + WebSocket entry (~20KB)
│   ├── transcription/     # Whisper + Deepgram providers
│   ├── intelligence/      # Adaptive eval loop (Haiku→Sonnet)
│   ├── workers/           # Research, Summary, Analysis, Mockup, CodeGen
│   ├── session/           # SQLite store + JSONL event log
│   └── debug/             # /debug metrics endpoint
├── spike/AudioSpike/      # ScreenCaptureKit audio feasibility test
├── scripts/               # setup.sh, start.sh, replay.sh, build-app.sh
├── fixtures/              # Replay test fixtures
└── build/                 # Built .app bundle
```

## Critical Invariants (DO NOT BREAK)

1. **No raw audio storage**: Audio is captured and streamed but never persisted to disk. Privacy is a core design constraint.
   - Why: Legal/privacy — meeting audio without consent is liability
   - Pattern: `server/src/index.ts`

2. **Session isolation**: Each meeting gets its own SQLite DB at `~/.meeting-copilot/sessions/<id>/`. Never share state between sessions.
   - Why: Data integrity and cleanup simplicity
   - Pattern: `server/src/session/`

3. **Approval before action**: Intelligence suggestions require user approval in the floating panel before workers execute.
   - Why: User must maintain control over AI actions during meetings
   - Pattern: `app/MeetingCopilot/Features/`

4. **Audio format**: 16kHz mono PCM for all transcription pipelines. Both ScreenCaptureKit and AVAudioEngine must output this format.
   - Why: Whisper and Deepgram both expect this; mismatched format causes silent failures
   - Pattern: `app/MeetingCopilot/Core/`

## Intelligence Pipeline

```
Audio → Transcription → Buffer (15s cadence)
                              ↓
                     Haiku Triage (cheap, fast)
                              ↓ (if actionable)
                     Sonnet Suggestions
                              ↓
                     User Approval (floating panel)
                              ↓ (if approved)
                     Worker Execution
```

## Worker Types

| Worker | Status | Purpose |
|--------|--------|---------|
| Research (Deep) | Implemented | Opus 5.5 agent loop with WebSearch/WebFetch on the subscription CLI, ~30-65 s. Runs as the follow-up on every Research request; alone only with `COPILOT_SUGGESTED_RESEARCH=deep` |
| Fast Research | Implemented | Streaming quick research (OpenAI-preferred, Haiku CLI fallback). Every request (suggested card, Research button) also gets a deep follow-up: `workers/deep-follow-up.ts` runs Deep alongside, then appends "Deep research adds" to the finished card (outside the worker slots, max 2 at once) |
| Summary | Implemented | Running meeting summary |
| Analysis | Implemented | Data/argument analysis |
| Mockup | Implemented | ASCII wireframe + HTML mockup (two-phase, early ASCII emit) |
| CodeGen | Implemented | Code generation from discussion |
| Review | Implemented | Opus self-review scorecard + cross-meeting trends |

The **meeting chat** (`server/src/chat/`) is not a worker: it answers the user's typed question directly (no suggestion, no approval step beyond the question itself), one turn at a time per session, with the whole meeting rebuilt as context each turn. See `docs/api.md` (`/present/chat`, `chat.*`).

## Shared Transcript Protocol

Coordination with notes4chris via `~/.meeting-shared/`:
- `active-session.json` — presence file with PID, session ID, transcript path
- `live-transcript.jsonl` — appended per segment during session

Key files: `server/src/session/shared.ts` (writer), `server/src/session/cleanup.ts` (stale cleanup)

**Timestamp conversion**: `segment.timestamp` is epoch-ms; `shared.ts` converts to session-relative seconds. Duration uses fixed `CHUNK_DURATION_SECONDS = 10`, not whisper latency.

Toggle: `SHARE_TRANSCRIPT=false` env var disables sharing.

## App Bundle Packaging

`scripts/build-app.sh` produces `Meeting Copilot.app`:
- Compiles server (`npm run build` → `dist/`), prunes to production `node_modules`
- Builds Swift binary (`swift build -c release`)
- Assembles `.app` bundle with `Info.plist` (`LSUIElement=true`, privacy descriptions)
- Signs with the first "Developer ID Application" identity in the keychain (or `CODESIGN_IDENTITY`), falling back to ad-hoc, which re-prompts for every permission on each rebuild; `verify-app.sh` checks the result
- Writes `dist/Meeting Copilot.app` and does **not** install. `scripts/ship.sh` installs: it refuses during a live meeting, runs both test suites, verifies the Developer ID signature, replaces `/Applications/Meeting Copilot.app`, relaunches, and checks `/health`

`ProcessSupervisor` uses `isPackaged` (checks `Bundle.main.bundlePath.hasSuffix(".app")`) to prefer bundle resources over dev paths. Injects `/opt/homebrew/bin` into PATH via `processEnvironment()`.
