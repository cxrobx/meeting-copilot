# Meeting Copilot Quality Plan

- **Status:** Planned. Nothing below is built yet.
- **Created:** 2026-09-25, from the quality review after the meeting chat shipped (`b42e0b8`).
- **Scope:** the `/present` dashboard's code shape, a ship-gating end-to-end test, and how much the live meeting asks of your attention. Optional: the server's entry point.
- **Primary outcome:** move the review's weakest scores (architecture 5.5, testing 7) without changing what the app does, then use real usage data to decide what the live dashboard shows.

## 1. Where this starts

The review scored the app about 7/10: strong features, reliability work and docs, held back by code shape. The facts behind the three workstreams:

| Finding | Evidence |
|---|---|
| The dashboard is one TypeScript string | `server/src/present/index.ts` is 10,065 lines. `PRESENT_HTML` holds ~2,880 lines of CSS (805–3687), a 36-line first-paint script (769–804) and ~6,240 lines of JS (3824–10063) in one IIFE |
| That shape causes bugs | Gotcha #22 (escapes decode twice), #24 (a second `var` silently replaces the first), #27 (a popover that hit-tests but never paints). The current guards are "does it parse" and text-matching tests |
| No automated end-to-end check gates a ship | `ship.sh` runs `npm test` + `swift test`, packages, installs. The 2026-09-25 chat test (second server, seeded meeting, Playwright) was done by hand and caught a real bug (Stop marked a half answer done) |
| The live meeting has many surfaces | Suggestion cards, coach cards, pulse, fact-check flags, agenda, evidence tabs, Quick Actions, highlight-to-ask, the chat, Stage, the menu bar popover. The event log records suggestions shown, approved, dismissed and expired, and coach cards and pulses shown, but none of the dashboard's own interactions |

## 2. Invariants (unchanged, and machine-checked where they apply)

1. **No raw audio storage.** Nothing here touches capture.
2. **Session isolation.** Telemetry goes into the session's own `events.jsonl`, never a global log.
3. **Approval before action.** No surface gains an automatic action.
4. **16 kHz mono PCM.** Untouched.
5. **No silent metered spend.** Tests and the ship gate spend nothing: they run with `COPILOT_DISABLE_PAID_API=1` and a fake chat answerer.
6. **No behaviour change from refactoring.** Workstream A's first phase must serve the browser the same bytes it gets today (§4, A1 exit gate).
7. **Telemetry is content-free.** `ui.*` events carry ids, kinds and timings, never transcript, card or question text.

## 3. Order

```
C1 smoke gate ─┬─> A1 extract dashboard ──> A2 static checks ──> A3 split as touched (ongoing)
               │                                                       └─> D server entry (optional)
B1 instrument ─┴─> B2 report ──> [10 instrumented meetings] ──> B3 decide what the meeting shows
```

- **C1 goes first.** Behavioural validation before a 9,000-line move: the gate that proves the refactor changed nothing has to exist before the refactor.
- **B is independent.** Start instrumenting early, because its decision waits on real meetings, not on code.
- **Size:** C1, A1 and B1+B2 are about one session each. A2 is half a session. A3 has no end: it happens as features are touched.

## 4. Workstream A: Move the dashboard out of the TypeScript string

### A1. Mechanical extraction, byte-identical

**Approach**
- **Generate the files from the running string instead of copying the source.** Import `PRESENT_HTML`, slice out the CSS and the main script, and write `server/web/present.css` and `server/web/present.js`. The TypeScript decoder has already turned `'\\n'` into `'\n'`, exactly as the browser receives it, so nothing is unescaped by hand.
  - *Could go wrong:* a slice boundary is off by a line. *Handled by:* the exit gate below compares bytes.
- **Keep the first-paint script inline in `<head>`.** It must run before paint, or light-theme users see a dark flash. The shell stays a small string in TypeScript, so `applyVaultLook`, which needs `<html …>` and `</head>`, is unchanged.
  - *Could go wrong:* moving it would reintroduce the flash. *Handled by:* it is not moved, and a test asserts it is still inline.
- **Serve `server/web/` at `/present/assets/`,** alongside `/vendor`, with URLs versioned by a content hash taken at startup (`present.js?v=3f9a…`).
  - *Could go wrong:* WKWebView caches aggressively, so a shipped fix would not show. *Handled by:* the hash changes whenever the file does, and `/present` itself stays `no-store`.
- **Update the bundle and its check.** `build-app.sh` copies `server/web/` next to `vendor/`, and `verify-app.sh` refuses a bundle without it.
  - *Could go wrong:* a missing asset leaves a blank dashboard in the installed app only. *Handled by:* C1 runs against the packaged bundle, so it fails before install.
- **Repoint three tests** (`present-script`, `window-drag`, `vault-look`) at the files instead of `PRESENT_HTML`.

