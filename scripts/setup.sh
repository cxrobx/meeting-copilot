#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$HOME/.meeting-copilot"
MODELS_DIR="$DATA_DIR/models"

echo "=== Meeting Copilot Setup ==="
echo ""

# whisper-cpp is a HARD dev dependency (Swift links against libwhisper.dylib
# for VAD and the build-app.sh script bundles the dylibs into the .app).
# Fail fast with an actionable message if it's missing — otherwise
# `swift build` blows up on `#include <whisper.h>` with a confusing error.
if ! command -v whisper-server >/dev/null 2>&1; then
    echo "ERROR: whisper-cpp is not installed." >&2
    echo "" >&2
    echo "  Install it with:  brew install whisper-cpp" >&2
    echo "" >&2
    echo "  This ships libwhisper.dylib + whisper-server that the Swift app" >&2
    echo "  links against (for VAD) and bundles into /Applications/Meeting Copilot.app." >&2
    exit 1
fi
if [ ! -f /opt/homebrew/opt/whisper-cpp/libexec/include/whisper.h ] && \
   [ ! -f /usr/local/opt/whisper-cpp/libexec/include/whisper.h ]; then
    echo "ERROR: whisper-cpp is installed but headers are missing." >&2
    echo "  Try:  brew reinstall whisper-cpp" >&2
    exit 1
fi

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
echo "[3/5] Building Node.js server..."
npx tsc
echo "  Done."

# Robust model downloader: `curl -f` so HTTP errors fail the command instead of
# writing "Entry not found" bodies into our model files, plus a post-download
# size floor to catch redirects / partial downloads that still return 200.
download_model() {
    local url="$1"
    local dest="$2"
    local min_bytes="$3"
    local tmp="${dest}.partial"

    curl -fL --progress-bar "$url" -o "$tmp" || {
        echo "  ERROR: download failed from $url" >&2
        rm -f "$tmp"
        return 1
    }

    local actual_bytes
    actual_bytes=$(stat -f%z "$tmp" 2>/dev/null || stat -c%s "$tmp" 2>/dev/null || echo 0)
    if [ "$actual_bytes" -lt "$min_bytes" ]; then
        echo "  ERROR: downloaded $actual_bytes bytes, expected at least $min_bytes" >&2
        echo "         likely got an error page instead of the model file." >&2
        rm -f "$tmp"
        return 1
    fi

    mv "$tmp" "$dest"
    return 0
}

# Download whisper model
echo ""
echo "[4/5] Downloading whisper model (ggml-base.en, ~150MB)..."
WHISPER_MODEL="$MODELS_DIR/ggml-base.en.bin"
if [ -f "$WHISPER_MODEL" ]; then
    echo "  Model already exists at $WHISPER_MODEL, skipping."
else
    echo "  Downloading from Hugging Face..."
    download_model \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin" \
        "$WHISPER_MODEL" \
        100000000 || exit 1
    echo "  Downloaded: $WHISPER_MODEL"
fi

# Download Silero VAD model — whisper-server uses this to trim silent regions
# inside whisper_full(), which cuts decode time on sparse-speech chunks and
# kills most silence hallucinations at the source. Required for Phase 1+.
echo ""
echo "[5/5] Downloading Silero VAD model (ggml-silero-v5.1.2, ~2MB)..."
VAD_MODEL="$MODELS_DIR/ggml-silero-v5.1.2.bin"
if [ -f "$VAD_MODEL" ]; then
    # Size sanity check: the 404 body is ~15 bytes. A real model is ~864KB.
    existing_bytes=$(stat -f%z "$VAD_MODEL" 2>/dev/null || stat -c%s "$VAD_MODEL" 2>/dev/null || echo 0)
    if [ "$existing_bytes" -lt 500000 ]; then
        echo "  Existing VAD model is only $existing_bytes bytes — re-downloading."
        rm -f "$VAD_MODEL"
    else
        echo "  VAD model already exists at $VAD_MODEL, skipping."
    fi
fi
if [ ! -f "$VAD_MODEL" ]; then
    echo "  Downloading from Hugging Face..."
    download_model \
        "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin" \
        "$VAD_MODEL" \
        500000 || exit 1
    echo "  Downloaded: $VAD_MODEL"
fi

# ── Parakeet (default transcription backend) ─────────────────────────────────
# Parakeet-TDT (via parakeet-mlx) is the default backend — best local accuracy
# on meeting speech, fully on-device. It runs via `uv` (PEP-723 inline deps),
# so the only prerequisite is uv + a one-time model pull. whisper stays as the
# automatic fallback if uv is missing.
echo ""
echo "[6/6] Setting up Parakeet (default transcription backend)..."
if command -v uv >/dev/null 2>&1; then
    echo "  uv found: $(command -v uv)"
    echo "  Pre-pulling the Parakeet model (parakeet-tdt-0.6b-v3, ~2.3GB) so the first meeting is instant..."
    if uvx --from parakeet-mlx python -c "from parakeet_mlx import from_pretrained; from_pretrained('mlx-community/parakeet-tdt-0.6b-v3'); print('ok')" >/dev/null 2>&1; then
        echo "  Parakeet model ready."
    else
        echo "  WARNING: Parakeet model pre-pull failed — it will download on first launch instead."
    fi
else
    echo "  WARNING: 'uv' is not installed — Parakeet (the default backend) requires it."
    echo "           Install it:  curl -LsSf https://astral.sh/uv/install.sh | sh"
    echo "           Until then, transcription automatically falls back to whisper (ggml-base.en)."
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
echo "  - uv (for Parakeet, the default transcription backend): https://astral.sh/uv"
echo "  - whisper-server (whisper.cpp) for the fallback backend"
echo "  - Grant Screen Recording permission to your terminal (System Settings > Privacy)"
echo "  - Grant Microphone permission when prompted"
