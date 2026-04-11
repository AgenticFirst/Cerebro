#!/usr/bin/env bash
# Setup voice models for Cerebro development.
# Called automatically by npm install (postinstall hook).
# Downloads Kokoro TTS (~340 MB). Whisper STT auto-downloads at runtime.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VOICE_DIR="$PROJECT_ROOT/voice-models"
VENV_PYTHON="$PROJECT_ROOT/backend/venv/bin/python"

# Check if Kokoro model already exists
if [ -f "$VOICE_DIR/kokoro/kokoro-v1.0.onnx" ] && [ -f "$VOICE_DIR/kokoro/voices-v1.0.bin" ]; then
    echo "[voice] Kokoro TTS model already present — skipping"
    exit 0
fi

# Check for Python venv
if [ ! -f "$VENV_PYTHON" ]; then
    echo "[voice] Python venv not found at $VENV_PYTHON — skipping model download"
    echo "[voice] Run: cd backend && python3 -m venv venv && venv/bin/pip install -r requirements.txt"
    echo "[voice] Then: python scripts/download-voice-models.py"
    exit 0
fi

echo "[voice] Downloading Kokoro TTS model (~340 MB)..."
"$VENV_PYTHON" "$SCRIPT_DIR/download-voice-models.py"
echo "[voice] Voice model setup complete"
