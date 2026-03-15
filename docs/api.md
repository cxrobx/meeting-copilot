# API Reference

## WebSocket Protocol

**Endpoint**: `ws://localhost:17890`

### Client → Server Messages

| Type | Purpose | Payload |
|------|---------|---------|
| `audio_chunk` | Stream audio data | PCM audio buffer (16kHz mono) |
| `session_start` | Begin new meeting session | `{ consent: boolean }` |
| `session_end` | End current session | `{}` |
| `approval` | Approve/reject suggestion | `{ suggestionId, approved: boolean }` |

### Server → Client Messages

| Type | Purpose | Payload |
|------|---------|---------|
| `transcript` | New transcription segment | `{ text, timestamp, speaker? }` |
| `suggestion` | AI-generated suggestion | `{ id, type, title, description }` |
| `worker_result` | Completed worker output | `{ suggestionId, type, result }` |
| `status` | Server status update | `{ state, message }` |

## REST Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/debug` | Server metrics and diagnostics |
| GET | `/health` | Health check |

## Session Storage

Each session stores data at `~/.meeting-copilot/sessions/<uuid>/`:

| File | Purpose |
|------|---------|
| `session.db` | SQLite — transcripts, suggestions, approvals |
| `events.jsonl` | Append-only event log |
