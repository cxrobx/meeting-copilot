#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

usage() {
    echo "Usage: $0 <recording-dir> [--speed <multiplier>] [--port <port>]"
    echo ""
    echo "Replay recorded meeting audio through the full copilot pipeline."
    echo "Requires the copilot server and whisper-server to be running."
    echo ""
    echo "Options:"
    echo "  --speed <n>   Playback speed (default: 1 = real-time, 4 = 4x faster)"
    echo "  --port <n>    Server port (default: 17890)"
    echo ""
    echo "Examples:"
    echo "  $0 ~/Documents/Notes4ChrisRecordings/recordings/2026-03-17_22-02-27_session"
    echo "  $0 ~/Documents/Notes4ChrisRecordings/recordings/2026-03-17_22-02-27_session --speed 4"
    echo ""
    echo "Quick start:"
    echo "  1. In terminal 1: ./scripts/start.sh      (starts server + whisper)"
    echo "  2. In terminal 2: $0 <recording-dir>       (streams audio)"
}

if [ $# -lt 1 ] || [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
    usage
    exit 0
fi

# Check server is reachable
PORT=17890
for arg in "$@"; do
    if [ "$prev_arg" = "--port" ]; then
        PORT="$arg"
    fi
    prev_arg="$arg"
done

if ! curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
    echo "ERROR: Copilot server not reachable at localhost:$PORT"
    echo ""
    echo "Start the server first:"
    echo "  ./scripts/start.sh"
    echo ""
    echo "Or run the server in dev mode:"
    echo "  cd server && npm run dev"
    exit 1
fi

echo "Server is running at localhost:$PORT"

cd "$PROJECT_DIR/server"
exec npx tsx src/replay-audio.ts "$@"