**Exit gate**
- `/present` + `present.css` + `present.js` reassemble to the pre-extraction `PRESENT_HTML` byte for byte, apart from the two new `<link>`/`<script src>` tags. A test does this against a golden copy taken before the move, then the golden copy is deleted.
- C1 passes against the packaged bundle.
- `present/index.ts` falls from 10,065 lines to under 1,000 (routes plus the shell).

### A2. Static checks replace the text-matching guards

**Approach**
- **Add ESLint, config-only, for `server/web/*.js`,** with `no-redeclare`, `no-undef` and `no-unused-vars`, and a globals file for `marked`, `DOMPurify`, `hljs`, `window.__copilotNativeBridge` and `window.__copilotMenubar`. It runs in `npm test`.
  - *Could go wrong:* 6,000 lines produce hundreds of warnings and the check gets ignored. *Handled by:* start with the three rules that encode real bugs, fix those, and add rules one at a time.
- **Turn on `// @ts-check` file by file** as A3 splits files, not across the monolith at once.
- **Retire the guards the new layout makes pointless:**
  - #22's double-decoding cannot happen outside a template literal. Keep its test until A1 ships, then delete it along with the gotcha's "Check" line.
  - #24's duplicate-name regex is replaced by `no-redeclare`.

**Exit gate:** reintroduce #24 (a second top-level `var ASK_LABELS`) and ESLint fails `npm test`. Record that the check was verified to fail, as the gotchas do.

### A3. Split by feature, when touched

**Approach**
- **The rule:** the next change to a feature moves that feature into its own file first, then makes the change. No big-bang split.
  - Candidates, roughly biggest first: start form and prep, transcript and Stage, cards and publish, coach and pulse, evidence tabs, highlight-to-ask and the selection toolbar, the chat, settings and history.
- **Shared state** (`sessionState`, `sessionId`, `ws`, `replaySessionId`, the helpers `escapeHtml`, `renderMarkdown`, `showToast`) moves to a `core.js` that loads first. Plain classic scripts sharing one namespace object keep this build-free. ES modules are fine too if a split needs imports; WKWebView supports them.
  - *Could go wrong:* a hidden dependency between features breaks at load time. *Handled by:* `no-undef` from A2 names it, and C1 exercises every feature's first render.
- **DOM tests** with `happy-dom` (a dev dependency) for the logic worth testing in isolation: the chat reducer, the selection captures, the evidence tab fitting. The pattern already exists: `present-script.test.ts` runs the shipped `chatApplyDelta` itself.

**Exit gate: a ratchet, not a date.** A test records the largest file in `server/web/`, and it may only shrink. It fails if any file grows more than 10% past its best, the same way `context-budget.py` holds CLAUDE.md.

## 5. Workstream C: An end-to-end smoke test that gates `ship.sh`

### C1. The gate

**Approach**
- **Harness:** `server/e2e/`, using `@playwright/test` (a dev dependency, pruned from the bundle like the others) on **WebKit**, the engine WKWebView uses. Chromium is not a stand-in: gotcha #27 was a painting difference.
  - *Could go wrong:* the WebKit download fails offline. *Handled by:* `npx playwright install webkit` runs once in `setup.sh`, and the gate says so plainly if the browser is missing instead of silently passing.
