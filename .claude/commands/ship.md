---
description: Build, sign, install & relaunch the Meeting Copilot app
---

# Ship Meeting Copilot

Rebuild the SwiftUI menubar app + Node server, sign, install to /Applications, and relaunch.
Standing rule: always rebuild before relaunching after code changes.

Working directory: the repository root

`./scripts/build-app.sh` does the heavy lifting (build server → `swift build -c release` → assemble
`.app` → codesign → install to `/Applications` → copy to `dist/`). It does NOT quit a running app
first and it `rm -rf`s the installed bundle, so quit before building.

## Steps

Run in order. Stop and report if any step fails.

1. **Preflight** — the build aborts if vendored assets or models are missing. Confirm they exist:
   ```bash
   test -f server/vendor/js/marked.min.js || echo "MISSING: run ./scripts/vendor-assets.sh"
   test -f ~/.meeting-copilot/models/ggml-silero-v5.1.2.bin || echo "MISSING VAD: run ./scripts/setup.sh"
   ```
   If either is missing, run the named script first.

2. **Quit the running app + orphaned children** (safe — targets only this app's processes):
   ```bash
   osascript -e 'if application "Meeting Copilot" is running then quit application "Meeting Copilot"' 2>/dev/null || true
   sleep 1
   pkill -f "Meeting Copilot.app" 2>/dev/null || true
   pkill -f "meeting-copilot/server" 2>/dev/null || true
   pkill -f whisper-server 2>/dev/null || true
   sleep 1
   ```

3. **Build + sign + install** (installs to `/Applications` and copies to `dist/`):
   ```bash
   ./scripts/build-app.sh
   ```
   Watch the tail: it verifies `libwhisper` install-name rewrite and that `better-sqlite3` loads under
   the runtime Node (ABI check). A `-` (ad-hoc) signature line means TCC (Screen Recording / Mic) will
   be re-prompted next launch; a `Developer ID Application` line means grants persist.

4. **Relaunch**:
   ```bash
   open "/Applications/Meeting Copilot.app"
   ```

5. **Verify beyond the build** — the app (LSUIElement, no dock icon) spawns the Node server, which
   listens on :17890 with a `/health` endpoint. Give ProcessSupervisor a few seconds, then:
   ```bash
   pgrep -fl "Meeting Copilot.app" || echo "APP NOT RUNNING"
   sleep 6
   curl -sf http://localhost:17890/health && echo "  server OK" || echo "  server /health FAILED"
   ```
   The menu-bar icon should appear. If `/health` fails, check `~/.meeting-copilot/server.log` and
   `~/.meeting-copilot/app.log` (see `.claude/rules/gotchas.md` Recovery Playbook).

Report: which signing identity was used (ad-hoc vs Developer ID), whether the app process is running,
and whether `/health` returned 200.
