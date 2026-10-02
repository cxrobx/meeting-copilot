# API Reference

## WebSocket Protocol

**Endpoint**: `ws://localhost:17890` (port = `COPILOT_PORT`; a Unix socket at `~/.meeting-copilot/copilot.sock` is also served). The browser dashboard connects as an additional WS client alongside the Swift app.

### Client → Server Messages

| Type | Purpose | Key fields |
|------|---------|------------|
| `audio_chunk` | Stream one audio chunk (base64 WAV, 16kHz mono) | `data, source: 'mic'\|'meeting', audioDurationSec?, sequence?, isContinuation?` |
| *(binary frame)* | Live audio for streaming transcription: one binary message per 100 ms, not JSON | byte 0 = `0x01` mic / `0x02` meeting, then 3,200 bytes PCM16 LE 16 kHz mono. JSON messages start with `{`, which is how the server tells them apart |
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
| `meeting.prep` | The start form's prep brief, sent once live. A staged prep's file moves into the session as `prep.json`; the brief (the one shown, else the file's) becomes a pinned context doc. Its evidence tabs are broadcast as `evidence.tabs` and every live URL opens in the default browser (`COPILOT_OPEN_EVIDENCE=0` stops that) | `prepId?` (staged), `brief?`, `sources?` |
| `pulse.request` | A pulse read now: `checkin` is "How am I doing?", `missed` is "Missed anything?", `closeout` (or no kind) is the Wrap-up check. Sent by the coach head and by the app's ⌃⌥1/⌃⌥2 hotkeys | `kind?` |
| `coach.ask` | "Suggest": one coach card now, with the live coach on or off. Sent by the coach head and by ⌃⌥3 | `focus?` (the Quick Actions box) |
| `chat.send` | A question for the live meeting's chat (`chat/service.ts`). The app's menu bar Ask sends it; the dashboard asks over `POST /present/chat` instead, which also works on a stored meeting. Ignored with no live meeting | `text`, `origin?: 'menubar'` (default) \| `'dashboard'` |
| `chat.cancel` | Stop the live meeting's chat answers (queued or streaming) | — |

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
| `coach.partial` | A Suggest answer while it is being written (OpenAI path only); the `coach.suggestion` that follows replaces it | `headline, phrasing` |
| `coach.history` | Every coach card this session, sent on connect so a reload keeps them | `suggestions [ ... ]` |
| `pulse.update` | A meeting pulse (every 5 min, or a close-out); also sent on connect | `pulse { mode, trigger, status, read, escalations[], closeOut[], missed[], minutesIn, minutesLeft }` |
| `pulse.history` | Every pulse this session, sent on connect for the coach's Earlier list | `pulses [ ... ]` |
| `pulse.running` | A pulse is being read (20–40s on Opus) | `mode`, `trigger` |
| `pulse.failed` | A pulse could not be read | `reason`, `mode`, `trigger` |
| `pulse.closeout` | A timer's close-out (calendar or wrap-up language) found things to settle; the app raises a notification | `body` |
| `ask.state` | One of the coach's questions was taken (`started`), answered (`done`) or `failed`. The dashboard's buttons show progress from it; the app turns `title`/`body` into a notification when the dashboard is not in front | `kind` (checkin/missed/suggest/wrapup), `phase`, `title?`, `body?`, `empty?` |
| `evidence.tabs` | A staged prep's evidence tabs, once its `meeting.prep` attaches. The dashboard renders them as tabs atop the main column; a reload fetches `GET /present/evidence` instead | `tabs [{ index, title, url, note, snapshot: {kind: image\|pdf\|html, name} \| null }]` |
| `publish.state` | A card's publish-as-link job moved on: `polishing` → `uploading` → `done` (with `url`) or `failed` (with `error`); `revoked` after Unpublish. Replay pages, which have no WebSocket, poll `GET /present/published` instead | `actionId, phase, url?, error?` |
| `chat.message` | A meeting chat message was added or changed: the question, the answer as it starts (`state: "streaming"`, empty), and the finished answer (`done`, `error` with `error`, or `cancelled` with what streamed). Idempotent by `message.id`; the app shows menu bar answers from it | `sessionId, message { id, role: user\|assistant, content, attachments[], origin: dashboard\|menubar, state, error?, via?, createdAt }` |
| `chat.delta` | Answer text as it streams. `seq` counts from 1 per answer: the page that asked also gets each delta over its POST, and applies it once | `sessionId, id, seq, text` |
| `metrics` | Debug metrics snapshot | `data` |

## REST Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check (`{ status, session, transcriptionAvailable, transcription }`, plus `fakeChat: true` only when the e2e chat answerer is on) |
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
| GET | `/prep/staged` | Preps staged ahead of time (`scripts/stage-prep.sh`), soonest meeting first; the start form fills itself from the first. `{ preps: [], skipped: [{file, reason}] }` — `skipped` names files this build can't read |
| POST | `/meeting/prep` | Pre-meeting prep: email/past-session/vault context + a web-research agent (subscription CLI) → brief + agenda. Body `{ title?, attendees?, notes?, meeting? }` (`meeting` = a `/calendar/upcoming` entry). Streams NDJSON: `{type:"progress",message}`… then `{type:"result",brief,agenda,sources,mode,stats}` or `{type:"error",message}`. Closing the response cancels the agent |
| GET | `/present` | The dashboard (HTML) |
| GET | `/present/actions` / `/present/transcript` / `/present/sessions` | Dashboard data (live or `?session=<id>` replay) |
| GET | `/present/coach?session=<uuid>` | Coach cards a stored session showed (from `coach_suggestion`; older sessions fall back to the event log's headlines) |
| GET | `/present/pulse?session=<uuid>` | Meeting pulses a stored session produced, oldest first (`[]` before 2026-09-22) |
| GET | `/present/evidence[?session=<uuid>]` | The session's evidence tabs, from its `prep.json` (no file paths). `{ tabs: [...] }`, same shape as `evidence.tabs` |
| GET | `/present/evidence/:i/file[?session=<uuid>][&frame=1]` | Tab `i`'s snapshot file, served by index only (never by a path from the request); 404 when it has none or the file is gone. `html` goes out under `CSP: sandbox allow-scripts`; with `frame=1` (the dashboard's frame) it also carries the selection bridge, which posts what is selected up to the page for the selection toolbar |
| GET | `/present/evidence/:i/view[?session=<uuid>]` | Tab `i` as its own page, the ↗ Snapshot button: the Artifact Kit page with the note, the image (a PDF embedded) and the live link. An `html` snapshot redirects to `/file` |
| GET | `/present/action/:id/view[?session=<uuid>]` | One card as its own page (the ↗ button). A mockup/`html` artifact is sent as-is under `CSP: sandbox allow-scripts`; anything else becomes a reader page in the HTML Artifact Kit look, server-rendered, reloading every 5 s while a deep follow-up is pending |
| GET | `/present/published[?session=<uuid>]` | The session's live links `{ records: {actionId: {url, key, via, at}}, busy, jobs }`; `jobs` = each card's latest `publish.state` since the server started |
| POST | `/present/action/:id/publish[?session=<uuid>]` | Publish a card at `https://share.cxventures.io/<key>`: 202 and progress over `publish.state`, 200 `{record}` if already live, 409 while another job runs or deep research is pending. The dashboard's second click is the approval |
| DELETE | `/present/action/:id/publish[?session=<uuid>]` | Take the page down (R2 delete) and mark the record revoked |
| GET | `/present/events` | SSE fallback (replay only; suggested/running/completed) |
| POST | `/present/ask` | Highlight-to-ask (SSE token stream) |
| GET | `/present/chat?session=<uuid>` | The meeting chat's thread, oldest first `{ sessionId, messages, busy }` (`sessionId: null` with no meeting). An answer the server lost mid-stream reads as `error` |
| POST | `/present/chat?session=<uuid>` | Ask the meeting chat. Body `{ text, attachments? }`: up to 6 of `{ kind: quote\|card\|tab\|pulse\|answer, label, text, context?, actionId?, tabIndex? }` (a `tab` is filled from the session's `prep.json` by `tabIndex`, never from `text`). Streams this turn as SSE, `event: message` (the question, then the answer's start and end) and `event: delta` (`{id, seq, text}`); the same events go out over the WebSocket. 400 empty, 404 no such meeting, 409 no meeting at all. Closing the response does not stop the answer |
| POST | `/present/chat/cancel?session=<uuid>` | Stop that meeting's queued or streaming answers `{ cancelled: n }` |
| POST | `/present/chat/task/file?session=<uuid>` | File a task draft into CXTasks: the user's approval (`chat/tasks.ts`, `cxtasks/client.ts`). Body `{ draftId, title?, body?, priority?: 0-3, due?: 'YYYY-MM-DD'\|'' }` (the edits win over the draft). `{ draft }`, 200 filed (`taskRef`, `taskId`), 502 CXTasks refused or failed (`draft.state: 'error'`, `draft.error`); 404 no such draft, 409 already filed, filing or dismissed. The message holding it goes out as `chat.message` at `filing` and at the end |
| POST | `/present/chat/task/dismiss?session=<uuid>` | Drop a draft `{ draft }` (409 once filed) |
| POST | `/present/chat/task/pulse?session=<uuid>` | Draft a pulse item, no model involved. Body `{ text, why? }`. `{ message }`: a new assistant turn (`via: 'pulse'`) carrying the draft, also broadcast |
| POST | `/present/review` | On-demand Opus self-review for a session |
| GET | `/vendor/*` | Vendored dashboard assets (marked/DOMPurify/hljs/fonts) |
| POST | `/transcribe` | **Gated legacy path** — 410 unless `COPILOT_ENABLE_HTTP_TRANSCRIBE=1` (bypasses dedup + stitcher) |

## Session Storage

Each session stores data at `~/.meeting-copilot/sessions/<uuid>/`:

| File | Purpose |
|------|---------|
| `session.db` | SQLite — session, transcript, action, context_summary, coach_suggestion, pulse and chat_message (the meeting chat's thread) tables |
| `events.jsonl` | Append-only event log |
| `manifest.json` | Metadata snapshot for external tools (refreshed on late results) |
| `published.json` | Links published from this session's cards, by action id (`revokedAt` once taken down). Every publish and revoke is also appended to the global `~/.meeting-copilot/published.jsonl` ledger |
| `prep.json` | The prep the session started from: a staged prep (moved here from `~/.meeting-copilot/staged/`) or the Prep button's brief (`origin: "form"`) |

Server settings persist at `~/.meeting-copilot/settings.json` (file > env > defaults).
