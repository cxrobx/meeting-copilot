# Meeting Copilot E2E Reliability, Latency, and Model Upgrade Plan

- **Status:** Core release implemented. The five-minute private local VAD/ASR
  gate and an eight-minute consented dual-track coach/agenda replay passed on
  2026-07-28. Cloud streaming experiments and long-duration soak gates remain
  pending.
- **Created:** 2026-07-28
- **Scope:** Swift app, Node server, local/cloud transcription, live intelligence, workers, observability, packaging
- **Primary outcome:** Make Meeting Copilot consistently responsive during real meetings without weakening privacy, session isolation, or approval controls.

## 1. Executive Summary

Meeting Copilot's local Parakeet inference is already fast. The largest current delays come from process-lifecycle bugs, fixed audio chunking, and CLI-based LLM orchestration. This plan fixes those issues in dependency order, establishes reproducible end-to-end measurements, and upgrades the current Claude model routing:

- Live suggestions and general workers: Claude Sonnet 5.
- Post-meeting self-review: Claude Opus 5 (`claude-opus-5`) in place of Claude Opus 4.8.
- Triage: benchmark direct GPT-5.6 Luna and Gemini 3.5 Flash-Lite, then select using Meeting Copilot's own replay eval.
- Local transcription: retain Parakeet-TDT 0.6B v3 as the default.
- Optional cloud transcription: Deepgram Nova-3 streaming and GPT-Realtime-Whisper behind explicit consent and feature flags.

The work is split into small release gates so model changes do not hide infrastructure regressions. Every phase must preserve the architecture invariants below.

## 2. Non-Negotiable Invariants

1. **No raw audio storage.** Audio may exist only in memory while being captured, transported, decoded, or transcribed. Do not write WAV chunks to temporary files.
2. **Session isolation.** Each meeting keeps its own SQLite database and JSONL event log. Global logs must not contain transcript or prompt content.
3. **Approval before action.** Suggestions may be generated automatically, but workers execute only after explicit approval.
4. **16 kHz mono PCM.** Both microphone and meeting audio must remain 16 kHz, mono PCM across capture and provider boundaries.
5. **Local-first default.** Parakeet remains the default transcription provider. Sending audio to a cloud provider requires explicit configuration and consent.
6. **Bounded resource use.** Every queue, log, retry loop, child process, task, and network request has a size, concurrency, retry, and timeout limit.

## 3. Definition of Done

### Runtime and resource targets

| Metric | Acceptance gate |
|---|---:|
| App CPU after 10 minutes idle | p95 below 1%, no sustained core spin |
| App CPU after 10 forced child-process restarts | Returns below 1% within 10 seconds |
| Idle memory growth over 8 hours | Less than 25 MB |
| Child processes after stop/restart soak | Exactly one server and one selected ASR sidecar |
| WebSocket reconnect soak | One receive loop and one scheduled reconnect maximum |
| Unbounded queues/tasks/event monitors | Zero |

### Live latency targets

All transcript measurements begin at the end timestamp of the audio represented in the result, not when a timer fires or a request begins.

| Stage | p50 | p95 |
|---|---:|---:|
| Utterance end to first transcript update | ≤ 1.0 s | ≤ 2.0 s |
| Utterance end to finalized transcript segment | ≤ 1.5 s | ≤ 3.0 s |
| Final segment to triage result | ≤ 1.5 s | ≤ 3.0 s |
| Actionable segment to first usable suggestion partial | ≤ 3.0 s | ≤ 6.0 s |
| Actionable segment to completed suggestion | ≤ 8.0 s | ≤ 15.0 s |

Continuous speech that hits the maximum utterance cap is measured separately from natural speech-boundary emissions.

### Quality and correctness targets

