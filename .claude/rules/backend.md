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
├── index.ts           # Main entry — Express + WebSocket server (~20KB)
├── claude-cli.ts      # Claude CLI integration helper
├── transcription/     # Transcription providers
│   ├── whisper.ts     # Local whisper-server provider
│   └── deepgram.ts    # Cloud Deepgram provider (optional)
├── intelligence/      # AI eval pipeline
│   ├── triage.ts      # Haiku triage (15s cadence)
│   └── suggest.ts     # Sonnet suggestion generation
├── workers/           # Task execution
│   ├── research.ts    # Web research worker
│   ├── summary.ts     # Meeting summary worker
│   ├── analysis.ts    # Data analysis worker
│   ├── mockup.ts      # UI mockup (stub)
│   └── codegen.ts     # Code generation (stub)
├── session/           # Per-meeting persistence
│   ├── store.ts       # SQLite session store
│   ├── events.ts      # JSONL event logger
│   ├── shared.ts      # Shared transcript writer (presence + JSONL for notes4chris)
│   └── cleanup.ts     # Session cleanup + stale presence detection
└── debug/             # Debug/metrics
    └── metrics.ts     # /debug endpoint
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
| `ANTHROPIC_API_KEY` | Yes | - | Intelligence + workers |
| `DEEPGRAM_API_KEY` | No | - | Cloud transcription |
| `COPILOT_PORT` | No | 17890 | TCP port |
| `SHARE_TRANSCRIPT` | No | true | Set to `false` to disable shared transcript writing |
