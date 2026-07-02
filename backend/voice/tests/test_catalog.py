"""Catalog install checks + model-path resolution.

`get_model_path` is what `/voice/stt/load` hands to faster-whisper. It must
be the actual on-disk CTranslate2 model directory — handing anything else
(like the parent voice-models dir, as an older revision did) routes
faster-whisper through the HF Hub cache resolver, which does not recognize
our snapshots/main layout and re-downloads the model over the network at
load time.
"""

from __future__ import annotations

import os
from pathlib import Path

from voice.catalog import (
    get_catalog_entry,
    get_model_path,
    is_model_installed,
    model_dir,
)


def _install(voice_dir: str, model_id: str, skip: set[str] | None = None) -> str:
    """Materialize a fake install on disk; returns the model dir."""
    target = model_dir(voice_dir, model_id)
    assert target is not None
    os.makedirs(target, exist_ok=True)
    entry = get_catalog_entry(model_id)
    assert entry is not None
    for fname in entry["check_files"]:
        if skip and fname in skip:
            continue
        Path(target, fname).write_bytes(b"\x01" * 64)
    return target


def test_get_model_path_none_when_not_installed(tmp_path):
    assert get_model_path(str(tmp_path), "faster-whisper-base") is None
    assert get_model_path(str(tmp_path), "kokoro-82m") is None


def test_get_model_path_returns_snapshot_dir_for_stt(tmp_path):
    voice_dir = str(tmp_path)
    target = _install(voice_dir, "faster-whisper-base")

    path = get_model_path(voice_dir, "faster-whisper-base")
    assert path == target
    # The load path relies on this being a directory faster-whisper can load
    # directly (bypassing the HF cache resolver entirely).
    assert path != voice_dir
    assert os.path.isdir(path)
    assert path.endswith(os.path.join("snapshots", "main"))


def test_get_model_path_returns_model_dir_for_tts(tmp_path):
    voice_dir = str(tmp_path)
    target = _install(voice_dir, "kokoro-82m")
    assert get_model_path(voice_dir, "kokoro-82m") == target


def test_whisper_check_files_cover_every_required_file(tmp_path):
    """All four files must be required: loading without tokenizer.json makes
    faster-whisper silently fall back to a *network* tokenizer fetch."""
    entry = get_catalog_entry("faster-whisper-base")
    assert set(entry["check_files"]) == {
        "config.json",
        "model.bin",
        "tokenizer.json",
        "vocabulary.txt",
    }


def test_partial_whisper_install_is_not_installed(tmp_path):
    """model.bin alone (an interrupted download) must not count as installed."""
    voice_dir = str(tmp_path)
    _install(voice_dir, "faster-whisper-base", skip={"tokenizer.json", "vocabulary.txt"})

    assert not is_model_installed(voice_dir, "faster-whisper-base")
    assert get_model_path(voice_dir, "faster-whisper-base") is None