- No statistically meaningful increase in word error rate versus the current Parakeet baseline.
- No regression in proper-name accuracy on the project vocabulary fixture.
- Triage recall and precision meet or exceed the current replay baseline.
- Suggestion schema-valid rate is at least 99%.
- Worker execution without approval remains impossible in unit and integration tests.
- Transcription error rate remains below 1% during a two-hour soak.
- Transcript deduplication does not drop repeated words that were actually spoken.

### Privacy and logging targets

- No audio files appear in the data directory, system temporary directory, or sidecar working directory during a replay.
- Global logs contain no transcript text, meeting prompts, attendee lists, API keys, or child-process argument strings.
- Per-session retention deletes all session-owned artifacts according to the configured policy.
- Logs rotate and remain under a documented maximum size.

## 4. Delivery Strategy

Use one implementation slice per pull request where practical. Do not combine latency/model changes with the process-supervision fix; the baseline must identify which change produced each result.

1. Measurement contract and baseline
2. P0 process supervision and raw-audio privacy
3. Logging, WebSocket, and Swift lifecycle hardening
4. VAD-driven audio emission
5. Transcription provider improvements
6. Live intelligence orchestration
7. Model router and model upgrades, including Opus 5
8. End-to-end soak, staged rollout, and documentation

## 5. Phase 0 — Measurement Contract and Reproducible Baseline

### Implementation

- Give each audio chunk a correlation ID that survives capture, WebSocket transport, transcription, stitching, and broadcast.
- Record monotonic timestamps for:
  - capture start and end;
  - Swift send start;
  - server receipt;
  - transcription queue entry and exit;
  - provider start and finish;
  - first partial and final ASR result;
  - stitcher first update and finalization;
  - intelligence scheduled, started, first token, parsed, and completed;
  - suggestion first usable partial and final completion.
- Keep wall-clock timestamps only for user-facing event chronology; use monotonic clocks for durations.
- Reset `/debug` session metrics at session start and preserve a completed-session snapshot at session stop.
- Add p50, p95, maximum, error count, cancellation count, queue wait, and provider breakdown. Averages alone are insufficient.
- Split ASR metrics by source (`mic` and `meeting`) and emission mode (`timer`, `vad`, `streaming`).
- Add LLM route metadata without logging prompts:
  - provider;
  - model;
  - surface (`api`, `cli`);
  - fallback tier;
  - time to first token;
  - total latency;
  - token usage and estimated spend.
- Extend the audio replay tool to export a machine-readable benchmark report.
- Generate deterministic synthetic audio at test time. Keep any explicitly consented real-world replay recordings outside Meeting Copilot's storage and repository.

### Required tests

- Timestamp arithmetic across overlap, continuation, and VAD chunks.
- Metrics reset between two consecutive sessions.
- Percentile calculation with empty, one-sample, and multi-sample inputs.
- Correlation IDs remain session-scoped and are never reused.

### Exit gate

- A baseline report can be generated twice with comparable results.
- Every latency target in Section 3 has an explicit metric source.
- Current installed behavior is captured before changing process, VAD, or model routing.

## 6. Phase 1 — P0 Process Supervision and Raw-Audio Privacy

### 6.1 Child-process output lifecycle

Replace the three duplicated `Pipe.readabilityHandler` implementations with one managed child-process abstraction.

The abstraction must:

- retain the `Process`, `Pipe`, and monitor task together;
- stop the readability handler when `availableData` is empty;
- clear the handler before intentional termination and after unexpected exit;
- close the read handle exactly once;
- use a generation ID so an old process cannot update state after a replacement starts;
- prevent overlapping restart attempts;
- cancel pending restart backoff during intentional shutdown;
- make launch and cleanup idempotent;
- capture bounded line-oriented output without blocking the main actor.

### 6.2 Remove temporary raw-audio files

The Parakeet sidecar currently writes each WAV request to `NamedTemporaryFile`. Replace this with an in-memory path:

