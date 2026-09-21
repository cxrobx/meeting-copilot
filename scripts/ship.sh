#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_NAME="Meeting Copilot"
BUNDLE_ID="com.christopherrobinson.meeting-copilot"
PACKAGED_APP="$PROJECT_DIR/dist/$APP_NAME.app"
INSTALLED_APP="/Applications/$APP_NAME.app"
COPILOT_PORT="${COPILOT_PORT:-17890}"
HEALTH_URL="http://127.0.0.1:$COPILOT_PORT/health"

RUNTIME_NODE=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -x "$candidate" ]; then
    RUNTIME_NODE="$candidate"
    break
  fi
done

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

# --yes stands in for the interactive replace prompt. It exists for the
# /ship command, where Chris invoking /ship IS the confirmation and there is
# no TTY to answer on. Every other guard (active meeting, tests, Developer ID
# verification, health check, rollback) still runs.
ASSUME_YES=false
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=true ;;
    *) fail "Unknown argument: $arg (usage: ship.sh [--yes])" ;;
  esac
done

app_is_running() {
  pgrep -f "$INSTALLED_APP/Contents/MacOS/MeetingCopilot" >/dev/null 2>&1
}

health_state() {
  local payload
  payload="$(curl --silent --max-time 4 "$HEALTH_URL" 2>/dev/null || true)"
  if [ -z "$payload" ] || [ -z "$RUNTIME_NODE" ]; then
    echo "unreachable"
    return
  fi

  printf '%s' "$payload" | "$RUNTIME_NODE" -e '
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const health = JSON.parse(raw);
        process.stdout.write(health.session ? "active" : "idle");
      } catch {
        process.stdout.write("unreachable");
      }
    });
  '
}

ensure_no_active_meeting() {
  local state
  state="$(health_state)"
  case "$state" in
    active)
      fail "A meeting is active. Stop it before shipping a new build."
      ;;
    unreachable)
      if app_is_running; then
        fail "Meeting Copilot is running but its health endpoint is unreachable, so the ship script cannot prove that no meeting is active. Quit the app manually and retry."
      fi
      ;;
  esac
}

wait_for_app_exit() {
  local attempts=0
  while app_is_running && [ "$attempts" -lt 15 ]; do
    sleep 1
    attempts=$((attempts + 1))
  done
  ! app_is_running
}

wait_for_health() {
  local attempts=0
  while [ "$attempts" -lt 45 ]; do
    if app_is_running && [ "$(health_state)" != "unreachable" ]; then
      return 0
    fi
    sleep 1
    attempts=$((attempts + 1))
  done
  return 1
}

rollback_install() {
  local backup_app="$1"
  local relaunch_old="$2"

  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  wait_for_app_exit || true

  if [ -d "$INSTALLED_APP" ]; then
    rm -rf "$INSTALLED_APP"
  fi
  if [ -d "$backup_app" ]; then
    mv "$backup_app" "$INSTALLED_APP"
    echo "  Restored previous installation."
    if [ "$relaunch_old" = true ]; then
      open "$INSTALLED_APP"
    fi
  fi
}

staged_app=""
backup_root=""
backup_app=""
was_running=false
restore_needed=false

cleanup_on_exit() {
  local status=$?
  trap - EXIT INT TERM HUP

  if [ "$restore_needed" = true ]; then
    echo ""
    echo "Ship interrupted; restoring the previous installation..." >&2
    rollback_install "$backup_app" "$was_running" || true
    restore_needed=false
  fi
  if [ -n "$staged_app" ] && [ -d "$staged_app" ]; then
    rm -rf "$staged_app"
  fi
  if [ -n "$backup_root" ] && [ -d "$backup_root" ] && [ "$restore_needed" = false ]; then
    rm -rf "$backup_root"
  fi

  exit "$status"
}

trap cleanup_on_exit EXIT INT TERM HUP

echo "=== Shipping $APP_NAME ==="
echo ""

