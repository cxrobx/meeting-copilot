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
    # VAD is optional at the binary level (older whisper-cpp lacks the flag)
    # but required for the latency/silence-handling story. Detect via --help
    # so older installs don't blow up on an unknown flag.
    VAD_MODEL="$MODELS_DIR/ggml-silero-v5.1.2.bin"
    VAD_ARGS=()
    if "$WHISPER_BIN" --help 2>&1 | grep -q -- "--vad-model"; then
        if [ -f "$VAD_MODEL" ]; then
            # Size gate: a real Silero model is ~864 KB. Hugging Face 404
            # error bodies are ~15 bytes. Without this check, a stale error
            # body on disk would be passed to whisper-server, which then
            # crash-loops on the invalid GGML file. Matches the same gate
            # in setup.sh and ProcessSupervisor.vadModelPath.
            VAD_BYTES=$(stat -f%z "$VAD_MODEL" 2>/dev/null || stat -c%s "$VAD_MODEL" 2>/dev/null || echo 0)
            if [ "$VAD_BYTES" -lt 500000 ]; then
                echo "  WARNING: VAD model at $VAD_MODEL is only $VAD_BYTES bytes (likely corrupt or a 404 body)."
                echo "           Run ./scripts/setup.sh to re-download. Continuing without VAD."
            else
                VAD_ARGS=(
                    --vad
                    --vad-model "$VAD_MODEL"
                    --vad-threshold 0.50
                    --vad-min-speech-duration-ms 250
                    --vad-min-silence-duration-ms 100
                    --vad-speech-pad-ms 30
                )
                echo "  VAD enabled (ggml-silero-v5.1.2)"
            fi
        else
            echo "  WARNING: VAD model missing at $VAD_MODEL — run ./scripts/setup.sh."
            echo "           Continuing without VAD (silence hallucinations will pass through)."
        fi
    else
        echo "  WARNING: whisper-cpp is too old for --vad-model. Upgrade with:"
        echo "             brew upgrade whisper-cpp"
        echo "           Continuing without VAD."
    fi

    echo "Starting whisper-server on port 8078..."
    "$WHISPER_BIN" \
        --model "$WHISPER_MODEL" \
        --port 8078 \
        --threads 4 \
        --no-timestamps \
        "${VAD_ARGS[@]}" &
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
