"""Acceptance tests for the voice download manager.

The downloader is the gate-keeper for the entire voice feature: every Call
button click depends on it producing a correct ``installed`` state. These
tests pin down the four invariants we care about:

  * Deterministic state transitions — no race produces an inconsistent
    state.json or skips an expected event.
  * Atomic on-disk writes — partial bytes never appear with the final
    filename, even if the download crashes mid-byte.
  * Idempotent ``start()`` — replaying produces the same end state.
  * Single active download — concurrent ``start()`` calls for different
    models reject deterministically; concurrent calls for the *same*
    model deduplicate.

We use ``asyncio.run`` directly to avoid pulling in pytest-asyncio.
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Any, Awaitable, TypeVar

import pytest

from voice.catalog import (
    VOICE_CATALOG,
    get_catalog_entry,
    is_model_installed,
    model_dir,
)
from voice.downloader import VoiceDownloader


T = TypeVar("T")


def run(coro: Awaitable[T]) -> T:
    return asyncio.run(coro)


# ── Fixtures ──────────────────────────────────────────────────────


def _patch_catalog_to_local_files(monkeypatch, tmp_path: Path) -> dict[str, list[tuple[str, str, int]]]:
    """Replace remote URLs with file:// URLs that point at fixture bytes.

    Returns the mapping so tests can assert on file sizes.
    """
    payloads = {
        "faster-whisper-base": [
            ("config.json", b'{"k": "v"}', 9),
            ("model.bin", b"\x00" * 8192, 8192),
            ("tokenizer.json", b"{}", 2),
            ("vocabulary.txt", b"hello\n", 6),
        ],
        "kokoro-82m": [
            ("kokoro-v1.0.onnx", b"\x10" * 16384, 16384),
            ("voices-v1.0.bin", b"\x20" * 4096, 4096),
        ],
    }

    fixture_dir = tmp_path / "_fixtures"
    fixture_dir.mkdir(exist_ok=True)
    new_urls: dict[str, list[tuple[str, str, int]]] = {}
    for model_id, files in payloads.items():
        urls: list[tuple[str, str, int]] = []
        for fname, body, size in files:
            f = fixture_dir / f"{model_id}__{fname}"
            f.write_bytes(body)
            urls.append((fname, f.as_uri(), size))
        new_urls[model_id] = urls

    new_catalog = []
    for entry in VOICE_CATALOG:
        copy = dict(entry)
        if entry["id"] in new_urls:
            copy["urls"] = new_urls[entry["id"]]
            # Shrink expected size so fixtures don't have to be 340 MB.
            copy["size_bytes"] = sum(s for _, _, s in new_urls[entry["id"]])
        new_catalog.append(copy)

    monkeypatch.setattr("voice.catalog.VOICE_CATALOG", new_catalog)
    monkeypatch.setattr("voice.downloader.VOICE_CATALOG", new_catalog)
    return new_urls


@pytest.fixture()
def voice_dir(tmp_path: Path) -> str:
    return str(tmp_path / "voice-models")


@pytest.fixture()
def downloader(voice_dir, monkeypatch, tmp_path) -> VoiceDownloader:
    _patch_catalog_to_local_files(monkeypatch, tmp_path)
    return VoiceDownloader(voice_dir)


# ── Initial state ─────────────────────────────────────────────────


def test_fresh_install_creates_state_json(voice_dir, downloader):
    state_path = os.path.join(voice_dir, "state.json")
    assert os.path.exists(state_path)
    state = json.loads(Path(state_path).read_text())
    for entry in VOICE_CATALOG:
        assert state[entry["id"]]["state"] == "not_installed"


def test_state_reconciles_with_disk_truth(voice_dir, monkeypatch, tmp_path):
    """If a model dir exists with valid check_files, state must report ``installed``,
    even if state.json was never written or has a stale ``not_installed`` entry."""
    _patch_catalog_to_local_files(monkeypatch, tmp_path)
    entry = next(e for e in VOICE_CATALOG if e["id"] == "kokoro-82m")
    target = os.path.join(voice_dir, entry["dir_name"])
    os.makedirs(target, exist_ok=True)
    for fname in entry["check_files"]:
        Path(target, fname).write_bytes(b"\xff" * 1024)

    dl = VoiceDownloader(voice_dir)
    states = dl.get_states()
    assert states["kokoro-82m"]["state"] == "installed"


def test_state_demotes_stale_downloading_to_not_installed(voice_dir, monkeypatch, tmp_path):
    """A ``downloading`` entry on disk means a previous process died mid-flight.
    The next process must not trust it — there's no live worker behind that state."""
    _patch_catalog_to_local_files(monkeypatch, tmp_path)
    os.makedirs(voice_dir, exist_ok=True)
    Path(voice_dir, "state.json").write_text(
        json.dumps({"kokoro-82m": {"state": "downloading", "downloaded_bytes": 999}})
    )
    dl = VoiceDownloader(voice_dir)
    assert dl.get_states()["kokoro-82m"]["state"] == "not_installed"


