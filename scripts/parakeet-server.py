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
import os
import sys
import tempfile

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse
import uvicorn

DEFAULT_MODEL = os.environ.get("PARAKEET_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")

app = FastAPI()
_model = None
_model_name = DEFAULT_MODEL


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
    return JSONResponse({"status": "ok", "model": _model_name, "engine": "parakeet-mlx"})


@app.post("/inference")
async def inference(file: UploadFile = File(...), prompt: str = Form(default="")):
    data = await file.read()
    # parakeet-mlx loads audio from a path; write the chunk to a temp WAV.
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        result = get_model().transcribe(tmp_path)
        text = getattr(result, "text", "") or ""
        return JSONResponse({"text": text.strip()})
    except Exception as e:  # noqa: BLE001 — return the error like whisper-server would
        _log(f"inference error: {e}")
        return JSONResponse({"error": str(e), "text": ""}, status_code=500)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


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
