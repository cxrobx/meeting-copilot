---
description: Test, package, verify & install the Meeting Copilot app (runs scripts/ship.sh)
---

# Ship Meeting Copilot

Rebuild the SwiftUI menubar app + Node server, verify the signed bundle, replace
`/Applications/Meeting Copilot.app`, relaunch, and health-check it.
Standing rule: always rebuild before relaunching after code changes.

Working directory: the repository root

**`./scripts/ship.sh` is the source of truth; this command only drives it.** Never
hand-roll the install to get past a failure. The guards and the rollback are the
whole point, so report the failure instead.

What `ship.sh` does, in order:
1. Refuses to start if a meeting is active (`/health` → `session`), and checks
   again after packaging, since a meeting can start during the build.
2. Runs the release tests: server `npm test` pinned to the runtime Node (the
   `better-sqlite3` ABI, gotcha #14), then `swift test`.
3. Packages with `build-app.sh` (into `build/` and `dist/`; it does not install),
   then runs `verify-app.sh --require-developer-id`. That checks the bundle
   contents, the version, the Info.plist usage descriptions, the libwhisper
   linkage, the model sizes and the Developer ID signature.
4. Quits the running app, stages a copy in `/Applications`, verifies the copy,
   swaps it in, and keeps the old app as a backup.
5. Launches the new app and waits up to 45 s for `/health`. If the launch or
   health check fails, or the script is interrupted, it **restores the previous
   app automatically**.

## Steps

1. **Preflight.** The build aborts if vendored assets or models are missing:
   ```bash
   test -f server/vendor/js/marked.min.js || echo "MISSING: run ./scripts/vendor-assets.sh"
   test -f ~/.meeting-copilot/models/ggml-silero-v5.1.2.bin || echo "MISSING VAD: run ./scripts/setup.sh"
   ```
   If either is missing, run the named script first.

2. **Ship.** It takes a few minutes, so give it a 10-minute timeout:
   ```bash
   ./scripts/ship.sh --yes
   ```
   `--yes` replaces the interactive `Replace …? [y/N]` prompt, which cannot be
   answered without a TTY. Chris invoking `/ship` **is** that confirmation, so
   only pass `--yes` from this command or when he has explicitly asked to ship.

   Failures to stop and report on, never work around:
   - `A meeting is active`: tell Chris. Do not quit the app for him.
   - `health endpoint is unreachable`: the app is running but its server is
     down, so the script cannot prove no meeting is live. Ask Chris before
     quitting it (Recovery Playbook A in `.claude/rules/gotchas.md`).
   - Test or `verify-app.sh` failures: report the output. Nothing was installed.
   - `previous installation was restored`: the new build failed to launch or to
     become healthy. Read `~/.meeting-copilot/app.log` and `server.log`.

3. **Report** from the tail of the output (`=== Ship Complete ===`): the
   version, that the signature is `Developer ID`, and that the app came up
   healthy.

## Notes

- **Do not `pkill whisper-server`.** notes4chris may share it (Recovery Playbook B).
  `ship.sh` quits only this app, and `ProcessSupervisor` cleans up its own children.
- **Signing:** `ship.sh` requires a Developer ID signature, which keeps the TCC
  grants (Screen Recording, Microphone, System Audio Recording) valid across
  ships. An ad-hoc build would lose them, so the script rejects one.
- **Package only, no install:** `./scripts/build-app.sh` builds `dist/Meeting Copilot.app`.
- The version comes from `VERSION`; bump it there, never in `Info.plist`.
