#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$HOME/.meeting-copilot"
MODELS_DIR="$DATA_DIR/models"

echo "=== Meeting Copilot Setup ==="
echo ""

# Create data directories
echo "[1/4] Creating data directories..."
mkdir -p "$DATA_DIR/sessions"
mkdir -p "$MODELS_DIR"
mkdir -p "$HOME/Documents/CX/Meetings"
echo "  Created: $DATA_DIR"
echo "  Created: $HOME/Documents/CX/Meetings"

# Install Node.js dependencies
echo ""
echo "[2/4] Installing Node.js server dependencies..."
cd "$PROJECT_DIR/server"
npm install --silent
npm rebuild better-sqlite3
echo "  Done."

# Build Node.js server
echo ""
echo "[3/4] Building Node.js server..."
npx tsc
echo "  Done."

# Download whisper model
echo ""
echo "[4/4] Downloading whisper model (ggml-base.en, ~150MB)..."
WHISPER_MODEL="$MODELS_DIR/ggml-base.en.bin"
if [ -f "$WHISPER_MODEL" ]; then
    echo "  Model already exists at $WHISPER_MODEL, skipping."
else
    echo "  Downloading from Hugging Face..."
    curl -L --progress-bar \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" \
        -o "$WHISPER_MODEL"
    echo "  Downloaded: $WHISPER_MODEL"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Run the audio spike:  cd spike/AudioSpike && swift run"
echo "  2. Start the server:     ./scripts/start.sh"
echo "  3. Build the app:        cd app/MeetingCopilot && swift build"
echo ""
echo "Prerequisites:"
echo "  - whisper-server (whisper.cpp) must be installed separately"
echo "  - Grant Screen Recording permission to your terminal (System Settings > Privacy)"
echo "  - Grant Microphone permission when prompted"