- parse WAV bytes from `io.BytesIO`;
- validate 16 kHz, mono, 16-bit PCM before inference;
- convert frames to the input type expected by `parakeet-mlx`;
- compute features and transcribe without touching the filesystem;
- reject malformed or oversized payloads with a bounded error response.

If the installed `parakeet-mlx` version cannot accept in-memory samples at the required layer, upgrade or add the smallest audited adapter necessary. Do not preserve the temp-file fallback.

### Required tests

- Start, stop, and restart each child 10 times; CPU returns to idle after every cycle.
- Force server and ASR crashes independently; only the failed child restarts.
- Simulate immediate EOF and partial output lines.
- Verify no duplicate process after concurrent health-check and exit events.
- Run a filesystem watcher during audio replay and assert no WAV/audio files are created.
- Confirm process cleanup on app quit and failed launch.

### Exit gate

- Idle CPU and restart targets in Section 3 pass.
- A five-minute replay creates no raw-audio file.
- The packaged app behaves the same as the debug build.

## 7. Phase 2 — Logging, WebSocket, and Swift Lifecycle Hardening

### 7.1 Safe logging

- Introduce a single asynchronous, buffered logger for the Node process.
- Rotate `server.log` and `app.log` by size with a bounded number of retained files.
- Log structured error codes and sanitized stderr summaries.
- Never serialize `execFile`/`spawn` argument lists because prompts are arguments today.
- Truncate bounded diagnostic fields and strip newlines from child-process errors.
- Keep transcript text only in the session store and events explicitly designed to contain it.
- Replace hot-path `appendFileSync` calls with the buffered logger.
- Add a log-scrubbing test with canary transcript, attendee, prompt, and API-key strings.

### 7.2 WebSocket lifecycle

- Replace the nested untracked receive task with one owned connection task.
- Track a connection generation; messages and failures from stale generations are ignored.
- Own and cancel the reconnect timer/task.
- Invalidate the old `URLSession` before establishing a new connection.
- Guarantee at most one receive operation and one reconnect attempt.
- Add ping/pong health semantics if URLSession receive timeout alone does not distinguish quiet from dead connections.

### 7.3 Swift lifecycle and Swift 6 readiness

- Replace async-context `NSLock.lock/unlock` calls with scoped locking or an isolated state owner.
- Resolve captured-`self` concurrency warnings in process monitor tasks.
- Remove unnecessary actor-local `await` expressions.
- Retain and remove the WebDashboard local key event monitor during dismantle.
- Run with Swift 6 concurrency checking in CI before making it the package default.

### Exit gate

- Eight-hour idle/reconnect soak meets CPU and memory targets.
- Canary secrets and transcript text do not appear in global logs.
- Swift build is free of the identified concurrency warnings.

## 8. Phase 3 — VAD-Driven Audio Emission

### Implementation

- Replace `preRoll.removeFirst()` with a fixed-capacity circular buffer.
- Avoid per-sample allocations in the VAD and utterance accumulation loop.
- Preserve the current defaults as the first experiment:
  - 30 ms Silero windows;
  - 100 ms pre-roll;
  - 300 ms trailing silence;
  - 6 second maximum utterance;
  - 500 ms continuation overlap.
- Ensure timestamps describe the actual first and last audio samples.
- Flush an in-progress utterance on session stop without blocking the main actor.
- Keep the fixed timer emitter as a rollback path.
- Add VAD telemetry for false starts, forced maximum-utterance emits, average utterance length, and silence-to-emit latency.

### Rollout

1. Shadow mode: run VAD decisions without changing emitted chunks.
2. Developer opt-in using `MC_USE_VAD_EMIT=1`.
3. Default-on after replay and three real consenting meetings pass.
4. Retain `MC_USE_VAD_EMIT=0` for immediate rollback for one release cycle.

### Required tests

- Short utterance, long utterance, quick pause, background noise, alternating sources, and session-stop flush.
- Continuation overlap dedup with repeated legitimate words.
- No onset clipping and no duplicated onset window.
- Sustained two-source ingestion does not grow buffers without bound.

