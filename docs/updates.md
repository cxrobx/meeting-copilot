# Distribution and updates

Meeting Copilot ships as a signed, notarized, self-contained app that another person can download and run, and it updates itself with [Sparkle](https://sparkle-project.org) 2. Built for T230 (2026-10-02). Nothing is published until Chris runs `release.sh --publish`.

## What "self-contained" means here

A downloaded copy needs nothing installed on the Mac but macOS 14+ on Apple Silicon:

| Piece | Where it comes from | Pinned by |
|---|---|---|
| Node 24 (runs the server) | `Contents/Resources/node/bin/node` | `scripts/fetch-node.sh` (version + sha256). The same binary builds the server, runs `npm test`, the e2e gate and the app, so `better-sqlite3`'s ABI always matches (gotcha #14 is closed). |
| `uv` (runs Parakeet) | `Contents/Resources/uv/bin/uv` | `scripts/fetch-uv.sh` (0.9.21 + sha256) |
| Parakeet's Python deps | fetched by `uv` on first start into the user's caches | `scripts/parakeet-server.py.lock` (hashes, Python 3.12, `exclude-newer` 2026-07-28: the exact 56 packages the app ran since July). The app runs `uv run --frozen --script`; `build-app.sh` refuses a stale lock. |
| Parakeet model (2.5 GB) | Hugging Face on first start | the model id in the script |
| whisper model (148 MB, fallback only) | downloaded on first use of whisper mode, sha256-checked | `ProcessSupervisor.whisperModelURL` (a commit, not `main`) |
| Silero VAD (0.9 MB) | in the app | |
| Sparkle 2.10.0 | `Contents/Frameworks` | `app/MeetingCopilot/Package.resolved` |

First start on a new Mac: `uv` fetches Python and the packages, then the model. Measured from empty caches on 2026-10-02: ready in 50 s on a fast connection (54 MB Python, 947 MB of packages, 2.3 GB model). While it runs, the menu bar shows a **Preparing transcription** card with the download's percentage (`ProcessSupervisor.transcriptionSetup`), and preflight does not call the starting sidecar a failure. On this Mac nothing is fetched again: the bundled `uv` uses the same caches.

`verify-app.sh` fails a build that is not self-contained: any Mach-O whose load commands name `/opt/homebrew`, `/usr/local` or a home folder. Proved on 2026-10-02 by running the installed app's Node and server under `sandbox-exec` with reads of `/opt/homebrew`, `/usr/local`, `~/.local`, `~/.nvm`, the build caches and `~/Projects` all denied: `better-sqlite3` loaded, `/health` answered, `/present` served.

What a stranger's copy does **not** get: the `claude` CLI features (pulse, suggestions, deep research), vault filing, CXTasks and the R2 publish path assume Chris's setup. They fail soft; nobody has made them work elsewhere.

## Signing

`build-app.sh` signs every Mach-O on its own, innermost first, with the hardened runtime and a secure timestamp, then Sparkle's helpers in the order Sparkle documents, then the app. Never `--deep`: it skips Mach-O files under `Contents/Resources`.

- **The app** (`scripts/entitlements/app.plist`): `com.apple.security.device.audio-input` only. ScreenCaptureKit and the process tap need no entitlement, only privacy grants. Library validation stays on: everything loaded in-process (libwhisper, Sparkle) is signed by the same team.
- **Node** (`scripts/entitlements/node.plist`): `allow-jit` and `allow-unsigned-executable-memory`, which V8 needs. Node's own signature also carries `get-task-allow` (notarization rejects it), `disable-library-validation` (the only addon is ours), and two more nothing uses. All are dropped on purpose.

**The grants survive.** macOS keys Microphone, Screen Recording and System Audio Recording to the designated requirement: this bundle id plus Developer ID team `CCYV5HQZCM`. The hardened runtime doesn't change it. `verify-app.sh --require-developer-id` fails any other requirement.

**The capture self-test** (`scripts/capture-selftest.sh`, the app's `--capture-selftest` mode) proves that a build can still capture under its own signature and grants. `ship.sh` runs it on the package before install and on the installed copy after. It plays a 7 kHz tone at -50 dBFS meanwhile, because a process tap delivers nothing at all while no process makes sound (gotcha #31). The post-install run also pays the one-time Metal shader compile, about 10 s, that a newly signed whisper build needs (gotcha #32).

## Updates

- **The feed** is `https://github.com/cxrobx/meeting-copilot/releases/latest/download/appcast.xml` (`scripts/sparkle.conf`). Every release carries its own `appcast.xml`, and GitHub serves the newest one. The app checks daily and from the menu bar's **Updates** button. It asks before installing (`SUAutomaticallyUpdate` off) and verifies the archive's EdDSA signature before extracting it. The feed is arm64 only (`sparkle:hardwareRequirements`).
- **Never during a meeting** (`UpdateController`, `UpdatePolicy`; a meeting is `SessionState.isMeeting`, priming through ending):
  - A background check that comes due in a meeting is held, since its window would land on a shared screen. It runs once the meeting ends. A check you ask for always runs.
  - Installing quits the app, and quitting ends the session, so an install accepted mid-meeting is postponed through `SPUUpdaterDelegate`. After the meeting it also waits, up to 15 min, for the server's close-out work to finish (`GET /debug` workers: queued, approved, running), so the summary and review aren't killed by the relaunch.
  - These rules are unit-tested (`UpdatePolicyTests`). No real meeting was run against them.
- **Before any release exists** the daily check gets a 404 and fails quietly. It's logged as `[Updates] Update aborted` and no window opens.

### The key

`SUPublicEDKey` (in `scripts/sparkle.conf`) is the public half. The private half is in the login Keychain as Sparkle account `meeting-copilot`, backed up in the secrets store as `SPARKLE_ED_PRIVATE_MEETING_COPILOT`. **Lose both and no installed copy can ever update again**: the key is the update channel's identity. Never commit it.

To back it up again: export with `generate_keys --account meeting-copilot -x <file>` under `umask 077` (it refuses an existing file, and `-x /dev/stdout` stores an error message instead of the key). Then `secret set SPARKLE_ED_PRIVATE_MEETING_COPILOT < file`, then `rm -P` the file.

## Releasing

1. Bump `VERSION` and write `release-notes/vX.Y.Z.md` (markdown; it becomes the update window's text). Commit.
2. Check first: `secret run -k SPARKLE_ED_PRIVATE_MEETING_COPILOT -- scripts/release.sh X.Y.Z --check`. It checks the version and notes, that the tag and release are free, that the version is newer than the latest release, the Developer ID identity and the notary profile (`MC_NOTARY_PROFILE`, default `DiskSight`). It also signs a probe with the key and verifies it against `SUPublicEDKey`.
3. Build: the same command without `--check`. It builds with `build-app.sh` and notarizes and staples the app and a drag-to-Applications DMG. It signs the zip for Sparkle (the key reaches `sign_update` on stdin, never argv or a child's environment) and writes the appcast. Then `verify-update-feed.sh` checks it as an installed copy would: length, EdDSA signature against the public key, version, key and feed inside the app, `verify-app.sh`, stapled, Gatekeeper "Notarized Developer ID". Output: `dist/vX.Y.Z/`.
4. Publish: push, then run the printed `gh release create`, or re-run with `--publish`. **Only with Chris's go.**
5. After publishing: `scripts/verify-update-feed.sh` checks the live feed.

`--allow-dirty` makes a dry run that can never be published. Run the real-update test below before the first release, and after any Sparkle bump.

## The real-update test

Last run 2026-10-02, all passing. Build two signed test versions pointed at a local feed: set `VERSION` to N, then to N+1, each time running `MC_FEED_URL=http://127.0.0.1:18765/appcast.xml ./scripts/build-app.sh`. `verify-app.sh` refuses a test feed unless `--allow-test-feed` is passed, so `ship.sh` and `release.sh` can never install or publish one. Restore `VERSION` afterwards.

Zip N+1 with `ditto -c -k --keepParent`. Make three archives:
- the genuine one, signed with the real key;
- a copy with one byte flipped after signing;
- a copy signed with a random key: `head -c 32 /dev/urandom | base64 | sign_update --ed-key-file - -p`.

Write an appcast for each, and serve them with `python3 -m http.server 18765 --bind 127.0.0.1`.

1. Quit the installed app (no meeting may be live). The test copy binds :17890 and its `cleanupOrphans` would kill the live server.
2. Run N from a scratch folder (`open -n`). Its popover's **Updates** button starts a check. Sparkle's buttons can be clicked through System Events: Install Update, Install and Relaunch, and Cancel Update on the error dialog.
3. **Tampered** and **wrong key**: both must show "The update is improperly signed and could not be validated", log `[Updates] Update aborted`, and leave N in place.
4. **Genuine**: must reach "Ready to Install". Install and Relaunch replaces the copy in place and relaunches it as N+1, with a valid signature and a healthy server. Then run `scripts/capture-selftest.sh` on it.
5. Clean up: quit the test copy, stop the server, and delete the `SU*` keys and `NSWindow Frame SUUpdateAlert*` the test wrote into `com.christopherrobinson.meeting-copilot` (they share the real app's defaults). Then reopen the installed app.

Result on 2026-10-02: both bad archives were refused and 0.1.90 stayed. 0.1.91 installed and relaunched in 2 s, and then 0.1.92 the same way, started from the Updates button. Each relaunched copy came up healthy and passed the capture self-test.
