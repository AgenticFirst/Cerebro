"""Voice model catalog — models are bundled with the app.

No download management needed; models ship in the app's resources.
This module just describes the catalog and checks file presence.
"""

from __future__ import annotations

import os
from typing import Any

from .schemas import VoiceModelInfo


# ── Hardcoded catalog ─────────────────────────────────────────────

VOICE_CATALOG: list[dict[str, Any]] = [
    {
        "id": "faster-whisper-base",
        "name": "Faster Whisper Base",
        "type": "stt",
        "description": "CTranslate2-optimized Whisper — <200ms transcription for short clips",
        "size_bytes": 75_000_000,
        # faster-whisper auto-downloads the CTranslate2 model; the dir is
        # just used as the download cache.  No check_file needed.
        "dir_name": ".",
        "check_file": None,
        "auto_download": True,
    },
    {
        "id": "kokoro-82m",
        "name": "Kokoro 82M",
        "type": "tts",
        "description": "Kokoro StyleTTS2 — 54 voices, 24kHz, non-autoregressive (deterministic)",
        "size_bytes": 340_000_000,
        # Two files in a directory: the ONNX graph and the voices binary.
        "dir_name": "kokoro",
        "check_file": "kokoro-v1.0.onnx",
    },
]


def get_catalog_entry(model_id: str) -> dict[str, Any] | None:
    for entry in VOICE_CATALOG:
        if entry["id"] == model_id:
            return dict(entry)
    return None


def get_model_path(voice_models_dir: str, model_id: str) -> str | None:
    """Return the path to the model files, or None if not found."""
    entry = get_catalog_entry(model_id)
    if not entry:
        return None

    # Auto-download models (e.g. faster-whisper) just need the cache dir
    if entry.get("auto_download"):
        os.makedirs(voice_models_dir, exist_ok=True)
        return voice_models_dir

    model_dir = os.path.join(voice_models_dir, entry["dir_name"])
    check_file = entry.get("check_file")
    if not check_file:
        return model_dir if os.path.isdir(model_dir) else None

    check = os.path.join(model_dir, check_file)
    if not os.path.exists(check):
        return None

    # Both STT and TTS engines load from a directory containing their model
    # files (faster-whisper uses a cache dir, Kokoro uses a dir with the
    # onnx graph + voices binary).
    return model_dir


def get_catalog(voice_models_dir: str) -> list[VoiceModelInfo]:
    """Return all catalog models with availability status."""
    result: list[VoiceModelInfo] = []
    for entry in VOICE_CATALOG:
        model_path = get_model_path(voice_models_dir, entry["id"])
        result.append(
            VoiceModelInfo(
                id=entry["id"],
                name=entry["name"],
                type=entry["type"],
                description=entry["description"],
                size_bytes=entry["size_bytes"],
                available=model_path is not None,
            )
        )
    return result