# ── Happy path ────────────────────────────────────────────────────


def test_full_download_lifecycle_kokoro(voice_dir, downloader):
    async def go():
        result = await downloader.start("kokoro-82m")
        assert result["state"] == "downloading"
        await downloader.wait_idle()

    run(go())

    states = downloader.get_states()
    assert states["kokoro-82m"]["state"] == "installed"
    assert is_model_installed(voice_dir, "kokoro-82m")

    target = model_dir(voice_dir, "kokoro-82m")
    entry = get_catalog_entry("kokoro-82m")
    for fname in entry["check_files"]:
        f = Path(target, fname)
        assert f.exists()
        assert f.stat().st_size > 0
        # No `.part` files left behind.
        assert not Path(target, fname + ".part").exists()


def test_full_download_lifecycle_whisper(voice_dir, downloader):
    async def go():
        await downloader.start("faster-whisper-base")
        await downloader.wait_idle()

    run(go())
    assert is_model_installed(voice_dir, "faster-whisper-base")


# ── Idempotence ───────────────────────────────────────────────────


def test_start_already_installed_is_noop(voice_dir, downloader):
    async def go():
        await downloader.start("kokoro-82m")
        await downloader.wait_idle()
        # Second call: model is installed, must short-circuit to {state: installed}.
        again = await downloader.start("kokoro-82m")
        assert again["state"] == "installed"

    run(go())


def test_start_while_in_flight_for_same_model_returns_downloading(downloader):
    async def go():
        await downloader.start("kokoro-82m")
        second = await downloader.start("kokoro-82m")
        assert second["state"] == "downloading"
        await downloader.wait_idle()

    run(go())


def test_start_while_in_flight_for_different_model_raises(downloader):
    async def go():
        await downloader.start("kokoro-82m")
        with pytest.raises(RuntimeError, match="Another download is in flight"):
            await downloader.start("faster-whisper-base")
        await downloader.wait_idle()

    run(go())


def test_start_unknown_model_raises(downloader):
    async def go():
        with pytest.raises(ValueError, match="Unknown voice model"):
            await downloader.start("does-not-exist")

    run(go())


# ── Failure handling ──────────────────────────────────────────────


def test_failed_download_records_state_and_cleans_partials(
    voice_dir, monkeypatch, tmp_path
):
    """A network failure must leave the model in ``failed`` state with no
    .part files and no half-written real files."""
    _patch_catalog_to_local_files(monkeypatch, tmp_path)
    catalog = list(__import__("voice.catalog", fromlist=["VOICE_CATALOG"]).VOICE_CATALOG)
    bad = []
    for entry in catalog:
        copy = dict(entry)
        if entry["id"] == "kokoro-82m":
            urls = list(entry["urls"])
            urls[0] = (urls[0][0], "file:///nonexistent/path/never.bin", urls[0][2])
            copy["urls"] = urls
        bad.append(copy)
    monkeypatch.setattr("voice.catalog.VOICE_CATALOG", bad)
    monkeypatch.setattr("voice.downloader.VOICE_CATALOG", bad)

    dl = VoiceDownloader(voice_dir)

    async def go():
        await dl.start("kokoro-82m")
        await dl.wait_idle()

    run(go())

    states = dl.get_states()
    assert states["kokoro-82m"]["state"] == "failed"
    assert states["kokoro-82m"]["error"]
    target = model_dir(voice_dir, "kokoro-82m")
    if target and os.path.isdir(target):
        for fname in ("kokoro-v1.0.onnx", "voices-v1.0.bin"):
            assert not os.path.exists(os.path.join(target, fname + ".part"))


