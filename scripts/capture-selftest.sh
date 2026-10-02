#!/bin/bash
# Prove a built app can still capture: launch it in its --capture-selftest mode,
# which starts the mic and the meeting track for a few seconds and reports how
# many buffers each delivered. No server, no session, nothing stored.
#
#   scripts/capture-selftest.sh                         # dist/Meeting Copilot.app
#   scripts/capture-selftest.sh path/to/App.app [--seconds N]
#
# It goes through LaunchServices (open -n), so it runs under the app's own
# signature, hardened runtime, entitlements and privacy grants, exactly as a
# meeting would. That is what it guards: a signing or entitlement change
# (T230's hardened runtime, a lost audio-input entitlement, a library the
# runtime refuses to load) that leaves a meeting with a dead track. ship.sh
# runs it before install and again on the installed copy.
#
# It requires the mic to be authorized and to deliver non-zero samples (a live
# mic's noise floor is never exact zero, gotcha #28) and the meeting track to
# carry sound. A process tap delivers nothing at all while no process makes
# sound, so the script plays a 7 kHz tone at -50 dBFS meanwhile: inaudible in
# practice, below the 8 kHz the 16 kHz track keeps, and non-zero on the tap.
# The app waits up to --seconds (default 20) for both and stops as soon as
# they arrive.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP="$PROJECT_DIR/dist/Meeting Copilot.app"
SECONDS_ARG=20
while [ $# -gt 0 ]; do
  case "$1" in
    --seconds) SECONDS_ARG="${2:?--seconds needs a number}"; shift 2 ;;
    -*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) APP="$1"; shift ;;
  esac
done

fail() { echo "ERROR: capture self-test: $*" >&2; exit 1; }
[ -d "$APP" ] || fail "no app at $APP"
# open -a wants an absolute path; a relative one is looked up as an app name.
APP="$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"

OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mc-selftest.XXXXXX")"
OUT="$OUT_DIR/result.json"
TONE="$OUT_DIR/tone.wav"
SOUND_PID=""
# macOS's /bin/bash 3.2 exits 0 when `set -u` aborts a script that has an EXIT
# trap; for a gate that would read as "capture works". Only the pass line sets
# SELFTEST_PASSED, and anything else that ends with 0 exits 1.
SELFTEST_PASSED=0
cleanup() {
  local status=$?
  if [ -n "$SOUND_PID" ]; then
    kill "$SOUND_PID" 2>/dev/null || true
    wait "$SOUND_PID" 2>/dev/null || true   # reaped quietly: no "Terminated" line
  fi
  pkill -f "afplay $TONE" 2>/dev/null || true
  pkill -f -- "--capture-selftest $OUT" 2>/dev/null || true
  rm -rf "$OUT_DIR"
  if [ "$status" = 0 ] && [ "$SELFTEST_PASSED" != 1 ]; then
    echo "ERROR: capture self-test: the script stopped before it finished" >&2
    exit 1
  fi
}
trap cleanup EXIT

/usr/bin/python3 - "$TONE" <<'TONE_PY'
import math, struct, sys, wave
rate, seconds, freq, amp = 48000, 2, 7000, 0.003
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
    w.writeframes(b"".join(struct.pack("<h", int(amp * 32767 * math.sin(2 * math.pi * freq * i / rate)))
                           for i in range(rate * seconds)))
TONE_PY
( while true; do afplay "$TONE"; done ) &
SOUND_PID=$!

open -n -a "$APP" --args --capture-selftest "$OUT" --capture-selftest-seconds "$SECONDS_ARG" --capture-selftest-meeting-signal
# A freshly signed build's first launch is assessed by macOS before it runs,
# and compiles its Metal shaders (over 10 s); then up to --seconds of capture.
for _ in $(seq 1 $(( 120 + SECONDS_ARG * 2 ))); do
  [ -s "$OUT" ] && break
  sleep 0.5
done
[ -s "$OUT" ] || fail "the app wrote no result within 60 s (see ~/.meeting-copilot/app.log, [SelfTest])"

# plutil prints a missing key's error on stdout, so keep its output only on success.
field() { local value; if value="$(plutil -extract "$1" raw -o - "$OUT" 2>/dev/null)"; then echo "$value"; fi; }
summary="mic $(field micBuffers) buffers ($(field micNonZero) non-zero, $(field micAuthorization), first after $(field micFirstAfter)s), meeting $(field meetingBuffers) buffers ($(field meetingNonZero) non-zero, $(field meetingBackend), first after $(field meetingFirstAfter)s)"

[ -z "$(field error)" ] || fail "capture did not start: $(field error)"
[ "$(field micAuthorization)" = "authorized" ] || fail "microphone access is $(field micAuthorization). $summary"
[ "$(field micBuffers)" -gt 0 ] 2>/dev/null || fail "the mic delivered nothing. $summary"
[ "$(field micNonZero)" -gt 0 ] 2>/dev/null || fail "the mic delivered only exact zeros. $summary"
[ "$(field meetingBuffers)" -gt 0 ] 2>/dev/null \
  || fail "the meeting track delivered nothing while a tone played (is the output muted?). $summary"
[ "$(field meetingNonZero)" -gt 0 ] 2>/dev/null \
  || fail "the meeting track heard only zeros while a tone played (System Audio Recording permission, gotcha #20?). $summary"
echo "Capture self-test passed: $summary"
SELFTEST_PASSED=1
