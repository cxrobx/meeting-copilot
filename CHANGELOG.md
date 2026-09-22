# Changelog

All notable changes to Meeting Copilot will be documented in this file.

## [Unreleased]

### Changed

- Agenda reconcile runs on gpt-6-luna instead of gpt-5.6-terra: about $0.07 instead of $1.42 for a 34-minute meeting, with a faster median (2.2 s vs 2.9 s). A replay of the two real meetings with agendas found no regression in schema, quote grounding, or how often items un-check. Roll back with `COPILOT_AGENDA_RECONCILE_MODEL=gpt-5.6-terra`.

### Added

- `npm run eval:agenda` replays real sessions through the exact production reconcile call and gates a model against a baseline (`--baseline <model>`, or `--baseline-from <report.json>` to reuse a paid baseline run).

### Fixed

- The copilot no longer shuts itself off mid-meeting. A 500-request lifetime cap stopped suggestions, agenda and coach at minute 26 of 33 (09-21) and 32 of 38 (09-14), at ~$0.68 of a $10 allowance; the 2M-token cap would have been next at ~minute 55. Dollars are now the only lifetime stop. Request and token counts became a one-minute runaway window (240 requests, 2M tokens, ~7x and ~13x the busiest real minute) that pauses a loop and lets the next call through once it drains.
- Vault meeting notes no longer turn an over-long topic into the word "Meeting", and no longer stamp `CXV` on every note: the category is earned from the title or attendees (`Globex`, `AIQ`, `TH`, `BD`, `CXV`) or left off, matching cxnotes' 09-08 fix.
- Triage, coach, fact-check and both agenda lanes no longer drop a good answer when gpt-6-luna writes text after its JSON (gotcha #21). Triage read those as "not actionable".

### Added

- Both sides of phone calls handed off from an iPhone, and of FaceTime calls, are transcribed. Meeting audio now comes from a Core Audio process tap (macOS 14.2+), which hears the `avconferenced` call daemon that ScreenCaptureKit cannot see; ScreenCaptureKit remains the automatic fallback and the `meetingAudioSource=sck` rollback. The app asks for System Audio Recording permission on the first session.

### Packaging

- Added a CX-family-style shipping workflow: `VERSION` is authoritative,
  `build-app.sh` packages without touching `/Applications`, `verify-app.sh`
  validates the bundle/runtime/signature and the Info.plist usage descriptions,
  and `ship.sh` blocks active meetings, asks before replacement (`--yes` when
  run from `/ship`), health-checks the installed build, and rolls back on
  failure.

### Fixed

- Website links open in the default browser instead of replacing the native dashboard, including new-tab links. Intentional navigation cancellations no longer trigger dashboard reloads, and native bridge messages are restricted to the dashboard's main frame.

### Reliability and latency overhaul (2026-07-28)

- Fixed child-process EOF CPU spinning, stale restart races, WebSocket receive/reconnect task leaks, and WKWebView key-monitor leaks.
- Removed Parakeet temporary WAV files; audio is validated and decoded entirely in memory.
- Enabled the VAD emitter by default with an O(1) circular pre-roll buffer and retained `MC_USE_VAD_EMIT=0` rollback.
- Added chunk correlation IDs, provider/queue/end-to-end percentile metrics, explicit ASR capabilities, serialized MLX inference, and provider-neutral health metadata.
- Upgraded Deepgram to Nova-3 with keyterms and made all cloud audio fail closed unless `COPILOT_ALLOW_CLOUD_AUDIO=true`.
- Added event-driven latest-wins intelligence, direct API hot paths, circuit breakers, cancellation, prompt caching, and per-session request/token/spend ceilings.
- Centralized model routing: GPT-5.6 Luna triage, Claude Sonnet 5 suggestions/workers, and Claude Opus 5 post-meeting review, all with environment rollbacks.
- Added buffered rotating global logs, child-error sanitization, a Swift test target, and reproducible Node 20-compatible test tooling.
- Added opt-in, read-only real-audio VAD and local transcription evaluators; fixed a whisper.cpp 1.8.3 Metal/CPU graph abort on pre-M5 Apple Silicon by running the sub-1 MB Silero VAD model on CPU.
- Validated a consented eight-minute, dual-track real meeting replay end to end: 318 audio chunks, zero errors, ASR p50/p95 183/253 ms, all 3 agenda items covered with evidence, and one relevant coach intervention.
- Calibrated the live coach for priority-5 recovery moments only, narrowed directed-pressure/question detection, and kept the production Terra recovery benchmark at 10/10.
- Made agenda deltas monotonic and conservative: incremental evidence may advance pending to partial, while only full reconciliation confirms covered.
- Added meeting-scoped action-card dedup, recent-card triage context, and a stricter interruption gate so explanatory or already-answered discussion does not invoke the slower suggestion tier.
- Extended real-audio replay with bounded `--minutes` and explicit `--agenda` controls plus agenda, coach, error, and latency reporting.

### Added
- 2026-07-02: Upcoming-meeting auto-fill — `server/src/calendar/cxmail.ts` reads cxmail's invite DB read-only (all mail accounts, `CXMAIL_DB_PATH` override), `GET /calendar/upcoming` dedupes by event UID with per-field fallback across RSVP replies; start form shows up to 3 "📅 Auto-fill" chips that prefill title/attendees and run the invite description through agenda extract. Degrades to hidden when cxmail/DB is absent. Coverage = invite-backed meetings only (self-created events with no invite email don't appear).
- 2026-07-02: Menubar Toggle Panel fixed — panel gets `.moveToActiveSpace` + `.fullScreenAuxiliary`, toggle hides only when visible on the active Space (otherwise fronts + activates), popover dismisses first

