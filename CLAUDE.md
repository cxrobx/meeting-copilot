# Meeting Copilot

AI agent that activates during meetings to generate live research, mockups, and analysis with approval flows.

## Architecture

Two-process design:
- **SwiftUI Menubar App** (`app/MeetingCopilot/`) — audio capture (ScreenCaptureKit + AVAudioEngine), WKWebView dashboard, process supervision
- **Node.js Local Server** (`server/`) — transcription, intelligence eval, worker execution, session storage, web dashboard

Communication: WebSocket over localhost:17890. Browser connects as additional WS client alongside Swift app.

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
- **Intelligence**: Gemini Flash triage (15s cadence) → Sonnet suggestions. Fallback: Haiku → GPT 5.4 Mini
- **Workers**: Research, Summary, Analysis, Mockup, CodeGen (all implemented)
- **UI**: Web dashboard at `/present` (Gruvbox Light theme, JetBrains Mono) served in WKWebView
- **Storage**: SQLite per session at `~/.meeting-copilot/sessions/<id>/`
- **Privacy**: No raw audio stored. Consent prompt per session. Visible REC indicator.

## Environment

- `DEEPGRAM_API_KEY` — optional, for cloud transcription
- `COPILOT_PORT` — TCP port (default: 17890)
- No API keys required — all AI calls use headless CLIs (`claude`, `gemini`, `codex`) via user subscriptions

## Golden Commands

```bash
./scripts/setup.sh                       # Install deps, download whisper model
./scripts/start.sh                       # Launch server + whisper-server
cd server && npm run dev                 # Dev with tsx (hot reload)
cd app/MeetingCopilot && swift build     # Build Swift app
./scripts/build-app.sh                   # Release .app bundle
./scripts/replay.sh                      # Test with text fixtures
./scripts/replay-audio.sh <dir> --speed 4 --auto-approve  # Test with real audio
open "/Applications/Meeting Copilot.app" # Launch packaged app
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
| `.claude/rules/gotchas.md` | Known issues + recovery playbook | Always |
| `.claude/rules/swift-app.md` | SwiftUI app patterns | Path: `app/**` |
| `.claude/rules/backend.md` | Node.js server patterns | Path: `server/**` |
| `docs/README.md` | Documentation index | On demand |
| `docs/api.md` | WebSocket & REST API reference | On demand |
| `docs/setup.md` | Environment & deployment | On demand |
| `CHANGELOG.md` | Version history | On demand |

## Recent Learnings

- 2026-04-21: **ScreenCaptureKit silent-frames root cause identified** — Rogue Amoeba's `ARK.driver` loading inside `coreaudiod` causes `SCContentFilter(display:excludingApplications:[])` to return zero-filled buffers system-wide (also affected notes4chris). Switched to `SCContentFilter(display:including:capturedApps,…)` which taps per-app audio directly. Detect with `sudo sample coreaudiod 5 | grep -i ARK.driver`. Full details + recovery ladder in `.claude/rules/gotchas.md` §12 and the Recovery Playbook.
- 2026-04-21: `claude` CLI lives at `~/.local/bin/claude`, which `ProcessSupervisor.processEnvironment()` did not include — any CLI-based worker/eval returned ENOENT silently. Fix: PATH injection now appends `~/.local/bin` + all `~/.nvm/versions/node/*/bin`, and `extractAgendaItemsFromNotes` prefers the direct Anthropic API when `ANTHROPIC_API_KEY` is set (sidesteps PATH entirely). See gotcha #13.
- 2026-04-21: Native-module ABI mismatch (nvm Node 24 at build, homebrew Node 20 at runtime) silently broke every `session.start` via `better-sqlite3`. `build-app.sh` now pins PATH to the same Node resolution `ProcessSupervisor` uses and aborts the build if `require('better-sqlite3')` fails under the runtime Node. See gotcha #14.
- 2026-04-21: Self-healing wired into the process / WS layers — `ProcessSupervisor` now polls `/health` every 15s, force-restarts hung servers after 3 consecutive failures, uses exponential backoff (1→2→4→8→16→30s) with the restart budget resetting on 60s of sustained health, and surfaces a macOS notification when the supervisor gives up. `WebSocketClient` uses the same backoff with unlimited retries (reset on connect) so long outages self-recover without a relaunch.
- 2026-03-24: Claude CLI `--output-format json` wraps response in `{"type":"result","result":"..."}` envelope with OSC escape sequences — must strip `\x1b]...\x1b\` and extract `result` field; empty result on `error_max_turns`
- 2026-03-24: Claude CLI has no `--max-tokens` flag — use `--max-budget-usd` for cost control
- 2026-03-24: WAV chunks sent to whisper-server need proper 44-byte WAV headers, not raw PCM
- 2026-03-24: WKWebView needs `NSAllowsLocalNetworking` in Info.plist + health polling before loading localhost URLs
- 2026-03-24: Gemini 3 Flash Preview is best triage model (42% hit rate, accurate reasoning); Haiku too lenient, GPT 5.4 Mini too eager (100% hit rate)
- 2026-03-24: CSS `zoom` property via JS works for browser-style Cmd+/- zoom in WKWebView; `allowsMagnification` only does bitmap scaling
- 2026-03-24: 3-column layout requires fixed-height grid container (`height: calc(100vh - header)`) with each column having independent `overflow-y: auto`
- 2026-03-10: Shared transcript protocol added — `server/src/session/shared.ts` writes presence + JSONL, notes4chris reads at processing time
- 2026-03-10: `.app` bundle works — `build-app.sh` produces 45MB bundle; `ProcessSupervisor` prefers bundle path via `isPackaged` check
- 2026-03-10: `segment.timestamp` is epoch-ms, `segment.duration` is whisper latency — shared.ts converts to session-relative seconds and uses fixed 10s chunk duration
- 2026-03-10: Finder-launched apps need PATH injection for `/opt/homebrew/bin` — `processEnvironment()` handles this
- 2026-03-10: Set up compound documentation infrastructure with gold standard pattern
