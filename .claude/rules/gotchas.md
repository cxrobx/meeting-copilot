# Known Gotchas

Organized by category. 11 items, condensed format. Original numbering preserved (gaps intentional).

## Index

| # | Issue | Category |
|---|-------|----------|
| 1 | ScreenCaptureKit permissions | Environment |
| 2 | whisper-server must be running | Environment |
| 3 | Large index.ts monolith (partially addressed) | Backend |
| 4 | TranscriptSegment.timestamp is epoch-ms | Backend |
| 5 | TranscriptSegment.duration is whisper latency | Backend |
| 6 | Finder-launched .app has minimal PATH | Environment |
| 7 | Preflight check endpoint exists | Backend |
| 8 | JSONL writes use O_APPEND for atomicity | Backend |
| 9 | Claude CLI JSON output has escape sequences | Backend |
| 10 | Claude CLI has no --max-tokens flag | Backend |
| 11 | WKWebView needs health polling before load | Frontend |

Standard categories: Environment, Database, Backend, Frontend, Security, Deployment, External APIs

---

## Environment

### 1. ScreenCaptureKit Requires Screen Recording Permission
**Symptom**: Audio capture silently fails, no transcription data
**Cause**: macOS requires explicit Screen Recording permission for ScreenCaptureKit
**Solution**: System Settings → Privacy & Security → Screen Recording → enable Meeting Copilot. Must restart app after granting.
**Pattern**: `app/MeetingCopilot/Core/`

### 2. whisper-server Must Be Running Before Server Start
**Symptom**: Transcription endpoint returns errors, no transcript output
**Cause**: Server assumes whisper-server is available at startup; no automatic retry/discovery
**Solution**: Run `./scripts/start.sh` which launches whisper-server first, or start manually before `npm run dev`
**Pattern**: `scripts/start.sh`

## Backend

### 3. server/src/index.ts Is a ~20KB Monolith (Partially Addressed)
**Symptom**: Difficult to navigate, large diffs, merge conflicts
**Cause**: MVP development concentrated logic in single entry point
**Solution**: WS connection handlers were deduplicated into `handleWsConnection()`. Further extraction to `src/routes/`, `src/websocket.ts` still recommended.
**Pattern**: `server/src/index.ts`

### 4. TranscriptSegment.timestamp Is Epoch Milliseconds, Not Relative Seconds
**Symptom**: Shared transcript produces absurd timestamps (millions of hours) in companion outputs
**Cause**: `segment.timestamp` is `Date.now()` (epoch-ms). Consumers expecting relative seconds get garbage.
**Solution**: `shared.ts` converts to session-relative seconds: `(segment.timestamp - sessionStartMs) / 1000`
**Pattern**: `server/src/session/shared.ts:85-86`

### 5. TranscriptSegment.duration Is Whisper Processing Latency, Not Audio Length
**Symptom**: CSV `end` timestamps nearly identical to `start` (sub-second segments)
**Cause**: `segment.duration` is how long whisper took to process (~0.5-2s), not the audio chunk length (10s)
**Solution**: `shared.ts` uses `CHUNK_DURATION_SECONDS = 10` instead of `segment.duration`
**Pattern**: `server/src/session/shared.ts:78`

### 6. Finder-Launched .app Has Minimal PATH
**Symptom**: `node` command not found when running from `/Applications`
**Cause**: Apps launched from Finder/Spotlight get a stripped PATH without `/opt/homebrew/bin`
**Solution**: `ProcessSupervisor.processEnvironment()` injects homebrew paths before launching child processes
**Pattern**: `app/MeetingCopilot/Sources/Core/Process/ProcessSupervisor.swift:61-70`

### 9. Claude CLI `--output-format json` Has Terminal Escape Sequences
**Symptom**: Raw JSON blob `{"type":"result",...}` appears in worker output cards
**Cause**: CLI wraps output in OSC escape sequences (`\x1b]0;...\x1b\`) that break `JSON.parse`. Also, `result` field is empty string on `error_max_turns`.
**Solution**: Strip escapes with `/\x1b\].*?(?:\x07|\x1b\\)/gs`, find JSON by `indexOf('{')`/`lastIndexOf('}')`, treat empty `result` as fallback.
**Pattern**: `server/src/claude-cli.ts:62-85`

### 10. Claude CLI Has No `--max-tokens` Flag
**Symptom**: Every intelligence eval silently fails with "unknown option '--max-tokens'"
**Cause**: `--max-tokens` is an API parameter, not a CLI flag. CLI uses `--max-budget-usd` for cost control.
**Solution**: Removed `--max-tokens` from `claudeChat()` args.
**Pattern**: `server/src/claude-cli.ts:31`

### 11. WKWebView Needs Health Polling Before Loading Localhost
**Symptom**: Blank white panel on app launch
**Cause**: WKWebView loads `/present` before the Node server finishes starting. Failed navigation shows blank page, `reload()` does nothing after failed provisional navigation.
**Solution**: `WebDashboardView.Coordinator.loadWhenReady()` polls `/health` until 200, then loads. Retries on navigation failure with `load(URLRequest(...))` not `reload()`.
**Pattern**: `app/MeetingCopilot/Sources/Features/WebPanel/WebDashboardView.swift`

---

## Lifecycle Management

- **SUPERSEDED**: When a gotcha is resolved, mark it: `## #N: [Title] ~~SUPERSEDED~~`
- **Merging**: If two gotchas describe same root cause, merge and note consolidated numbers
- **Pruning**: When gotchas exceed 30 items or 15k chars, prune SUPERSEDED entries older than 90 days
- **Numbering**: Original numbers are permanent — gaps are intentional. Never renumber.
