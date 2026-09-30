# Meeting Copilot

A macOS menu-bar copilot that listens to your meetings and works alongside you:
a live transcript, a coach, a running read on whether the meeting is on track,
and research, summaries, analysis and mockups that it suggests and runs **only
after you approve them**.

## How it works

Two processes on your Mac:

- **SwiftUI menu-bar app** (`app/MeetingCopilot/`): captures meeting audio
  (a Core Audio process tap, with ScreenCaptureKit as the fallback) and your
  microphone, shows the dashboard in a WKWebView, and supervises the server.
- **Node.js server** (`server/`, TypeScript): transcription, the suggestion
  loop, the workers, per-meeting storage, and the web dashboard at `/present`.

They talk over a WebSocket on `localhost:17890`. A browser can join as a
second client.

### What you get in a meeting

- **Live transcript**: fully local by default (Parakeet, whisper.cpp fallback).
  Cloud transcription (Grok Voice Transcribe, or Deepgram) is opt-in and only
  runs when `COPILOT_ALLOW_CLOUD_AUDIO=true`.
- **Suggestions with approval**: a triage model watches the conversation and
  proposes actions. Nothing runs until you approve it.
- **Workers**: Research, Summary, Analysis, Mockup, CodeGen.
- **Meeting pulse**: every 5 minutes, a read on whether the meeting is on
  track, drifting or stuck, plus what to settle before it ends.
- **Coach**: private goals for the meeting, and on-demand checks (how am I
  doing, what did I miss).
- **Meeting chat** (⌘J): ask questions about the meeting with the full
  transcript, agenda and cards as context.
- **Staged preps**: a Claude Code skill (`skills/meeting-copilot-prep/`) can
  fill in the start form ahead of time: agenda, attendees, goals and a
  research brief.

## Privacy

- Raw audio is never written to disk.
- Each meeting gets its own SQLite database under
  `~/.meeting-copilot/sessions/<id>/`.
- Every session requires you to confirm that participants have been informed
  before recording starts, and a REC indicator stays visible while it runs.
- Audio stays on your Mac unless you explicitly enable cloud transcription.

Recording laws differ by place. Make sure you have consent from everyone you
record.

## Requirements

- macOS 14+
- Node.js 20+
- Swift 5.9+ / Xcode 15+
- [Claude Code](https://claude.com/claude-code) CLI, logged in (the suggestion,
  worker and pulse paths run on it)
- Optional API keys: `OPENAI_API_KEY` (live triage and chat), `XAI_API_KEY`
  or `DEEPGRAM_API_KEY` (cloud transcription). Set
  `COPILOT_LIVE_LLM_MODE=cli` to run on the Claude Code CLI alone, or
  `COPILOT_DISABLE_PAID_API=1` for zero metered API spend.

## Quick start

```bash
./scripts/setup.sh                     # install deps, download the whisper model
./scripts/start.sh                     # start the server + whisper-server
cd app/MeetingCopilot && swift build   # build the menu-bar app
./scripts/build-app.sh                 # package a signed .app into dist/
```

For development:

```bash
cd server && npm run dev               # server with hot reload
cd server && npm test                  # unit tests
./scripts/replay.sh                    # replay a text fixture through the pipeline
```

## Documentation

- [`docs/setup.md`](docs/setup.md): environment variables, building, deployment
- [`docs/api.md`](docs/api.md): WebSocket and REST API
- [`CHANGELOG.md`](CHANGELOG.md): version history

## License

[Business Source License 1.1](LICENSE), © 2026 CX Ventures LLC. The source is
available and you may use it personally or inside your own organisation.
Selling it, hosting it for others or bundling it into a commercial product
needs a commercial licence. Each version becomes Apache-2.0 on 2030-09-30 or
four years after its release, whichever comes first.
Versions published before 2026-09-30 were released under the MIT licence.
