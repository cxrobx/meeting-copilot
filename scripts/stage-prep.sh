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
# Input format and limits: skills/meeting-copilot-prep/SKILL.md. Source: server/src/prep/stage-cli.ts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(dirname "$SCRIPT_DIR")/server"

# The pinned Node the checkout's better-sqlite3 is built for (fetch-node.sh),
# so the invite lookup loads it (gotcha #14). Offline before the first fetch,
# PATH's node still stages; stage-cli only loses the invite lookup.
NODE="$("$SCRIPT_DIR/fetch-node.sh" 2>/dev/null || true)"
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