### Exit gate

- Transcript latency targets pass with no quality regression.
- VAD CPU cost does not erase the process-supervision gains.

## 9. Phase 4 — Transcription Provider Improvements

### 9.1 Local Parakeet default

- Keep `mlx-community/parakeet-tdt-0.6b-v3` as the production default.
- Make sidecar concurrency explicit. Start with one inference at a time unless an MLX concurrency test proves two concurrent calls are safe and faster.
- Expose provider queue wait separately from inference time.
- Keep startup prewarming and add a readiness state distinct from simple HTTP reachability.
- Stop representing the generic ASR health field as `whisperAvailable`; return provider-neutral status and model metadata.

### 9.2 Context and proper names

The Parakeet shim accepts a `prompt` field but does not use it. Make provider capabilities explicit:

- `supportsPrompt`;
- `supportsKeyterms`;
- `supportsPartials`;
- `supportsStreaming`;
- `supportsDiarization`.

Do not silently claim context adaptation. For providers that support keyterms, map project names, attendee names, and meeting vocabulary into their native mechanism. For Parakeet, evaluate a bounded transcript post-correction pass for known proper nouns; ship it only if the replay fixture shows improved accuracy without changing unrelated words.

### 9.3 Optional cloud providers

- Upgrade the existing Deepgram adapter from Nova-2 to Nova-3.
- Add a streaming WebSocket implementation; changing the REST model alone will not remove chunk-boundary delay.
- Map session vocabulary to Nova-3 keyterms.
- Add GPT-Realtime-Whisper as a second streaming experiment.
- Require an explicit cloud-audio setting and session consent before transmitting audio.
- Keep each cloud provider behind its own feature flag and total-session spend meter.

### Exit gate

- Local Parakeet meets latency and quality gates.
- Cloud adapters fail closed to local transcription without losing audio already buffered in memory.
- Provider capability reporting matches actual behavior.

## 10. Phase 5 — Live Intelligence Orchestration

### 10.1 Event-driven, latest-wins evaluation

- Schedule triage after a new finalized utterance or stable partial crosses a word threshold.
- Retain the periodic timer only as a safety net.
- Replace `MAX_EVAL_IN_FLIGHT = 2` plus a five-item queue with:
  - one active triage;
  - one dirty/latest marker;
  - optional cancellation when the current request has not started returning output;
  - one immediate rerun using the newest transcript window.
- Never evaluate stale queued snapshots.
- Expand deterministic immediate triggers beyond punctuation because ASR punctuation is imperfect.
- Keep overlap/dedup protection, but calculate it against the exact evaluated window.

### 10.2 Direct API hot path

- Use direct provider APIs for live triage and suggestions when configured.
- Use structured outputs for triage and final suggestions.
- Stream suggestion tokens and preserve the existing early `paramsReady` behavior.
- Apply one end-to-end deadline to the route, not a full timeout per fallback tier.
- Circuit-break failing providers and skip known-bad tiers during cooldown.
- CLI fallback remains available but does not execute a three-CLI serial cascade.
- Make fallback/degraded state visible in the UI.

### 10.3 Spend and failure controls

- Per-request token caps.
- Per-session request, token, and dollar ceilings.
- Provider-specific concurrency limits.
- Hard cancellation at session stop.
- No retry on schema or authentication errors; at most one bounded retry on transient network errors.
- Emit sanitized reason codes for timeout, rate limit, auth, schema, cancellation, and provider outage.

### Exit gate

- Triage and suggestion latency targets pass on the replay suite.
- Stale work cannot accumulate during a provider slowdown.
- Killing the primary provider produces one bounded fallback without UI lockup.

## 11. Phase 6 — Model Router and Model Upgrades

### 11.1 Centralized model configuration

Remove hard-coded model IDs from intelligence, API adapters, agenda tracking, CLI helpers, and workers. Add one typed model-routing configuration with environment overrides:

