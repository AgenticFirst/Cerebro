"""First-launch auto-download of the default voice models.

Uses the same file:// fixture catalog as test_downloader.py — no network.
"""

from __future__ import annotations

import asyncio
import time
from typing import Awaitable, TypeVar

import pytest

from voice import autodownload
from voice.autodownload import DEFAULT_MODEL_IDS, ensure_default_models
from voice.catalog import is_model_installed
from voice.downloader import VoiceDownloader

from .test_downloader import _patch_catalog_to_local_files


T = TypeVar("T")


def run(coro: Awaitable[T]) -> T:
    return asyncio.run(coro)


@pytest.fixture()
def voice_dir(tmp_path) -> str:
    return str(tmp_path / "voice-models")


@pytest.fixture()
def downloader(voice_dir, monkeypatch, tmp_path) -> VoiceDownloader:
    _patch_catalog_to_local_files(monkeypatch, tmp_path)
    monkeypatch.setattr(autodownload, "_POLL_SECONDS", 0.01)
    return VoiceDownloader(voice_dir)


def test_default_ids_stt_first():
    """STT must come first — voice-note transcription is the feature users
    hit before TTS, and the downloader only runs one download at a time."""
    assert DEFAULT_MODEL_IDS[0] == "faster-whisper-base"
    assert "kokoro-82m" in DEFAULT_MODEL_IDS


def test_installs_all_default_models_in_order(voice_dir, downloader, monkeypatch):
    started: list[str] = []
    original_start = downloader.start

    async def recording_start(model_id: str):
        started.append(model_id)
        return await original_start(model_id)

    monkeypatch.setattr(downloader, "start", recording_start)

    run(ensure_default_models(downloader))

    assert started == list(DEFAULT_MODEL_IDS)
    for model_id in DEFAULT_MODEL_IDS:
        assert is_model_installed(voice_dir, model_id)


def test_skips_already_installed_models(voice_dir, downloader):
    async def go():
        await downloader.start("faster-whisper-base")
        await downloader.wait_idle()
        await ensure_default_models(downloader)

    run(go())
    for model_id in DEFAULT_MODEL_IDS:
        assert is_model_installed(voice_dir, model_id)


def test_never_fights_a_user_initiated_download(voice_dir, downloader, monkeypatch):
    """If the user kicked off their own download from Settings, the whisper
    start() raises RuntimeError — auto-download must skip it (not crash) and
    still wait its turn for the models it can process."""

    real_fetch = VoiceDownloader._fetch_one

    def slow_fetch(url: str, part_path: str, final_path: str) -> None:
        time.sleep(0.2)
        real_fetch(url, part_path, final_path)

    monkeypatch.setattr(VoiceDownloader, "_fetch_one", staticmethod(slow_fetch))

    async def go():
        # User starts kokoro from Settings → Voice…
        await downloader.start("kokoro-82m")
        # …then the first-launch task runs: whisper start raises (different
        # model in flight) → skipped; kokoro start returns "downloading"
        # (same id) → waited on.
        await ensure_default_models(downloader)

    run(go())
    assert is_model_installed(voice_dir, "kokoro-82m")
    assert not is_model_installed(voice_dir, "faster-whisper-base")