### Finish-the-Migration UX Program (2026-07-02)

Eleven-commit program closing out the unfinished native→web migration. Full audit + plan in the session that produced commits f169087…HEAD.

**Tier 1 — broken things:**
- End-of-meeting durability: auto-summary/self-review/rolling summary are `system` actions — bypass the 3-worker cap and survive `onMeetingEnd`'s cancel sweep; post-stop worker results persist via `persistActionPostSession`; rolling summaries persist and survive reload
- Honest dashboard feedback: `wsSend` reports delivery; Quick Actions/Approve/Cancel/Dismiss/Stop show real errors + optimistic busy states reconciled by server echo (6s revert)
- Menubar Start + ⌘⇧S revived (front panel + focus web start form via `runDashboardJS` bridge); notification Approve/Dismiss actually route to the session (UNUserNotificationCenter delegate, banner hygiene: suppressed when panel visible, 60s sound spacing, cleared when actioned); server-start failure shows an error row + Retry instead of a perpetual spinner
- Deleted the unreachable native dashboard (~2,900 lines: ActionPanelView et al.) + orphaned SessionManager APIs

**Tier 2 — live-meeting UX:**
- Gemini triage circuit breaker (12s timeout, 2 failures → 5min Haiku-direct) + `intelligence.error` WS message + dashboard ⚠ badge; context-compression summaries re-injected into the eval window
- Pausable transcript auto-scroll with "N new" pill; selection mini-toolbar for highlight-to-ask (right-click still works); `session.state` carries authoritative `startedAt` (timer survives refresh) + actions re-fetched on reconnect; TOC scroll-spy fixed (listened on `window`, content scrolls in `.main`)

**Tier 3 — settings, consent, polish:**
- Real settings: `~/.meeting-copilot/settings.json` (gear panel → GET/POST `/settings`, applied live: eval cadence, suggestion TTL, monitor defaults, retention, summary auto-write); native Settings scene + retention sync removed
- Consent affirmation checkbox required on the start form (invariant restored; native refuses `consent == false`)
- REC + ticking timer in the menubar (orange when degraded); panel clamps to screen; Accessibility onboarding step for the global hotkey (optional)
- `ServerConfig` port single source of truth (COPILOT_PORT honored app-side, injected into child server)
- Vendored dashboard assets (marked/DOMPurify/hljs/JetBrains Mono → `/vendor`, zero external hosts); word-boundary signal tags (`src/present/signals.ts`); truthful 2-retry worker loop; transcript DOM cap (400 rows + Show older); legacy `/transcribe` gated to 410; pragmatic a11y pass (Escape/focus-trap/menus/aria-live)

### Added
- 2026-03-24: Audio replay testing — `replay-audio.ts` + `scripts/replay-audio.sh` streams recorded WAV files through the full pipeline (audio → whisper → intelligence → workers) with `--speed` and `--auto-approve` flags
- 2026-03-24: Web-first dashboard at `/present` — 3-column layout (transcript, action results, TOC outline) with Gruvbox Light theme (AnuPpuccin), JetBrains Mono font, session controls, approval flow, quick actions
- 2026-03-24: WKWebView integration — floating panel now loads `/present` web dashboard instead of SwiftUI views (SwiftUI code preserved as comments)
- 2026-03-24: Multi-model triage chain — Gemini 3 Flash Preview → Haiku 4.5 → GPT 5.4 Mini (via `gemini`, `claude`, `codex` CLIs)
- 2026-03-24: Rolling summary — auto-refreshes every 2 min via `registry.replaceActionResult()`, updates card in-place as transcript grows
- 2026-03-24: Title-based Jaccard dedup in WorkerRegistry (75% threshold) prevents near-duplicate suggestions
- 2026-03-24: `GET /transcript` endpoint — returns live session transcript for web UI refresh persistence
- 2026-03-24: `GET /present/transcript?session=<id>` — returns stored transcript for session replay
- 2026-03-24: `GET /present/sessions` — lists sessions with action/segment counts, sorted by date
- 2026-03-24: Session replay via `?session=<id>` — loads transcript + actions from SQLite, read-only mode with "Back" navigation
- 2026-03-24: Enhanced start form — project picker (checkboxes), context source toggles, title/agenda/attendees fields
- 2026-03-24: Cmd+/- CSS zoom in WKWebView via `document.body.style.zoom`
- 2026-03-24: `NSAllowsLocalNetworking` in Info.plist for WKWebView localhost access

### Fixed
- 2026-03-24: `--max-tokens` CLI flag crash — Claude CLI has no such flag; was silently failing every intelligence eval
- 2026-03-24: CLI output parsing — terminal escape sequences (OSC `\x1b]...\x1b\`) stripped before JSON.parse; empty `result` on `error_max_turns` falls back to raw JSON
- 2026-03-24: WAV header injection — replay audio chunks need proper 44-byte WAV headers for whisper-server (not raw PCM)
- 2026-03-24: Summary worker transcript injection — live transcript injected into params at approval time so mid-meeting summaries have content
- 2026-03-24: Stale "Running..." in replay mode — shows "Did not complete during session" instead of forever-spinner
- 2026-03-24: CLI timeout increased to 180s for all calls (was 60s for non-tool calls, causing mockup/codegen aborts)
- 2026-03-24: Research `maxTurns` increased from 5 to 8 for web search completion

### Changed
- 2026-03-24: Haiku triage prompt rewritten — strict filter requiring specific actionable output, rejects future intentions and re-flags
- 2026-03-24: Action cards render chronologically (newest at bottom, was newest at top)
- 2026-03-24: All AI calls use headless CLIs (`claude --print`, `gemini -p`, `codex exec`) via user subscriptions — no API keys needed

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