| Workload | Planned default | Planned surface | Effort |
|---|---|---|---|
| Live triage | Winner of GPT-5.6 Luna vs Gemini 3.5 Flash-Lite eval | Direct API | None/lowest supported |
| Live suggestion | `claude-sonnet-5` | Direct API, CLI fallback | Low |
| Agenda/coach/fact-check | `claude-sonnet-5` or triage winner based on eval | Direct API, CLI fallback | Low |
| Research/analysis/summary workers | `claude-sonnet-5` | CLI by default; API optional | Medium |
| Post-meeting self-review | `claude-opus-5` | CLI by default; API optional | Medium initially |

Suggested configuration keys:

- `COPILOT_TRIAGE_PROVIDER`
- `COPILOT_TRIAGE_MODEL`
- `COPILOT_SUGGEST_MODEL`
- `COPILOT_WORKER_MODEL`
- `COPILOT_REVIEW_MODEL`
- `COPILOT_LIVE_LLM_MODE=api|cli`
- `COPILOT_WORKER_LLM_MODE=cli|api`

Do not use evergreen aliases where a pinned model ID is available unless the provider's documented ID is itself pinned.

### 11.2 Opus 5 migration

Change the self-review default:

```text
claude-opus-4-8 → claude-opus-5
```

Migration requirements:

- Preserve `COPILOT_REVIEW_MODEL=claude-opus-4-8` as the immediate rollback.
- Re-run the self-review scorecard fixture because Opus 5 is more verbose and performs more self-verification by default.
- Add explicit concision and scope language to the review prompt if the output expands beyond the current UI contract.
- Opus 5 has thinking enabled by default. For direct API execution, begin with `effort=medium`; compare `low`, `medium`, and `high` on review quality, latency, and tokens.
- Do not disable thinking at `xhigh` or `max`; Anthropic documents that combination as invalid.
- Record time to first token, total review time, token usage, and schema/section compliance.
- Verify the installed Claude CLI accepts `claude-opus-5` before changing the packaged default.

### 11.3 Model evaluation

Run every candidate on the same frozen inputs. Score:

- triage precision/recall and trigger-quote fidelity;
- suggestion usefulness, correct worker type, parameter completeness, and hallucination rate;
- review specificity, evidence grounding, question-handling coverage, and concision;
- p50/p95 latency;
- time to first usable partial;
- token usage and estimated cost;
- timeout and schema failure rate.

Promote a model only when it passes both quality and latency gates. A newer flagship is not automatically suitable for the live path.

### Exit gate

- Opus 5 is the default self-review model and has a verified rollback.
- Sonnet 5 is the default suggestion/worker model.
- The triage winner is selected from reproducible Meeting Copilot eval results.
- No runtime model ID remains duplicated outside the central router and configuration tests.

## 12. Phase 7 — End-to-End Release Qualification

### Automated checks

```bash
cd server && npm ci
cd server && npm test
cd server && npm run build
cd app/MeetingCopilot && swift test
cd app/MeetingCopilot && swift build
./scripts/build-app.sh
```

Add CI jobs for:

- Node unit/integration tests;
- Swift build/tests with concurrency warnings treated as errors for touched code;
- replay benchmark with regression thresholds;
- privacy/log canary scan;
- process crash/restart test;
- WebSocket reconnect test;
- packaged-app smoke test.

### Manual/soak checks

- Ten-minute idle test.
- Two-hour two-source meeting replay.
- Real meeting with natural pauses.
- Real meeting with a continuous speaker.
- Network loss and recovery during cloud transcription.
- LLM primary-provider timeout and fallback.
- Server and ASR crash during capture.
- App quit during active transcription.
- Session stop with pending transcript and worker.
- Verify approval gating for every worker type.
- Verify retention cleanup and absence of global transcript leakage.

### Staged rollout

