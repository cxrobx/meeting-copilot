# API Reference

## WebSocket Protocol

**Endpoint**: `ws://localhost:17890` (port = `COPILOT_PORT`; a Unix socket at `~/.meeting-copilot/copilot.sock` is also served). The browser dashboard connects as an additional WS client alongside the Swift app.

### Client → Server Messages

| Type | Purpose | Key fields |
|------|---------|------------|
| `audio_chunk` | Stream one audio chunk (base64 WAV, 16kHz mono) | `data, source: 'mic'\|'meeting', audioDurationSec?, sequence?, isContinuation?` |
| `audio.flush` | Flush VAD-buffered trailing audio at stop | — |
| `session.start` | Begin a meeting session | `title?, agenda?, attendees?, projectNames?, contextPaths?` |
| `session.stop` | End the session (idempotent) | — |
| `action.approve` | Approve a suggestion (also used for Retry on failed) | `actionId` |
| `action.dismiss` | Dismiss a suggestion | `actionId` |
| `action.cancel` | Cancel a running action | `actionId` |
| `action.trigger` | Manually fire a worker (Quick Actions) | `actionType, prompt?, cardContent?, baseWireframe?, baseHtml?` |
| `feature.toggle` | Toggle an opt-in monitor | `feature: 'factcheck'\|'coach', enabled` |
| `meeting.goals` | Private coach-only goals for this meeting | `goals` |
| `meeting.schedule` | Calendar end of a meeting started from an invite; the pulse runs its close-out 5 min before | `endsAt` (ISO or ms) |
| `pulse.request` | A pulse read now: `checkin` is "How am I doing?", `missed` is "Missed anything?", `closeout` (or no kind) is the Wrap-up check. Sent by the coach head and by the app's ⌃⌥1/⌃⌥2 hotkeys | `kind?` |
| `coach.ask` | "Suggest": one coach card now, with the live coach on or off. Sent by the coach head and by ⌃⌥3 | `focus?` (the Quick Actions box) |

### Server → Client Messages

| Type | Purpose | Key fields |
|------|---------|------------|
| `transcript.update` | Segment added/grown (stitcher re-emits same id) | `segment { id, text, source, label, timestamp, wordCount, replace? }` |
| `action.suggested` | Suggestion card created/streaming update | `action { id, type, title, description, state, streaming?, paramsReady?, pendingApproval? }` |
| `action.status` | Action lifecycle change | `actionId, state, result?` |
| `action.stream` | Token delta from a streaming worker | `actionId, delta` |
| `session.state` | Authoritative session state | `state, sessionId?, message?, startedAt?, title?` |
| `agenda.status` | Agenda coverage update (8s cadence) | `status { items, missing }` |
| `intelligence.status` | Eval-loop phase indicator | `phase: 'idle'\|'evaluating'\|'generating'` |
| `intelligence.error` | Realtime intelligence failure; `degraded` = the AI stopped for the session (budget lockout only) | `source, message, at, degraded?` |
| `feature.state` | Monitor on/off snapshot | `features { factcheck, coach }` |
| `factcheck.flag` | Fact-check verdict on a claim | `flag { claim, verdict, correction?, sources? }` |
| `coach.suggestion` | "Say next" coach tip; `asked: true` for a Suggest card, which stays until dismissed | `suggestion { kind, priority, headline, asked?, ... }` |
| `coach.history` | Every coach card this session, sent on connect so a reload keeps them | `suggestions [ ... ]` |
| `pulse.update` | A meeting pulse (every 5 min, or a close-out); also sent on connect | `pulse { mode, trigger, status, read, escalations[], closeOut[], missed[], minutesIn, minutesLeft }` |
| `pulse.history` | Every pulse this session, sent on connect for the coach's Earlier list | `pulses [ ... ]` |
| `pulse.running` | A pulse is being read (20–40s on Opus) | `mode`, `trigger` |
| `pulse.failed` | A pulse could not be read | `reason`, `mode`, `trigger` |
| `pulse.closeout` | A timer's close-out (calendar or wrap-up language) found things to settle; the app raises a notification | `body` |
| `ask.state` | One of the coach's questions was taken (`started`), answered (`done`) or `failed`. The dashboard's buttons show progress from it; the app turns `title`/`body` into a notification when the dashboard is not in front | `kind` (checkin/missed/suggest/wrapup), `phase`, `title?`, `body?`, `empty?` |
| `metrics` | Debug metrics snapshot | `data` |

## REST Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check (`{ status, session, whisperAvailable }`) |
| GET | `/preflight` | Dependency checks (whisper, claude CLI, model, storage) |
| GET | `/debug` | Server metrics and diagnostics |
| GET | `/transcript` | Live session transcript (refresh persistence) |
| GET | `/settings` | Effective settings + shareTranscript state |
| POST | `/settings` | Persist + apply settings (`evalCadenceMs, suggestionTtlMs, monitorDefaults, retentionDays, summaryAutoWrite, shareTranscript`); unknown fields reported in `ignored` |
| GET | `/projects` | Scan `~/Projects/**/CLAUDE.md` for project pickers |
| GET | `/calendar/upcoming` | Upcoming meetings from cxmail's invite DB (read-only; `{ meetings: [] }` when absent) |
| GET | `/coach/standing-goals` | Goals the last five self-reviews keep repeating, with evidence; pre-fills the start form's private goals (`{ goals: [] }` with no pattern yet) |
| GET/POST/DELETE | `/context-sources` | Manage context files/folders (`/context-sources/add` alias) |
| GET | `/sessions` | Session history list |
| GET | `/sessions/:id/export?format=` | Export markdown/JSON |
| DELETE | `/sessions/:id`, POST `/sessions/delete` | Delete session(s) |
| POST | `/agenda/extract` | LLM agenda extraction from pasted notes |
| POST | `/meeting/prep` | Pre-meeting prep: email/past-session/vault context + a web-research agent (subscription CLI) → brief + agenda. Body `{ title?, attendees?, notes?, meeting? }` (`meeting` = a `/calendar/upcoming` entry). Streams NDJSON: `{type:"progress",message}`… then `{type:"result",brief,agenda,sources,mode,stats}` or `{type:"error",message}`. Closing the response cancels the agent |
| GET | `/present` | The dashboard (HTML) |
| GET | `/present/actions` / `/present/transcript` / `/present/sessions` | Dashboard data (live or `?session=<id>` replay) |
| GET | `/present/coach?session=<uuid>` | Coach cards a stored session showed (from `coach_suggestion`; older sessions fall back to the event log's headlines) |
| GET | `/present/pulse?session=<uuid>` | Meeting pulses a stored session produced, oldest first (`[]` before 2026-09-22) |
| GET | `/present/events` | SSE fallback (replay only; suggested/running/completed) |
| POST | `/present/ask` | Highlight-to-ask (SSE token stream) |
| POST | `/present/review` | On-demand Opus self-review for a session |
| GET | `/vendor/*` | Vendored dashboard assets (marked/DOMPurify/hljs/fonts) |
| POST | `/transcribe` | **Gated legacy path** — 410 unless `COPILOT_ENABLE_HTTP_TRANSCRIBE=1` (bypasses dedup + stitcher) |

## Session Storage

Each session stores data at `~/.meeting-copilot/sessions/<uuid>/`:

| File | Purpose |
|------|---------|
| `session.db` | SQLite — session, transcript, action, context_summary tables |
| `events.jsonl` | Append-only event log |
| `manifest.json` | Metadata snapshot for external tools (refreshed on late results) |

Server settings persist at `~/.meeting-copilot/settings.json` (file > env > defaults).
