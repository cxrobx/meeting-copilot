# Changelog

All notable changes to Meeting Copilot will be documented in this file.

## [Unreleased]

### Added
- 2026-03-14: Deepgram transcription provider — `server/src/transcription/deepgram.ts` implements REST API against nova-2, selected via `TRANSCRIPTION_PROVIDER=deepgram`
- 2026-03-14: Replay runner — `scripts/replay.sh run` feeds fixture transcripts through IntelligenceEngine; `diff` compares output against baselines using Jaccard title matching
- 2026-03-14: Test suite foundation — 30 tests across WorkerRegistry, IntelligenceEngine, and SessionStore using vitest
- 2026-03-14: Expanded SettingsView — intelligence cadence picker, presentation mode toggle, transcript sharing toggle
- 2026-03-14: Route extraction — Express routes moved to `server/src/routes.ts`, reducing index.ts from ~740 to ~540 lines
- 2026-03-14: WebSocket receive timeout — 2-minute deadline on receive loop using task group racing
- 2026-03-14: Unix socket readiness — WebSocketClient accepts `socketPath` parameter, checks socket file existence
- 2026-03-14: Exponential backoff for worker retries — `MAX_RETRY_COUNT=2`, delay doubles each attempt (1s, 2s)
- 2026-03-14: Documented `bin/sck-audio-capture` binary (ScreenCaptureKit spike, superseded by AudioCaptureManager)
- 2026-03-14: Localized session date formatter — uses `.dateStyle`/`.timeStyle` instead of hardcoded format
- 2026-03-14: Preflight dependency check — `/preflight` endpoint validates whisper, claude CLI, model file, storage. Swift app shows failures at startup.
- 2026-03-14: Error toast system — `SessionManager.surfaceError()` shows auto-dismissing overlay in ActionPanelView for audio failures, connection loss, preflight issues
- 2026-03-14: Session manifest.json — `SessionStore.writeManifest()` exports session metadata alongside SQLite for external tool interoperability
- 2026-03-14: `unhandledRejection` handler in server for crash safety
- 2026-03-10: Shared transcript protocol — meeting-copilot writes `~/.meeting-shared/live-transcript.jsonl`, notes4chris reads it to skip redundant whisper runs
- 2026-03-10: `.app` bundle packaging — `scripts/build-app.sh` builds release binary, bundles server + production deps, ad-hoc signs, installs to `/Applications`
- 2026-03-10: `ProcessSupervisor` — bundle path priority (`isPackaged`), homebrew PATH injection for Finder-launched apps, `NODE_ENV=production` in bundle mode
- 2026-03-10: `SHARE_TRANSCRIPT` env var toggle and `setSharingEnabled()` for disabling transcript sharing
- 2026-03-10: Stale presence cleanup at server startup (`cleanStalePresence` in `cleanup.ts`)
- 2026-03-10: Compound documentation infrastructure — `.claude/rules/`, `.claude/agents/`, `.claude/commands/`, `docs/`

### Fixed
- 2026-03-14: Intelligence overlap dedup now uses Jaccard similarity (was always returning false, causing duplicate Haiku calls)
- 2026-03-14: Cancel logic dead branch — removed always-true conditional in `WorkerRegistry.cancel()`
- 2026-03-14: AGENTS.md references corrected from `.Codex/` to `.claude/`
- 2026-03-14: `/health` endpoint now returns actual `whisperAvailable` status (was hardcoded `null`)
- 2026-03-14: `.gitignore` expanded — added `.env*`, `*.log`, `build/`, `.vscode/`, `.idea/`
- 2026-03-14: Removed dead `@anthropic-ai/sdk` dependency (intelligence uses `claude` CLI)
- 2026-03-14: Degraded audio buffer now drops oldest chunks (was dropping newest, losing recent context)
- 2026-03-14: Stale presence cleanup now logs verbose details (PID, app, session, start time)
- 2026-03-14: JSONL transcript writes use `O_APPEND` with explicit fd for atomic appends
- 2026-03-14: TCP server now properly closed during shutdown (was leaked)
- 2026-03-14: Deduplicated WebSocket connection handlers into shared `handleWsConnection()`

## [0.1.0] - 2026-03-09

### Added
- Initial project scaffold: two-process architecture (SwiftUI + Node.js)
- ScreenCaptureKit audio spike (`spike/AudioSpike/`)
- SwiftUI menubar app with floating panel and approval flows
- Node.js server with Express + WebSocket
- Transcription providers: whisper-server (local), Deepgram (cloud)
- Intelligence pipeline: Haiku triage (15s cadence) → Sonnet suggestions
- Workers: Research, Summary, Analysis (implemented); Mockup, CodeGen (stubs)
- SQLite per-session storage with JSONL event logging
- Scripts: setup.sh, start.sh, replay.sh, build-app.sh
- Privacy: no raw audio storage, consent prompt, REC indicator
