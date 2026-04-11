#!/usr/bin/env bash
# Setup voice models for Cerebro development.
# Called automatically by npm install (postinstall hook).
# Downloads Whisper STT (~1.5 GB) and Orpheus TTS (~1.8 GB).

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VOICE_DIR="$PROJECT_ROOT/voice-models"
VENV_PYTHON="$PROJECT_ROOT/backend/venv/bin/python"

# Check if models already exist
ALL_OK=1

if [ ! -f "$VOICE_DIR/whisper-large-v3-turbo/large-v3-turbo.pt" ]; then
    ALL_OK=0
else
    echo "[voice] Whisper model already present — skipping"
fi

if [ ! -f "$VOICE_DIR/orpheus-3b-0.1-ft/orpheus-3b-0.1-ft-q4_k_m.gguf" ]; then
    ALL_OK=0
else
    echo "[voice] Orpheus model already present — skipping"
fi

if [ ! -f "$VOICE_DIR/snac-24khz/pytorch_model.bin" ]; then
    ALL_OK=0
else
    echo "[voice] SNAC codec already present — skipping"
fi

if [ "$ALL_OK" -eq 1 ]; then
    echo "[voice] All voice models ready"
    exit 0
fi

# Check for Python venv
if [ ! -f "$VENV_PYTHON" ]; then
    echo "[voice] Python venv not found at $VENV_PYTHON — skipping model download"
    echo "[voice] Run: cd backend && python3 -m venv venv && venv/bin/pip install -r requirements.txt"
    echo "[voice] Then: python scripts/download-voice-models.py"
    exit 0
fi

echo "[voice] Downloading voice models (~3.3 GB total)..."
"$VENV_PYTHON" "$SCRIPT_DIR/download-voice-models.py"
echo "[voice] Voice model setup complete"