1. Internal debug build with metrics enabled.
2. Packaged build with VAD opt-in and direct LLM path opt-in.
3. VAD default-on after acceptance data.
4. Direct live API path default-on only after spend ceilings and fallback tests.
5. Cloud transcription remains opt-in.
6. Remove one-release-cycle rollback code only after production telemetry is stable.

## 13. Rollback Matrix

| Change | Rollback |
|---|---|
| VAD emitter | `MC_USE_VAD_EMIT=0` |
| Parakeet regression | `TRANSCRIPTION_PROVIDER=whisper` |
| Cloud STT regression | Return to local `parakeet` |
| Direct live LLM regression | `COPILOT_LIVE_LLM_MODE=cli` |
| Sonnet 5 regression | Set suggestion/worker model to `claude-sonnet-4-6` |
| Opus 5 review regression | `COPILOT_REVIEW_MODEL=claude-opus-4-8` |
| Triage candidate regression | Switch central triage provider/model to the runner-up |

Every rollback must be tested before release; an environment variable that has never been exercised is not a rollback plan.

## 14. Recommended Pull Request Sequence

### PR 1 — Metrics and benchmark contract

- Correlation IDs, monotonic timestamps, percentile metrics, per-session reset.
- Benchmark report output and frozen eval inputs.

### PR 2 — Process supervision and in-memory Parakeet

- Managed child lifecycle and EOF cleanup.
- No temporary WAV files.
- Crash/restart and no-audio-file tests.

### PR 3 — Logging and connection lifecycle

- Buffered rotating logs and error sanitization.
- Structured WebSocket task/reconnect ownership.
- Event-monitor cleanup and Swift concurrency warnings.

### PR 4 — VAD productionization

- Circular pre-roll, allocation cleanup, shadow telemetry, rollout flag.
- VAD and dedup fixtures.

### PR 5 — Provider capabilities and streaming STT

- Provider-neutral health.
- Explicit prompt/keyterm/streaming capabilities.
- Deepgram Nova-3 streaming, followed by GPT-Realtime-Whisper experiment.

### PR 6 — Latest-wins intelligence scheduler

- Event-driven single-flight triage.
- Total-deadline fallback and circuit breakers.
- UI degradation telemetry.

### PR 7 — Central model router and current models

- Sonnet 5 suggestions/workers.
- Opus 5 self-review.
- Direct API routes, effort controls, spend ceilings, CLI fallback.
- Candidate triage evaluation and selection.

### PR 8 — Release qualification

- CI regression gates, packaged smoke tests, two-hour soak.
- Update architecture, API, setup, changelog, and operator troubleshooting docs.

## 15. Final Completion Checklist

- [ ] Installed app idles below the CPU threshold.
- [ ] Process restarts do not leak handlers, tasks, or children.
- [ ] Audio never touches disk.
- [ ] Global logs contain no meeting content and remain bounded.
- [ ] VAD is default-on and meets transcript latency/quality gates.
- [ ] Parakeet remains a healthy local-first default.
- [ ] Optional streaming providers require explicit consent.
- [ ] Intelligence is event-driven, single-flight, cancellable, and bounded.
- [ ] Direct API spend is capped and observable.
- [ ] Sonnet 5 is the suggestion/worker default.
- [ ] Opus 5 is the self-review default with a tested 4.8 rollback.
- [ ] Node and Swift builds/tests pass.
- [ ] Packaged-app and two-hour soak tests pass.
- [ ] Architecture, API, setup, changelog, and troubleshooting documentation are current.

## 16. Vendor References

- [Anthropic: Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)
- [Anthropic: Choosing the right model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model)
- [OpenAI: GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI: GPT-Realtime-Whisper](https://developers.openai.com/api/docs/models/gpt-realtime-whisper)
- [Google: Gemini models](https://ai.google.dev/gemini-api/docs/models)
- [Deepgram: Models and languages](https://developers.deepgram.com/docs/models-languages-overview)