ensure_no_active_meeting

echo "[1/4] Running release tests..."
# Pin Node the same way build-app.sh does. The server's better-sqlite3 is
# compiled against the RUNTIME Node (/usr/local/bin, ABI 115); an nvm shell
# (Node 24, ABI 137) loads the wrong ABI and every SessionStore/calendar test
# dies with NODE_MODULE_VERSION before a single real assertion runs. That is a
# property of the shell, not of the code being shipped — so pin it here rather
# than let a green tree look broken at the gate.
[ -n "$RUNTIME_NODE" ] || fail "No system Node in /opt/homebrew/bin or /usr/local/bin; cannot run release tests against the runtime ABI."
(cd "$PROJECT_DIR/server" && PATH="$(dirname "$RUNTIME_NODE"):$PATH" npm test)
(cd "$PROJECT_DIR/app/MeetingCopilot" && swift test)

echo ""
echo "[2/4] Packaging app..."
"$SCRIPT_DIR/build-app.sh"
"$SCRIPT_DIR/verify-app.sh" --require-developer-id "$PACKAGED_APP"

# Re-check after the build: packaging can take long enough for a meeting to
# have started after the initial guard.
ensure_no_active_meeting

if [ "$ASSUME_YES" = true ]; then
  echo ""
  echo "Replacing $INSTALLED_APP (confirmed by --yes)."
else
  if [ ! -t 0 ]; then
    fail "Shipping replaces /Applications/$APP_NAME.app and requires an interactive confirmation (or --yes)."
  fi

  echo ""
  printf 'Replace %s with the verified build? [y/N] ' "$INSTALLED_APP"
  read -r confirmation
  case "$confirmation" in
    y|Y|yes|YES)
      ;;
    *)
      echo "Cancelled. The verified package remains at: $PACKAGED_APP"
      exit 0
      ;;
  esac
fi

echo ""
echo "[3/4] Replacing installed app..."
if app_is_running; then
  was_running=true
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  wait_for_app_exit || fail "The running app did not quit; installation was not changed."
fi

staged_app="/Applications/.$APP_NAME.ship.$$.app"
backup_root="$(mktemp -d "${TMPDIR:-/tmp}/meeting-copilot-ship.XXXXXX")"
backup_app="$backup_root/$APP_NAME.app"

ditto "$PACKAGED_APP" "$staged_app"
"$SCRIPT_DIR/verify-app.sh" --require-developer-id "$staged_app"

if [ -d "$INSTALLED_APP" ]; then
  mv "$INSTALLED_APP" "$backup_app"
fi
restore_needed=true

if ! mv "$staged_app" "$INSTALLED_APP"; then
  restore_needed=false
  rollback_install "$backup_app" "$was_running"
  fail "Could not move the new app into /Applications; the previous installation was restored."
fi

if ! "$SCRIPT_DIR/verify-app.sh" --require-developer-id "$INSTALLED_APP"; then
  restore_needed=false
  rollback_install "$backup_app" "$was_running"
  fail "Installed bundle verification failed; the previous installation was restored."
fi

echo ""
echo "[4/4] Launching and checking health..."
if ! open "$INSTALLED_APP"; then
  restore_needed=false
  rollback_install "$backup_app" "$was_running"
  fail "The new app could not be launched; the previous installation was restored."
fi
if ! wait_for_health; then
  restore_needed=false
  rollback_install "$backup_app" "$was_running"
  fail "The new app did not become healthy within 45 seconds; the previous installation was restored."
fi

restore_needed=false
rm -rf "$backup_root"
backup_root=""
trap - EXIT INT TERM HUP

app_version="$(tr -d '[:space:]' < "$PROJECT_DIR/VERSION")"
echo ""
echo "=== Ship Complete ==="
echo "  Installed: $INSTALLED_APP"
echo "  Version:   $app_version"
echo "  Package:   $PACKAGED_APP"
