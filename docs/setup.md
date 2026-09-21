# Environment & Setup

## Prerequisites

- macOS 14+ (ScreenCaptureKit requirement)
- Node.js 20+
- Swift 5.9+ / Xcode 15+
- whisper.cpp with server mode

## Quick Start

```bash
./scripts/setup.sh        # Install npm deps, download whisper model
./scripts/start.sh        # Launch whisper-server + Node.js server
```

## Environment Variables

Create `server/.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...   # Optional direct Haiku fallback + Sonnet 5 suggestions
OPENAI_API_KEY=sk-...          # Preferred live path: Luna agenda, Terra recovery coach
TRANSCRIPTION_PROVIDER=parakeet # Local default; whisper and deepgram are supported
DEEPGRAM_API_KEY=...           # Optional — Nova-3 cloud transcription
COPILOT_ALLOW_CLOUD_AUDIO=false # Must be exactly true before any audio leaves the Mac
COPILOT_PORT=17890             # Optional — default 17890
SUGGESTION_TTL_MS=60000        # Optional — default 60000; ms before an unactioned suggestion auto-expires
COPILOT_LIVE_LLM_MODE=auto     # auto|api|cli
COPILOT_TRIAGE_MODEL=gpt-5.6-luna
COPILOT_AGENDA_MODEL=gpt-5.6-luna
COPILOT_AGENDA_RECONCILE_MODEL=gpt-5.6-terra
COPILOT_COACH_MODEL=gpt-5.6-terra
COPILOT_SUGGEST_MODEL=claude-sonnet-5
COPILOT_WORKER_MODEL=claude-sonnet-5
COPILOT_REVIEW_MODEL=claude-opus-5
COPILOT_MAX_LLM_REQUESTS_PER_SESSION=500
COPILOT_MAX_LLM_TOKENS_PER_SESSION=300000
COPILOT_MAX_LLM_DOLLARS_PER_SESSION=10
```

The recovery coach is enabled by default for new installs. It evaluates a
bounded recent-turn window and drops advice that misses the live freshness
deadline. Fact-checking remains off by default because it can invoke web
verification.

## Building

### Server

```bash
cd server && npm ci            # Reproducible dependency install
cd server && npm run dev       # Dev mode (tsx hot reload)
cd server && npm run build     # Compile TypeScript → dist/
cd server && npm start         # Run compiled
```

### Swift App

```bash
cd app/MeetingCopilot && swift test     # Unit tests
cd app/MeetingCopilot && swift build    # Debug build
cd app/MeetingCopilot && swift run      # Run debug
./scripts/build-app.sh                   # Signed release .app → dist/ (no install)
./scripts/verify-app.sh                  # Verify the packaged app
./scripts/ship.sh                        # Test, package, confirm, install, relaunch
```

`VERSION` is the single source for `CFBundleShortVersionString` and
`CFBundleVersion`. `build-app.sh` never modifies `/Applications`; use
`ship.sh` when the package is ready. Shipping refuses to continue during an
active meeting, requires a Developer ID signature so macOS audio permissions
survive the update, verifies the staged and installed bundles, and restores the
previous app automatically if the new build does not become healthy.

### Spike

```bash
cd spike/AudioSpike && swift build
cd spike/AudioSpike && swift run
```

## macOS Permissions

The app requires these system permissions:
- **Screen Recording**: System Settings → Privacy & Security → Screen Recording (for ScreenCaptureKit audio capture)
- **Microphone**: Prompted automatically on first use

Must restart the app after granting Screen Recording permission.

## Testing with Fixtures

```bash
./scripts/replay.sh           # Replay test fixtures against running server
```

## Testing with Private Real Audio

Keep real recordings outside this repository. The local evaluator reads a
Notes4Chris session in place, uses the production Parakeet, deduplication, and
stitching classes, and checks that no audio file appears under
`~/.meeting-copilot`. It deliberately does not start the intelligence pipeline,
so no transcript is sent to a cloud LLM.

```bash
cd server
npm run eval:audio -- /path/to/recordings/<session> --minutes 5
```

Add `--show-transcript` for local diagnostic output. Prior Notes4Chris
`system_transcript.csv` and `mic_transcript.csv` files are detected
automatically when the recording is under a sibling `recordings/` directory.
They are generated references, not hand-labelled ground truth, so the report
uses reference coverage rather than claiming a true word-error rate.

The production VAD path has a separate opt-in Swift integration test. It reads
the same recording without copying it or writing emitted chunks:

```bash
cd app/MeetingCopilot
REAL_AUDIO_RECORDING_DIR=/path/to/recordings/<session> \
REAL_AUDIO_MINUTES=5 \
swift test --filter RealAudioVADTests
```

Full audio-to-coach/agenda replay can disclose transcript text to the configured
LLM provider. Run that separately only with explicit consent for the selected
meeting.

With consent, keep the replay bounded to the shortest slice that exercises the
target agenda and coach behavior:

```bash
cd server
npx tsx src/replay-audio.ts /path/to/recordings/<session> \
  --minutes 8 \
  --speed 2 \
  --agenda 'First topic; Second topic; Third topic'
```

The replay reports unique finalized action cards, final agenda state, coach
guidance, intelligence errors, and live ASR/agenda/coach latency. The
2026-07-28 real-meeting gate processed 318 dual-track chunks with zero errors,
ASR p50/p95 of 183/253 ms, 3/3 agenda coverage, one relevant coach cue, and no
stale agenda or coach results.

## Production Deployment

The app bundle at `build/Meeting Copilot.app` includes the bundled server. The production communication channel uses Unix socket at `~/.meeting-copilot/copilot.sock` instead of TCP.
