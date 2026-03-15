# Known Gotchas

Organized by category. 8 items, condensed format. Original numbering preserved (gaps intentional).

## Index

| # | Issue | Category |
|---|-------|----------|
| 1 | ScreenCaptureKit permissions | Environment |
| 2 | whisper-server must be running | Environment |
| 3 | Large index.ts monolith (partially addressed — WS handlers deduplicated) | Backend |
| 4 | TranscriptSegment.timestamp is epoch-ms | Backend |
| 5 | TranscriptSegment.duration is whisper latency | Backend |
| 6 | Finder-launched .app has minimal PATH | Environment |
| 7 | Preflight check endpoint exists | Backend |
| 8 | JSONL writes use O_APPEND for atomicity | Backend |

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

---

## Lifecycle Management

- **SUPERSEDED**: When a gotcha is resolved, mark it: `## #N: [Title] ~~SUPERSEDED~~`
- **Merging**: If two gotchas describe same root cause, merge and note consolidated numbers
- **Pruning**: When gotchas exceed 30 items or 15k chars, prune SUPERSEDED entries older than 90 days
- **Numbering**: Original numbers are permanent — gaps are intentional. Never renumber.
