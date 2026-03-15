#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$HOME/.meeting-copilot"
MODELS_DIR="$DATA_DIR/models"
SOCKET_PATH="$DATA_DIR/copilot.sock"

# Cleanup on exit
cleanup() {
    echo ""
    echo "Shutting down..."

    # Kill whisper-server if running
    if [ -n "${WHISPER_PID:-}" ] && kill -0 "$WHISPER_PID" 2>/dev/null; then
        echo "  Stopping whisper-server (PID $WHISPER_PID)..."
        kill "$WHISPER_PID" 2>/dev/null || true
        wait "$WHISPER_PID" 2>/dev/null || true
    fi

    # Kill Node server if running
    if [ -n "${NODE_PID:-}" ] && kill -0 "$NODE_PID" 2>/dev/null; then
        echo "  Stopping Node server (PID $NODE_PID)..."
        kill "$NODE_PID" 2>/dev/null || true
        wait "$NODE_PID" 2>/dev/null || true
    fi

    # Remove stale socket
    rm -f "$SOCKET_PATH"

    echo "  Done."
}
trap cleanup EXIT INT TERM

# Remove stale socket file
if [ -e "$SOCKET_PATH" ]; then
    echo "Removing stale socket file..."
    rm -f "$SOCKET_PATH"
fi

# Start whisper-server if available
WHISPER_BIN=$(command -v whisper-server 2>/dev/null || echo "")
WHISPER_MODEL="$MODELS_DIR/ggml-base.en.bin"

if [ -n "$WHISPER_BIN" ] && [ -f "$WHISPER_MODEL" ]; then
    echo "Starting whisper-server on port 8078..."
    "$WHISPER_BIN" \
        --model "$WHISPER_MODEL" \
        --port 8078 \
        --threads 4 \
        --no-timestamps &
    WHISPER_PID=$!
    echo "  whisper-server PID: $WHISPER_PID"
    sleep 2
else
    echo "WARNING: whisper-server not found or model missing."
    echo "  Install whisper.cpp and run ./scripts/setup.sh first."
    echo "  Continuing without local transcription..."
    WHISPER_PID=""
fi

# Start Node.js server
echo ""
echo "Starting Node.js server..."
cd "$PROJECT_DIR/server"

if [ -d "dist" ]; then
    node dist/index.js &
else
    npx tsx src/index.ts &
fi

NODE_PID=$!
echo "  Node server PID: $NODE_PID"
echo ""
echo "=== Meeting Copilot Server Running ==="
echo "  Socket: $SOCKET_PATH"
echo "  HTTP:   http://localhost:17890"
echo "  Debug:  http://localhost:17890/debug"
echo ""
echo "Press Ctrl+C to stop."

# Wait for either process to exit
wait
