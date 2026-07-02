---
paths:
  - "server/**/*.ts"
  - "server/**/*.js"
---

# Backend Patterns

## Tech Stack

- Node.js with TypeScript (ESM modules)
- Express for HTTP endpoints
- ws (WebSocket) for real-time communication with Swift app
- better-sqlite3 for per-session storage
- Anthropic SDK for intelligence pipeline
- tsx for dev mode, tsc for production build

## Directory Structure

```
server/src/
├── index.ts           # Main entry — Express + WebSocket server
├── claude-cli.ts      # CLI fallback chain (gemini→haiku→codex) + Gemini circuit breaker
├── persistent-claude.ts # Warm `claude` session pool for tool-less calls
├── settings.ts        # ~/.meeting-copilot/settings.json (cadence/TTL/monitors/retention)
├── calendar/          # Upcoming meetings read-only from cxmail's invite DB (start-form auto-fill)
├── transcription/     # Transcription providers (whisper/parakeet, deepgram, dedup, stitcher)
├── intelligence/      # Eval loop (triage→suggest), agenda, coach, factcheck, prompts
├── workers/           # Research, FastResearch, Summary, Analysis, Mockup, CodeGen, Review
├── present/           # /present dashboard (index.ts template + signals.ts)
├── session/           # SQLite store, JSONL events, shared transcript, cleanup, reviews
├── api/               # Direct-API paths (anthropic, openai) + paid-API killswitch
└── debug/             # /debug endpoint
server/vendor/         # Vendored dashboard assets (marked/DOMPurify/hljs/fonts) — scripts/vendor-assets.sh
```

## Server Commands

```bash
cd server && npm run dev      # Dev with tsx (hot reload)
cd server && npm run build    # Compile TypeScript
cd server && npm start        # Run compiled dist/index.js
```

## API Patterns

- **HTTP**: Express on `localhost:17890` — REST endpoints for debug/status
- **WebSocket**: `ws://localhost:17890` — real-time audio/transcript/suggestion streaming
- **Session storage**: `~/.meeting-copilot/sessions/<uuid>/` — SQLite DB + JSONL events per meeting

## Intelligence Pipeline

1. Audio chunks arrive via WebSocket from Swift app
2. Transcription provider (whisper/deepgram) produces text
3. Haiku triage evaluates transcript buffer every 15s
4. If actionable: Sonnet generates suggestions
5. Suggestions sent to Swift app via WebSocket for approval
6. Approved suggestions dispatched to appropriate worker

## Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DEEPGRAM_API_KEY` | No | - | Cloud transcription |
| `COPILOT_PORT` | No | 17890 | TCP port (the Swift app honors it too via ServerConfig) |
| `SHARE_TRANSCRIPT` | No | true | Set to `false` to disable shared transcript writing |
| `SUGGESTION_TTL_MS` | No | 60000 | Legacy default for suggestion TTL |
| `GEMINI_TRIAGE_TIMEOUT_MS` | No | 12000 | Tier-1 triage timeout before Haiku fallback |
| `COPILOT_DISABLE_PAID_API` | No | - | `1` = hard zero-API-spend (CLIs/subscription only) |
| `COPILOT_ENABLE_HTTP_TRANSCRIBE` | No | - | `1` re-enables the legacy POST /transcribe path |
| `CXMAIL_DB_PATH` | No | `~/Library/Application Support/com.cxmail.app/cxmail.db` | cxmail DB for start-form meeting auto-fill (read-only) |

> **Settings precedence**: `~/.meeting-copilot/settings.json` (written by the dashboard gear panel via `POST /settings`) **beats env vars**, which beat hardcoded defaults. Env vars remain as back-compat defaults only. NO `ANTHROPIC_API_KEY` is required — all AI calls ride CLIs on user subscriptions, and `claude` spawn sites strip the key from child env so it can never bill the API console.
