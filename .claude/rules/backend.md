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
├── present/           # /present dashboard (index.ts template + signals.ts + vault-look.ts)
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
| `DEEPGRAM_API_KEY` | No | - | Cloud transcription (metered) |
| `OPENAI_API_KEY` | No | - | **Metered.** Present in `.env`; its presence is what puts the live path on the API |
| `TYPESAFE_API_KEY` | No | - | **Metered.** Jev gate before the coach's generative call (~$0.000042/call) |
| `COPILOT_LIVE_LLM_MODE` | No | auto | `cli` forces the live path onto the subscription CLIs |
| `COPILOT_JEV_INPUT_PER_MILLION` | No | 0.042 | Jev input price for the budget guard |
| `COPILOT_JEV_OUTPUT_PER_MILLION` | No | 0.42 | Jev output price — unpublished, deliberately pessimistic |
| `COPILOT_PORT` | No | 17890 | TCP port (the Swift app honors it too via ServerConfig) |
| `SHARE_TRANSCRIPT` | No | true | Set to `false` to disable shared transcript writing |
| `SUGGESTION_TTL_MS` | No | 60000 | Legacy default for suggestion TTL |
| `GEMINI_TRIAGE_TIMEOUT_MS` | No | 12000 | Tier-1 triage timeout before Haiku fallback |
| `COPILOT_DISABLE_PAID_API` | No | - | `1` = hard zero-API-spend (CLIs/subscription only) |
| `COPILOT_ENABLE_HTTP_TRANSCRIBE` | No | - | `1` re-enables the legacy POST /transcribe path |
| `CXMAIL_DB_PATH` | No | `~/Library/Application Support/com.cxmail.app/cxmail.db` | cxmail DB for start-form meeting auto-fill (read-only) |
| `ONYX_URL` | No | `http://127.0.0.1:8899` | Where the dashboard reads the vault palette from (Onyx's `/api/vault-look`) |

> **Settings precedence**: `~/.meeting-copilot/settings.json` (written by the dashboard gear panel via `POST /settings`) **beats env vars**, which beat hardcoded defaults. Env vars remain as back-compat defaults only.

> **Transport reality (corrected 2026-09-19)**: the live path runs on **metered OpenAI**, not the subscription. `runHaikuTriage` / `runSonnetSuggestion` / `runLiveJson` all take the API branch when `LLM_CONFIG.liveTransport !== 'cli'` **and** `isOpenAiApiAvailable()` — and `COPILOT_LIVE_LLM_MODE` is unset while `OPENAI_API_KEY` is present, so that branch is the default. `COPILOT_LIVE_LLM_MODE=cli` forces the subscription CLIs; `COPILOT_DISABLE_PAID_API=1` hard-blocks all three metered providers (OpenAI, Anthropic, Deepgram) plus Jev. **`ANTHROPIC_API_KEY` remains correctly neutralized** — every `claude` spawn site deletes it from the child env, and the API-path Anthropic call count in `server.log` is 0.

## Dashboard appearance — the vault look

`/present` can wear the Obsidian vault's palette, the same one Onyx wears. The
chain, all in `server/src/present/vault-look.ts`:

```
Obsidian plugin → Onyx (derives the palette) → GET /api/vault-look
    → parseOnyxPalette (re-validate) → vaultLookCss (rename into our tokens)
    → applyVaultLook (splice into the page before it is sent)
```

Four things are deliberate:

1. **Nothing Onyx sends is pasted into the page.** Values are parsed, checked
   against a grammar (plain RGB triplets; a font screened the way
   `markdown_theme._UNSAFE` screens it), and re-emitted from our own numbers.
2. **The vault layer only overrides.** It is one `:root.vault-look` rule sitting
   on top of the full `[data-theme]` block its own mode selects, so the semantic
   colours, shadows, radii and `--font-mono` stay the app's. An unmapped token
   cannot come out unset.
3. **Falling back is not an error.** Fresh palette → last good (memory, then
   `~/.meeting-copilot/vault-look.json`) → the CX family tokens. Restarting Onyx
   must not repaint a dashboard someone is presenting. Misses are cached for
   60s too, so a hung Onyx costs one 400ms page load per minute, not every load.
4. **First paint, not a restyle.** The mode and the CSS go into the markup before
   it is sent; the page only re-takes the palette (`GET /present/vault-look`) on
   WS reconnect, on regaining visibility, and after saving Settings.

`--accent-ink` is the one token invented for this: Onyx holds a vault's accent to
3:1 against its ground, which is enough to read as text but not to carry text, so
the ink on an accent FILL (primary button, LIVE pill) is chosen by contrast.

Switch: `matchVaultAppearance` in settings.json (default on), gear panel →
Appearance. While it is on, the header light/dark button reads "Vault" and is
disabled — the vault drives the mode, exactly as in Onyx.
