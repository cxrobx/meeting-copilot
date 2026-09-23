# Meeting Copilot

AI agent that activates during meetings to generate live research, mockups, and analysis with approval flows.

## Architecture

Two-process design:
- **SwiftUI Menubar App** (`app/MeetingCopilot/`) — audio capture (Core Audio process tap + AVAudioEngine; ScreenCaptureKit fallback), WKWebView dashboard, process supervision
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

- **Audio**: Core Audio process tap (meeting — hears phone and FaceTime calls too; ScreenCaptureKit fallback) + AVAudioEngine (mic), 16kHz mono PCM
- **Transcription**: live streaming Grok Voice Transcribe 2.0 by default (the app sends 100 ms PCM frames; text trails speech by ~1 s), with the app's VAD chunks going to local Parakeet whenever a stream is down. Needs `COPILOT_ALLOW_CLOUD_AUDIO=true` + `XAI_API_KEY`; otherwise fully local (Parakeet, whisper fallback). `COPILOT_GROK_STREAMING=0` = per-chunk batch Grok; `COPILOT_CLOUD_TRANSCRIPTION=deepgram|off` for the others
- **Intelligence**: gpt-6-luna triage via the OpenAI API (15s cadence) → Sonnet suggestions on the subscription CLI. Triage falls back to Haiku on the subscription CLI when the API is off (`COPILOT_LIVE_LLM_MODE=cli`) or fails twice. Context compression (the 5-min summaries fed back into triage) runs the same route
- **Meeting pulse** (`intelligence/pulse.ts`): every 5 min, Opus 5.5 on the subscription CLI reads the whole meeting and updates one card: on track / drifting / stuck, up to 2 things to escalate, and what to settle before the end. A close-out pass runs 5 min before the calendar end (invite-started meetings), on wrap-up language after minute 10, or on the Wrap-up button, and the app raises a notification for it. It shares one CLI lane with the rolling summary (`intelligence/cli-lane.ts`) and always runs cold, since a warm session would carry the previous transcript. Costs no metered spend.
- **Workers**: Research, Summary, Analysis, Mockup, CodeGen (all implemented)
- **Staged preps** (`prep/staged.ts`; the `meeting-copilot-prep` skill in `skills/meeting-copilot-prep/`, linked into `~/.claude/skills/`): Claude prepares a session ahead of time: everything the start form takes plus a research brief, written through `scripts/stage-prep.sh` (the only writer; it checks the input) into `~/.meeting-copilot/staged/`. The form fills itself from the soonest one while untouched, so what is left at meeting time is one click on "Participants informed — Start Session". On Start the file moves into the session as `prep.json` and the brief becomes a pinned context doc (always in the suggestion context block). Works with the app closed
- **Show a card / share a card** (`present/view-page.ts`, `publish/`): ↗ opens any completed card in a browser tab (`/present/action/:id/view`), which is what goes on a screen share. "Publish link" (two clicks = the approval) has a Claude agent on the subscription rewrite the card as the body of an HTML Artifact Kit page (the Onyx artifacts' look; the server supplies the kit shell, read live from `~/.claude/docs/html-design`), then the server uploads it to the R2 bucket `mc-share` at `https://share.cxventures.io/<128-bit key>`, noindex. Unusable agent output falls back to the reader page; mockups go up as-is. The agent never holds the Cloudflare key: uploads run `wrangler` under `secret run -k CF_API_KEY` inside `zsh -c` (for `~/.zshenv`'s `CF_EMAIL`/`CF_ACCOUNT_ID`). Every link is in `~/.meeting-copilot/published.jsonl`; Unpublish deletes the object
- **UI**: Web dashboard at `/present` served in WKWebView — CX family design system shared with cxmail/cxtasks/cxnotes (Apple-blue accent in light, red `255 69 58` in dark — held over a dark vault too, see `DARK_ACCENT` in `present/vault-look.ts`; warm charcoal/off-white surfaces, SF system sans with JetBrains Mono reserved for data). Dark default + light toggle via `data-theme` on `<html>`, remembered in `localStorage['mc-theme']`. Full-screen **Stage** presentation mode is always dark.
- **Storage**: SQLite per session at `~/.meeting-copilot/sessions/<id>/`
- **Privacy**: No raw audio stored. Consent affirmation per session: the start form's checkbox, or on a form filled from a staged prep, the "Participants informed — Start Session" button itself (a prep never carries consent). Visible REC indicator.

