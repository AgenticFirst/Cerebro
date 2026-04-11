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
        "id": "orpheus-3b-0.1-ft",
        "name": "Orpheus TTS 3B",
        "type": "tts",
        "description": "Canopy Labs Orpheus — natural speech synthesis with 8 voices and emotion control",
        "size_bytes": 2_200_000_000,
        # Single GGUF file inside a directory
        "dir_name": "orpheus-3b-0.1-ft",
        "check_file": "orpheus-3b-0.1-ft-q4_k_m.gguf",
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

    # STT returns the directory, TTS returns the GGUF file path
    if entry["type"] == "stt":
        return model_dir
    else:
        return os.path.join(model_dir, check_file)


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
