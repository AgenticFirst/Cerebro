"""Voice model catalog + on-disk presence checks.

Models are no longer bundled with the app. They're downloaded on demand
into the user-data directory the first time the user enables voice in
Settings → Voice. See ``downloader.py`` for the download pipeline.
"""

from __future__ import annotations

import os
from typing import Any

from .schemas import DownloadState, VoiceModelInfo


# ── Hardcoded catalog ─────────────────────────────────────────────
#
# `urls` is the list of (filename, public_url, expected_size_bytes) tuples
# that the downloader fetches into <voice_models_dir>/<dir_name>/. The
# downloader writes to a `.part` file and atomically renames on success.
#
# `check_files` are the filenames whose presence indicates a complete
# install. For Whisper we let faster-whisper auto-download on first use,
# so we just check the cache dir exists with the expected snapshot.

KOKORO_RELEASE = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
)
WHISPER_BASE_HF = "https://huggingface.co/Systran/faster-whisper-base/resolve/main"

VOICE_CATALOG: list[dict[str, Any]] = [
    {
        "id": "faster-whisper-base",
        "name": "Faster Whisper Base",
        "type": "stt",
        "description": "CTranslate2-optimized Whisper — <200ms transcription for short clips",
        "size_bytes": 145_000_000,
        "dir_name": "models--Systran--faster-whisper-base",
        # Files placed inside <dir_name>/snapshots/main/ to mimic the HF cache
        # layout that faster-whisper expects.
        "snapshot_subdir": "snapshots/main",
        "urls": [
            ("config.json", f"{WHISPER_BASE_HF}/config.json", 2_000),
            ("model.bin", f"{WHISPER_BASE_HF}/model.bin", 145_000_000),
            ("tokenizer.json", f"{WHISPER_BASE_HF}/tokenizer.json", 2_500_000),
            ("vocabulary.txt", f"{WHISPER_BASE_HF}/vocabulary.txt", 460_000),
        ],
        "check_files": ["model.bin"],
    },
    {
        "id": "kokoro-82m",
        "name": "Kokoro 82M",
        "type": "tts",
        "description": "Kokoro StyleTTS2 — 54 voices, 24kHz, non-autoregressive (deterministic)",
        "size_bytes": 340_000_000,
        "dir_name": "kokoro",
        "snapshot_subdir": "",
        "urls": [
            ("kokoro-v1.0.onnx", f"{KOKORO_RELEASE}/kokoro-v1.0.onnx", 310_000_000),
            ("voices-v1.0.bin", f"{KOKORO_RELEASE}/voices-v1.0.bin", 27_000_000),
        ],
        "check_files": ["kokoro-v1.0.onnx", "voices-v1.0.bin"],
    },
]


def get_catalog_entry(model_id: str) -> dict[str, Any] | None:
    for entry in VOICE_CATALOG:
        if entry["id"] == model_id:
            return dict(entry)
    return None


def model_dir(voice_models_dir: str, model_id: str) -> str | None:
    entry = get_catalog_entry(model_id)
    if not entry:
        return None
    base = os.path.join(voice_models_dir, entry["dir_name"])
    sub = entry.get("snapshot_subdir") or ""
    return os.path.join(base, sub) if sub else base


def is_model_installed(voice_models_dir: str, model_id: str) -> bool:
    """True iff every required check_file is present and non-empty."""
    target_dir = model_dir(voice_models_dir, model_id)
    if not target_dir or not os.path.isdir(target_dir):
        return False
    entry = get_catalog_entry(model_id)
    if not entry:
        return False
    for fname in entry.get("check_files", []):
        path = os.path.join(target_dir, fname)
        if not os.path.exists(path) or os.path.getsize(path) == 0:
            return False
    return True


def get_model_path(voice_models_dir: str, model_id: str) -> str | None:
    """Return the dir the engine should load from, or None if not installed."""
    if not is_model_installed(voice_models_dir, model_id):
        return None
    # STT engine wants the parent voice_models_dir (HF cache layout) so
    # faster-whisper resolves snapshots/main/ itself.
    entry = get_catalog_entry(model_id)
    if entry and entry["type"] == "stt":
        return voice_models_dir
    return model_dir(voice_models_dir, model_id)


def get_catalog(
    voice_models_dir: str,
    download_states: dict[str, dict[str, Any]] | None = None,
) -> list[VoiceModelInfo]:
    """Return all catalog models with availability + download status."""
    states = download_states or {}
    result: list[VoiceModelInfo] = []
    for entry in VOICE_CATALOG:
        installed = is_model_installed(voice_models_dir, entry["id"])
        st = states.get(entry["id"], {})
        download_state: DownloadState = (
            "installed"
            if installed
            else st.get("state", "not_installed")
        )
        result.append(
            VoiceModelInfo(
                id=entry["id"],
                name=entry["name"],
                type=entry["type"],
                description=entry["description"],
                size_bytes=entry["size_bytes"],
                available=installed,
                download_state=download_state,
                downloaded_bytes=int(st.get("downloaded_bytes", 0)),
                error=st.get("error"),
            )
        )
    return result