## Environment

- `XAI_API_KEY` — Grok Voice Transcribe 2.0, the default cloud transcription (needs `COPILOT_ALLOW_CLOUD_AUDIO=true`; local Parakeet takes over per chunk on failure)
- `COPILOT_GROK_STREAMING=0` — per-chunk batch Grok instead of live streaming (app side: `MC_STREAM_FRAMES=0` stops sending frames)
- `COPILOT_STT_GATE=0` — turn off the noise gate in front of the Grok stream (xAI bills every second sent, per channel, silence included)
- `DEEPGRAM_API_KEY` — optional, only with `COPILOT_CLOUD_TRANSCRIPTION=deepgram`
- `OPENAI_API_KEY` — **metered.** Present in `~/.meeting-copilot/.env`, and the live path prefers it
- `TYPESAFE_API_KEY` — **metered.** Jev gate in front of the coach's generative call
- `COPILOT_PORT` — TCP port (default: 17890; honored by BOTH server and app via `ServerConfig`)
- `COPILOT_LIVE_LLM_MODE=cli` — force the live path onto the subscription CLIs
- `COPILOT_DISABLE_PAID_API=1` — hard zero-API-spend mode (CLIs/subscription only); also disables Jev
- `COPILOT_RESEARCH_DEEP_FOLLOWUP=0` — turn off the Opus deep follow-up on research requests (on by default, subscription CLI)
- User-tunable settings live in `~/.meeting-copilot/settings.json` (dashboard gear panel → `POST /settings`; beats env vars)

> **The live path is METERED, not subscription.** This said "no API keys required — all
> AI calls use headless CLIs via user subscriptions" until 2026-09-19, and it had been
> wrong since at least 2026-07-28: `server.log` holds 789 metered OpenAI calls between
> then and 2026-09-14 (~$1 total). `intelligence/index.ts` takes the API branch whenever
> `liveTransport !== 'cli'` **and** an `OPENAI_API_KEY` is present — both true by default.
> This is deliberate (the `db9ab7c` budget guard exists to cap exactly this spend), but it
> is not the subscription. Anthropic spend is separately zero: the June fix strips
> `ANTHROPIC_API_KEY` from every `claude` child env and `grep -c '\[api/anthropic\]'` is 0.
> Per-call cost: Terra coach $0.0027 · Luna triage $0.00047 · Jev $0.000042.
> For a genuinely subscription-only run, set `COPILOT_LIVE_LLM_MODE=cli`.

## Golden Commands

```bash
./scripts/setup.sh                       # Install deps, download whisper model
./scripts/start.sh                       # Launch server + whisper-server
cd server && npm run dev                 # Dev with tsx (hot reload)
cd app/MeetingCopilot && swift build     # Build Swift app
./scripts/build-app.sh                   # Package signed .app → dist/ (does not install)
./scripts/ship.sh                        # Test, package, verify, confirm, install + relaunch
./scripts/stage-prep.sh --list           # Preps waiting to fill the start form (--invites, --gather, <file.json>)
./scripts/replay.sh                      # Test with text fixtures
./scripts/replay-audio.sh <dir> --speed 4 --auto-approve  # Test with real audio
open "/Applications/Meeting Copilot.app" # Launch packaged app
```

## Critical Invariants (DO NOT BREAK)

1. **No raw audio storage** — audio streams but never persists to disk (privacy)
2. **Session isolation** — each meeting gets its own SQLite DB, never shared
3. **Approval before action** — suggestions require user approval before workers execute
4. **16kHz mono PCM** — both audio sources must output this format
5. **NEVER `toISOString()` for a filename date** — it renders UTC, so any meeting after ~20:00 ET is stamped with tomorrow. Vault notes use `<CATEGORY> <Who|Topic> <MM.DD.YY>.md` in **local** time, from the session's own `startedAt` (not "now"). Helpers: `server/src/workers/filename.ts`; convention: `~/Documents/CX/CLAUDE.md`; mirror: `~/Projects/cxnotes/services/summariser.js` (`buildObsidianFilename`) — category is content-earned or absent, never a default

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