def test_retry_after_failure_can_succeed(voice_dir, monkeypatch, tmp_path):
    """After a failure, calling start() again must re-attempt the full
    download (idempotent path: failed → downloading → installed)."""
    _patch_catalog_to_local_files(monkeypatch, tmp_path)

    # First attempt: bad URL forces a failure.
    catalog = list(__import__("voice.catalog", fromlist=["VOICE_CATALOG"]).VOICE_CATALOG)
    bad = []
    for entry in catalog:
        copy = dict(entry)
        if entry["id"] == "kokoro-82m":
            urls = list(entry["urls"])
            urls[0] = (urls[0][0], "file:///nope.bin", urls[0][2])
            copy["urls"] = urls
        bad.append(copy)
    monkeypatch.setattr("voice.catalog.VOICE_CATALOG", bad)
    monkeypatch.setattr("voice.downloader.VOICE_CATALOG", bad)

    dl = VoiceDownloader(voice_dir)

    async def attempt_and_recover():
        await dl.start("kokoro-82m")
        await dl.wait_idle()
        assert dl.get_states()["kokoro-82m"]["state"] == "failed"

        # Restore good URLs and retry.
        _patch_catalog_to_local_files(monkeypatch, tmp_path)
        await dl.start("kokoro-82m")
        await dl.wait_idle()
        assert dl.get_states()["kokoro-82m"]["state"] == "installed"

    run(attempt_and_recover())


# ── SSE event stream ──────────────────────────────────────────────


def test_subscribe_yields_terminal_event_for_already_installed(voice_dir, downloader):
    async def go():
        await downloader.start("kokoro-82m")
        await downloader.wait_idle()
        events: list[dict[str, Any]] = []
        async for event in downloader.subscribe("kokoro-82m"):
            events.append(event)
        return events

    events = run(go())
    assert len(events) == 1
    assert events[0]["state"] == "installed"
    assert events[0]["percent"] == 100.0


def test_subscribe_yields_progression_for_in_flight(voice_dir, downloader):
    async def go():
        await downloader.start("kokoro-82m")
        states_seen: list[str] = []
        async for event in downloader.subscribe("kokoro-82m"):
            states_seen.append(event["state"])
            if event["state"] in ("installed", "failed"):
                break
        return states_seen

    states_seen = run(go())
    assert "downloading" in states_seen
    assert states_seen[-1] == "installed"


# ── State.json atomicity ──────────────────────────────────────────


def test_state_json_is_never_partially_written(voice_dir, downloader):
    """State writes use tmp + rename so a parallel reader never sees half-
    serialized JSON. We assert the .tmp path is gone after a write completes."""

    async def go():
        await downloader.start("kokoro-82m")
        await downloader.wait_idle()

    run(go())
    tmp = os.path.join(voice_dir, "state.json.tmp")
    assert not os.path.exists(tmp)
    state = json.loads(Path(voice_dir, "state.json").read_text())
    assert state["kokoro-82m"]["state"] == "installed"


# ── Reset (test helper) ───────────────────────────────────────────


def test_reset_for_tests_wipes_disk_and_state(voice_dir, downloader):
    async def go():
        await downloader.start("kokoro-82m")
        await downloader.wait_idle()

    run(go())
    assert is_model_installed(voice_dir, "kokoro-82m")

    downloader.reset_for_tests()
    assert not is_model_installed(voice_dir, "kokoro-82m")
    assert downloader.get_states()["kokoro-82m"]["state"] == "not_installed"


# ── Catalog reflects download state ───────────────────────────────


def test_catalog_shows_not_installed_initially(voice_dir, downloader):
    from voice.catalog import get_catalog

    states = downloader.get_states()
    cat = get_catalog(voice_dir, states)
    for m in cat:
        assert m.available is False
        assert m.download_state == "not_installed"


def test_catalog_shows_installed_after_download(voice_dir, downloader):
    from voice.catalog import get_catalog

    async def go():
        await downloader.start("kokoro-82m")
        await downloader.wait_idle()

    run(go())
    cat = get_catalog(voice_dir, downloader.get_states())
    by_id = {m.id: m for m in cat}
    assert by_id["kokoro-82m"].available is True
    assert by_id["kokoro-82m"].download_state == "installed"
    assert by_id["faster-whisper-base"].available is False
    assert by_id["faster-whisper-base"].download_state == "not_installed"
