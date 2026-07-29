#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "parakeet-mlx",
#   "fastapi",
#   "uvicorn",
#   "python-multipart",
# ]
# ///
"""
Parakeet STT sidecar — a whisper-server-compatible /inference HTTP shim.

Backs NVIDIA Parakeet-TDT (mlx-community/parakeet-tdt-0.6b-v3) via parakeet-mlx
(Apple Silicon, MLX, fully on-device) and exposes the SAME contract the app's
WhisperProvider already speaks against whisper.cpp's whisper-server:

    GET  /            -> 200 health probe (WhisperProvider.isAvailable)
    POST /inference   -> multipart form `file` (WAV bytes) [+ optional `prompt`]
                         returns { "text": "<transcription>" }

So switching the app to Parakeet is just pointing WhisperProvider at this port —
no new provider class. Run:

    uv run scripts/parakeet-server.py --port 8077
    # or:  ./scripts/parakeet-server.py --port 8077

Model is loaded once at startup; each request transcribes one chunk. The first
inference pays a one-time Metal compile cost (the app's health polling covers it).
"""
import argparse
import asyncio
import io
import os
import sys
import wave

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse
import mlx.core as mx
import numpy as np
import uvicorn

DEFAULT_MODEL = os.environ.get("PARAKEET_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")
MAX_WAV_BYTES = 20 * 1024 * 1024

app = FastAPI()
_model = None
_model_name = DEFAULT_MODEL
_inference_lock = asyncio.Lock()


def _log(msg: str) -> None:
    print(f"[parakeet-server] {msg}", file=sys.stderr, flush=True)


def get_model():
    global _model
    if _model is None:
        from parakeet_mlx import from_pretrained
        _log(f"loading model {_model_name} …")
        _model = from_pretrained(_model_name)
        _log("model loaded")
    return _model


@app.get("/")
def health():
    # whisper-server answers GET / with a page; the app only checks reachability.
    return JSONResponse({
        "status": "ok",
        "model": _model_name,
        "engine": "parakeet-mlx",
        "audioStorage": "memory-only",
        "supportsPrompt": False,
    })


def _decode_wav(data: bytes) -> mx.array:
    """Decode the app's required 16 kHz mono PCM WAV without touching disk."""
    with wave.open(io.BytesIO(data), "rb") as wav:
        if wav.getnchannels() != 1:
            raise ValueError("expected mono audio")
        if wav.getsampwidth() != 2:
            raise ValueError("expected 16-bit PCM audio")
        if wav.getframerate() != 16_000:
            raise ValueError("expected 16 kHz audio")
        frames = wav.readframes(wav.getnframes())
    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    # Match parakeet_mlx.audio.load_audio(), which returns float32 (its dtype
    # argument is currently unused). get_logmel views the complex STFT using
    # this dtype, so bfloat16 would double the frequency dimension.
    return mx.array(samples, dtype=mx.float32)


def _transcribe_bytes(data: bytes) -> str:
    from parakeet_mlx.audio import get_logmel

    model = get_model()
    audio = _decode_wav(data)
    if audio.size < model.preprocessor_config.hop_length:
        return ""
    mel = get_logmel(audio, model.preprocessor_config)
    result = model.generate(mel)[0]
    return (getattr(result, "text", "") or "").strip()


@app.post("/inference")
async def inference(file: UploadFile = File(...), prompt: str = Form(default="")):
    data = await file.read(MAX_WAV_BYTES + 1)
    await file.close()
    if len(data) > MAX_WAV_BYTES:
        return JSONResponse({"error": "audio payload too large", "text": ""}, status_code=413)
    try:
        # MLX inference is serialized deliberately; concurrent calls otherwise
        # contend for the same model and increase tail latency. Keep inference
        # on the model-loading thread: MLX stream state is thread-local.
        async with _inference_lock:
            text = _transcribe_bytes(data)
        return JSONResponse({"text": text})
    except Exception as e:  # noqa: BLE001 — return the error like whisper-server would
        _log(f"inference error: {e}")
        return JSONResponse({"error": str(e), "text": ""}, status_code=500)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("PARAKEET_PORT", "8077")))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    args = ap.parse_args()

    global _model_name
    _model_name = args.model

    # Warm the model before serving so the first real chunk doesn't pay load cost.
    get_model()
    _log(f"listening on http://{args.host}:{args.port}/inference")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