- **It runs the packaged server,** `dist/Meeting Copilot.app/Contents/Resources/server/dist/index.js` with the bundle's own `node_modules`, so it tests what ships. That covers missing assets, the wrong native-module build (#14) and the vendor copy.
- **Isolation:** a fresh short HOME (`/tmp/mce2e-<random>`, under macOS's 104-character socket limit) and a free port.
  - *Could go wrong:* the real HOME would unlink the live app's `copilot.sock` (the second-server memory). *Handled by:* the harness refuses to start if HOME resolves to the real one.
- **Zero spend:**
  - `COPILOT_DISABLE_PAID_API=1` and `COPILOT_PULSE=0`, with the coach off in the temp HOME's `settings.json`.
  - `COPILOT_E2E_FAKE_CHAT=1` swaps in a deterministic answerer that streams a fixed reply built from the snapshot's title, which proves the context reached it. `/health` reports the fake so it cannot pass unnoticed, and the app's `ProcessSupervisor` never sets it.
  - The fake is honoured only when HOME is not the user's real home.
- **Seed:** commit today's seed as `server/e2e/seed.ts`: a meeting with transcript, a card, a pulse, and a `prep.json` with an html evidence snapshot and a live tab.

**Specs.** Each is one named behaviour; the whole run takes under 60 s so it is never skipped.

| # | Behaviour | Catches |
|---|---|---|
| 1 | `/present` loads idle: no console errors, no failed requests, the socket connects, the start form renders | #22, #24, missing assets, #14 |
| 2 | A replay of the seed renders the transcript, the card, the pulse, and both evidence tabs; the html frame loads with the bridge | replay regressions, `prep.json` handling |
| 3 | The chat round-trips: send, stream, reload keeps it, Stop marks it stopped | the 2026-09-25 Stop bug, persistence |
| 4 | Highlighting a transcript line shows the toolbar; Add to chat makes a chip; selecting inside the evidence frame shows the toolbar | selection capture, the frame bridge |
| 5 | A live session started by a fake app client over the socket: `chat.send` from the "menu bar" opens the drawer | the live socket path |
| 6 | Every popover (All tabs, the card menu, the selection toolbar) has painted, non-background pixels in its box in a screenshot | the #27 class: it hit-tests but never paints |

**Wiring:** `ship.sh` gets a step between packaging and replacing the app. A failure stops the ship before the installed app is touched, and its screenshots and trace go to `dist/e2e/`.

**Exit gate:** each spec is shown to fail on the bug it names, as the gotchas' checks are:
- Reintroduce #22's raw newline: specs 1–6 fail.
- Revert the Stop fix: spec 3 fails.
- Move the All tabs menu back inside the sticky bar: spec 6 fails.

## 6. Workstream B: How much the live meeting asks of you

This is not about tuning suggestion recall. That rule stands (`recall-over-precision`: a missed card costs the work). The question here is how many *kinds* of surfaces compete for your eyes while you talk, and which you actually use.

### B1. Instrument

**Approach**
- **Log dashboard clicks.** A `ui.event` socket message from the dashboard writes `ui.<name>` into the session's `events.jsonl`. Replay has no socket and no meeting, and is not instrumented.
- **Log the menu bar.** The app sends the same message for popover opens and its Ask box.
- **Events, content-free (invariant 7):**
  - coach card dismissed, copied or expanded;
  - pulse opened, dismissed or attached;
  - fact-check flag opened;
  - agenda item toggled by hand;
  - evidence tab selected, copied or opened live;
  - chat opened, and every chat send with its origin (today only the menu bar's is logged);
  - highlight-to-ask used, by mode;
  - Quick Actions used, by type;
  - Stage toggled;
  - the dashboard visible and focused, as seconds per minute. This is the glance measure: whether you look at the panel at all.
- **Rely on what is already logged** for suggestion cards (shown, approved, dismissed, expired), coach cards shown and pulses shown.

*Could go wrong:* instrumentation adds noise to a hot path. *Handled by:* events batch client-side and flush every 10 s. Only visibility sampling is periodic.

### B2. Report

- `npm run report:attention [--since <date>] [--min-minutes 20]` reads every session's `events.jsonl` and prints, per surface:
  - shown;
  - acted on (approved, copied, attached, opened);
  - dismissed;
  - ignored (expired, or never touched);
  - median time to act;
  - per-meeting spread.
- It is a pure function over event lists, tested with fixture logs.
- *Could go wrong:* old sessions without `ui.*` events read as "never used". *Handled by:* the report counts only meetings after B1's first `ui.*` event and says how many there are.

### B3. Decide: a gate, not a date

**Trigger:** 10 instrumented meetings of 20 minutes or more.

**The report proposes; you decide.** For each surface:

| Measure | Proposal |
|---|---|
| Acted on in ≥ 30% of meetings where it appeared | Keep as is |
| Acted on in < 10% of meetings, and never attached to the chat or approved | Demote: collapsed by default, or behind the coach's ⋯ menu |
| Between the two | Leave as is, and re-check at 20 meetings |

A likely outcome is a **Focus** layout (transcript, suggestion cards, the coach line and the chat, with everything else one click away) as a preset beside Stage, not a removal. Nothing is removed without your call.

## 7. Workstream D (optional): The server's entry point

`server/src/index.ts` is 2,247 lines with module-level mutable state: `sessionStore`, `sessionActive`, the rolling-summary timers, pulses, flags.

**Approach, only when a change next touches session lifecycle:**
- Extract a `SessionRuntime` class that owns that state and its start and stop.
- Move each `handleInboundMessage` case into `server/src/ws/`.

**Exit gate:** the same ratchet as A3, and C1 green.

Not scheduled on its own. It pays for itself only when lifecycle work is already happening.

## 8. Not in this plan

- **Automating the audio path.** Core Audio taps, TCC grants and AirPods renegotiation don't run in CI. The two watchdogs, the fail-loud rules (#28) and the opt-in `RealAudioVADTests` are the right level. Revisit if silent-audio classes keep appearing.
- **A front-end framework or build step.** The build-free dashboard, served locally and working offline, is a feature. A1–A3 get the maintainability without one.
- **Retuning suggestions.** That is covered by the replay evals and `recall-over-precision`.

## 9. Done means

- [ ] `ship.sh` refuses to install when a C1 spec fails, and each spec was shown to fail on its named bug.
- [ ] `present/index.ts` is under 1,000 lines; the dashboard is `server/web/*`, byte-identical at the move.
- [ ] ESLint in `npm test`; gotcha #22's guard retired; #24's replaced by `no-redeclare` (verified).
- [ ] The file-size ratchet is in place, and passing.
- [ ] `ui.*` events flow; `report:attention` exists with tests.
- [ ] After 10 instrumented meetings: the report has been run and you have decided on each surface.