- 2026-09-22: **The menu bar popover now has CXNotes' layout and wears the dashboard's vault look** (`Features/MenuBar/`; `MenuBarTheme` reads `tokens` from `GET /present/vault-look`, falls back to CXNotes' palette): idle shows the viewfinder REC button, the next cxmail invite and recent sessions; a live meeting shows timer, per-track level bars, the pulse, pending suggestions with Approve/Dismiss, and an Ask box (the Research path: fast, then deep). It drives the dashboard through one entry point, `window.__copilotMenubar`. Building it exposed gotcha #23: the app had been dropping every `transcript.update` and `action.suggested` because `.iso8601` rejects the server's milliseconds. Render the popover with `MC_RENDER_DIR=<dir> swift test --filter MenuBarRenderTests`.
- 2026-09-22: **Three failure types named, each with an automatic check.** (1) *A non-dollar ceiling binds before the dollar one*: a 500-request lifetime cap stopped the copilot at minute 26 of 33 (09-21) and 32 of 38 (09-14) on about $0.68 of $10. Dollars are now the only lifetime stop; counts are a one-minute runaway window (`api/budget.ts`, a 90-minute peak-rate test). (2) *gpt-6-luna writes past its JSON object* (gotcha #21): every live parser goes through `intelligence/first-json.ts`. (3) *Dashboard JS escapes decode twice* inside `PRESENT_HTML` (gotcha #22): `present-script.test.ts` parses the shipped script. Agenda reconcile moved to gpt-6-luna after `npm run eval:agenda` replayed real sessions against gpt-5.6-terra. Run it under Node 20, and reuse a paid baseline with `--baseline-from`.
- 2026-09-21: **Calls handed off from an iPhone (and FaceTime calls) were only half transcribed** — the other party is played by `avconferenced`, a system daemon that ScreenCaptureKit's app list never shows. Meeting audio now comes from a Core Audio process tap (tap-only aggregate, `.unmuted`), with ScreenCaptureKit as the fallback. It needs the System Audio Recording grant, and a missing one shows up as silent zeros, not an error. Full landmine list: gotcha #20.
- 2026-06-17: **A live `ANTHROPIC_API_KEY` in `~/.meeting-copilot/.env` silently billed the API console (~19M tokens in one day), NOT the subscription** — corrects the earlier note below that the env key is "ignored." The server `dotenv`-loads that file into `process.env`, and `claude-cli.ts` / `persistent-claude.ts` spawned `claude` with `{ ...process.env }`, so the CLI **inherited the key and preferred it over OAuth**, billing every triage (haiku) + suggest (sonnet) + worker call to the API even though the `[LLM] …=cli (subscription)` banner claimed otherwise. The CLI login here is OAuth/subscription (`~/.claude.json` `oauthAccount`, no `apiKeyHelper`), so **with no key in env the CLI falls back to the subscription (free).** The "ignored" finding was only true while the key was *dead* (401 → OAuth fallback); a *live* key is used. Two fixes: (1) commented `ANTHROPIC_API_KEY` out of `~/.meeting-copilot/.env`; (2) all three `claude` spawn sites now `delete env.ANTHROPIC_API_KEY` + `delete env.ANTHROPIC_AUTH_TOKEN`, so the CLI can never bill an API key even if one is set for the SDK paths (`api/anthropic.ts`). For a hard zero-API-spend run, set `COPILOT_DISABLE_PAID_API=1`. Verify after any change: a stripped-env `claude -p` call still returns (subscription works), and the Anthropic API console shows no new haiku/sonnet streaming rows during a session.
- 2026-06-17: **Headless `claude` CLI was slow because it loaded the user's entire MCP fleet (~27 servers) on every spawn** — ~6.7s CPU/call, and concurrent spawns thrashed (agenda latency blew to 45s, starving realtime suggestions). Two fixes in `server/src/claude-cli.ts`: (1) `--strict-mcp-config` on every `claude` spawn cuts CPU to ~0.66s and keeps subscription/OAuth auth (verified the dead `ANTHROPIC_API_KEY` in env is ignored — CLI uses OAuth); (2) `server/src/persistent-claude.ts` keeps one warm `claude --input-format stream-json` session per (model, systemPrompt) — cold ~2.9s → warm ~1.5s — recycled every 5 turns to bound context, idle-disposed after 120s, disposed on shutdown (SIGTERM→SIGKILL). `claudeChat`/`claudeSuggest` use it transparently for tool-less calls with cold-spawn fallback; tool-using workers stay cold, and so does any call passing `cold: true` (the meeting pulse, whose transcript-sized prompt would otherwise sit in the warm session's context for the next call). Tune via `COPILOT_WARM_SESSION_TURNS` / `COPILOT_WARM_SESSION_IDLE_MS` / `COPILOT_DISABLE_WARM_SESSIONS`. **Note:** the `--bare` flag (1.5s cold) is NOT usable here — it bypasses the keychain and forces `ANTHROPIC_API_KEY` (the dead key).
- 2026-06-17: Meeting Copilot's per-call `claude` spawns were firing the user's global Stop hook (`~/.claude/hooks/notify-stop.sh` → `afplay`) 20+×/min. Server now sets `MEETING_COPILOT=1` (also in `~/.meeting-copilot/.env`); the user's `notify-stop.sh` / `notify-bash-complete.sh` `exit 0` when it's set. Interactive sessions still ding.
- 2026-04-21: **ScreenCaptureKit silent-frames root cause identified** — Rogue Amoeba's `ARK.driver` loading inside `coreaudiod` causes `SCContentFilter(display:excludingApplications:[])` to return zero-filled buffers system-wide (also affected notes4chris). Switched to `SCContentFilter(display:including:capturedApps,…)` which taps per-app audio directly. Detect with `sudo sample coreaudiod 5 | grep -i ARK.driver`. Full details + recovery ladder in `.claude/rules/gotchas.md` §12 and the Recovery Playbook.
- 2026-04-21: `claude` CLI lives at `~/.local/bin/claude`, which `ProcessSupervisor.processEnvironment()` did not include — any CLI-based worker/eval returned ENOENT silently. Fix: PATH injection now appends `~/.local/bin` + all `~/.nvm/versions/node/*/bin`, and `extractAgendaItemsFromNotes` prefers the direct Anthropic API when `ANTHROPIC_API_KEY` is set (sidesteps PATH entirely). See gotcha #13.
- 2026-04-21: Native-module ABI mismatch (nvm Node 24 at build, homebrew Node 20 at runtime) silently broke every `session.start` via `better-sqlite3`. `build-app.sh` now pins PATH to the same Node resolution `ProcessSupervisor` uses and aborts the build if `require('better-sqlite3')` fails under the runtime Node. See gotcha #14.
- 2026-04-21: Self-healing wired into the process / WS layers — `ProcessSupervisor` now polls `/health` every 15s, force-restarts hung servers after 3 consecutive failures, uses exponential backoff (1→2→4→8→16→30s) with the restart budget resetting on 60s of sustained health, and surfaces a macOS notification when the supervisor gives up. `WebSocketClient` uses the same backoff with unlimited retries (reset on connect) so long outages self-recover without a relaunch.
- 2026-03-24: Claude CLI `--output-format json` wraps response in `{"type":"result","result":"..."}` envelope with OSC escape sequences — must strip `\x1b]...\x1b\` and extract `result` field; empty result on `error_max_turns`
- 2026-03-24: Claude CLI has no `--max-tokens` flag — use `--max-budget-usd` for cost control
- 2026-03-24: WAV chunks sent to whisper-server need proper 44-byte WAV headers, not raw PCM
- 2026-03-24: WKWebView needs `NSAllowsLocalNetworking` in Info.plist + health polling before loading localhost URLs
- 2026-03-24: CSS `zoom` property via JS works for browser-style Cmd+/- zoom in WKWebView; `allowsMagnification` only does bitmap scaling
- 2026-03-24: 3-column layout requires fixed-height grid container (`height: calc(100vh - header)`) with each column having independent `overflow-y: auto`
- 2026-03-10: Shared transcript protocol added — `server/src/session/shared.ts` writes presence + JSONL, notes4chris reads at processing time
- 2026-03-10: `.app` bundle works — `build-app.sh` produces 45MB bundle; `ProcessSupervisor` prefers bundle path via `isPackaged` check
- 2026-03-10: `segment.timestamp` is epoch-ms, `segment.duration` is whisper latency — shared.ts converts to session-relative seconds and uses fixed 10s chunk duration
- 2026-03-10: Finder-launched apps need PATH injection for `/opt/homebrew/bin` — `processEnvironment()` handles this
- 2026-03-10: Set up compound documentation infrastructure with gold standard pattern
