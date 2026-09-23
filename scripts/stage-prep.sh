#!/bin/bash
# Stage a meeting prep so Meeting Copilot's start form is filled and waiting.
#
#   scripts/stage-prep.sh <prep.json | ->    check, fill from the invite, write
#   scripts/stage-prep.sh --check <file>     check only, write nothing
#   scripts/stage-prep.sh --list             what is waiting
#   scripts/stage-prep.sh --remove <id>      drop one
#   scripts/stage-prep.sh --invites [days]   cxmail invites ahead (default 7), with their eventUid
#   scripts/stage-prep.sh --gather <uid>     email threads, past meetings, vault notes for an invite
#
# Input format and limits: skills/meeting-prep/SKILL.md. Source: server/src/prep/stage-cli.ts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")/server"

# The same Node the app's server runs under (ProcessSupervisor / build-app.sh),
# so better-sqlite3 — used for the invite lookup — loads (gotcha #14).
NODE=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -x "$candidate" ]; then NODE="$candidate"; break; fi
done
NODE="${NODE:-node}"

# A relative input path is relative to where the caller ran this, not to server/.
args=()
for arg in "$@"; do
  if [[ "$arg" != -* && "$arg" != "-" && "$arg" != /* && -e "$arg" ]]; then
    arg="$(cd "$(dirname "$arg")" && pwd)/$(basename "$arg")"
  fi
  args+=("$arg")
done

cd "$SERVER_DIR"
exec "$NODE" --import tsx src/prep/stage-cli.ts ${args[@]+"${args[@]}"}
