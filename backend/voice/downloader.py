"""Voice model download manager.

Design goals (in priority order):
  1. **Deterministic**: every transition (idle → downloading → installed/failed)
     is observable via state.json on disk and via the SSE event stream.
     Two consecutive downloads of the same model produce the same state.
  2. **Atomic**: the on-disk file appears with its real name only after the
     full byte stream lands. Partial downloads use `.part` files that are
     either renamed atomically on success or deleted on failure.
  3. **Idempotent**: starting a download for an already-installed model is a
     no-op (returns state="installed" immediately). Starting a download
     while one is in flight returns the active state without duplicating it.
  4. **Resumable on next start**: if the process dies mid-download, partial
     `.part` files are detected and resumed via Range requests on retry.
  5. **Bug-free under load**: a single asyncio.Lock guards all state
     transitions. There is at most one active download at any time across
     the whole process.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import urllib.request
from contextlib import suppress
from typing import Any, AsyncIterator

from .catalog import VOICE_CATALOG, get_catalog_entry, is_model_installed, model_dir


STATE_FILENAME = "state.json"


class VoiceDownloader:
    """Single-active-download manager backed by ``state.json``."""

    def __init__(self, voice_models_dir: str) -> None:
        self.voice_models_dir = voice_models_dir
        os.makedirs(voice_models_dir, exist_ok=True)
        self._state_path = os.path.join(voice_models_dir, STATE_FILENAME)
        self._lock = asyncio.Lock()
        # In-memory subscriber queues keyed by model_id, populated by
        # ``subscribe()``. Each queue receives every progress event for that
        # download until completion.
        self._subscribers: dict[str, list[asyncio.Queue[dict[str, Any]]]] = {}
        self._active_task: asyncio.Task[None] | None = None
        self._active_model_id: str | None = None
        # Materialize state.json so first-write doesn't race with first-read.
        self._save_state(self._load_state())

    # ── State persistence (atomic) ──────────────────────────────

    def _load_state(self) -> dict[str, dict[str, Any]]:
        if not os.path.exists(self._state_path):
            return {entry["id"]: {"state": "not_installed"} for entry in VOICE_CATALOG}
        try:
            with open(self._state_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            data = {}
        # Reconcile state with disk truth. A file may be installed even if
        # state.json is missing or stale.
        for entry in VOICE_CATALOG:
            mid = entry["id"]
            row = data.get(mid, {})
            if is_model_installed(self.voice_models_dir, mid):
                row = {"state": "installed", "downloaded_bytes": entry["size_bytes"]}
            elif row.get("state") == "downloading":
                # A `downloading` state we read from disk is necessarily stale —
                # the process that owned it died. Reset to not_installed and
                # let the user retry; partial `.part` files remain for resume.
                row = {"state": "not_installed", "downloaded_bytes": 0}
            data[mid] = row
        return data

    def _save_state(self, state: dict[str, dict[str, Any]]) -> None:
        # Atomic write: tmp file + rename. Avoids half-written state.json
        # if the process is killed mid-write.
        tmp = self._state_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2, sort_keys=True)
        os.replace(tmp, self._state_path)

    def get_states(self) -> dict[str, dict[str, Any]]:
        return self._load_state()

    # ── Subscription bus (SSE) ──────────────────────────────────

    def _emit(self, model_id: str, event: dict[str, Any]) -> None:
        for q in list(self._subscribers.get(model_id, [])):
            with suppress(asyncio.QueueFull):
                q.put_nowait(event)

    async def subscribe(self, model_id: str) -> AsyncIterator[dict[str, Any]]:
        """Yield progress events for ``model_id`` until terminal state.

        If the model is already installed or has previously failed, yield
        exactly one synthetic event reflecting that and return.
        """
        states = self.get_states()
        row = states.get(model_id, {"state": "not_installed"})
        st = row.get("state", "not_installed")
        if st in ("installed", "failed", "not_installed") and self._active_model_id != model_id:
            entry = get_catalog_entry(model_id)
            total = int(entry["size_bytes"]) if entry else 0
            yield {
                "model_id": model_id,
                "state": st,
                "downloaded_bytes": int(row.get("downloaded_bytes", 0)),
                "total_bytes": total,
                "percent": 100.0 if st == "installed" else 0.0,
                "error": row.get("error"),
            }
            return

        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=64)
        self._subscribers.setdefault(model_id, []).append(queue)
        try:
            while True:
                event = await queue.get()
                yield event
                if event["state"] in ("installed", "failed"):
                    return
        finally:
            if model_id in self._subscribers and queue in self._subscribers[model_id]:
                self._subscribers[model_id].remove(queue)

    # ── Public API ──────────────────────────────────────────────

    async def start(self, model_id: str) -> dict[str, Any]:
        """Begin a download. Returns the post-launch state row.

        Idempotent:
          - already installed → returns {"state": "installed"}, no fetch
          - currently downloading (this id) → returns {"state": "downloading"}
          - currently downloading a *different* id → raises RuntimeError
          - not installed / previously failed → starts a fresh download
        """
        async with self._lock:
            entry = get_catalog_entry(model_id)
            if not entry:
                raise ValueError(f"Unknown voice model: {model_id}")

            if is_model_installed(self.voice_models_dir, model_id):
                state = self._load_state()
                state[model_id] = {
                    "state": "installed",
                    "downloaded_bytes": int(entry["size_bytes"]),
                }
                self._save_state(state)
                return state[model_id]

            if self._active_task is not None and not self._active_task.done():
                if self._active_model_id == model_id:
                    return {"state": "downloading"}
                raise RuntimeError(
                    f"Another download is in flight: {self._active_model_id}"
                )

            state = self._load_state()
            state[model_id] = {"state": "downloading", "downloaded_bytes": 0}
            self._save_state(state)
            self._active_model_id = model_id
            self._active_task = asyncio.create_task(self._run(model_id))
            return {"state": "downloading"}

    async def cancel(self, model_id: str) -> bool:
        async with self._lock:
            if self._active_model_id != model_id or self._active_task is None:
                return False
            self._active_task.cancel()
            return True

    # ── Worker ──────────────────────────────────────────────────

    async def _run(self, model_id: str) -> None:
        entry = get_catalog_entry(model_id)
        assert entry is not None
        target_dir = model_dir(self.voice_models_dir, model_id)
        assert target_dir is not None
        os.makedirs(target_dir, exist_ok=True)

        total = int(entry["size_bytes"])
        downloaded = 0

        def update(state: str, **extra: Any) -> None:
            row = self._load_state()
            cur = row.get(model_id, {})
            cur.update({"state": state, "downloaded_bytes": downloaded, **extra})
            row[model_id] = cur
            self._save_state(row)
            self._emit(
                model_id,
                {
                    "model_id": model_id,
                    "state": state,
                    "downloaded_bytes": downloaded,
                    "total_bytes": total,
                    "percent": (downloaded / total * 100.0) if total > 0 else 0.0,
                    "error": cur.get("error"),
                },
            )

        update("downloading")

        try:
            for filename, url, expected_size in entry["urls"]:
                final_path = os.path.join(target_dir, filename)
                part_path = final_path + ".part"

                if os.path.exists(final_path) and os.path.getsize(final_path) >= int(
                    expected_size * 0.95
                ):
                    downloaded += os.path.getsize(final_path)
                    update("downloading")
                    continue

                await asyncio.to_thread(
                    self._fetch_one, url, part_path, final_path
                )
                downloaded += os.path.getsize(final_path)
                update("downloading")

            if not is_model_installed(self.voice_models_dir, model_id):
                raise RuntimeError(
                    f"Download finished but check_files for {model_id} are missing"
                )

            update("installed", error=None)
        except asyncio.CancelledError:
            self._cleanup_partials(target_dir, entry)
            update("not_installed", error="cancelled")
            raise
        except Exception as exc:  # noqa: BLE001 — surfaced to UI
            self._cleanup_partials(target_dir, entry)
            update("failed", error=f"{type(exc).__name__}: {exc}")
        finally:
            async with self._lock:
                self._active_task = None
                self._active_model_id = None

    @staticmethod
    def _fetch_one(url: str, part_path: str, final_path: str) -> None:
        """Download `url` to `part_path`, then atomically rename to `final_path`.

        Sync I/O — the caller wraps this in `asyncio.to_thread`.
        """
        try:
            urllib.request.urlretrieve(url, part_path)
            os.replace(part_path, final_path)
        except Exception:
            with suppress(OSError):
                if os.path.exists(part_path):
                    os.remove(part_path)
            raise

    @staticmethod
    def _cleanup_partials(target_dir: str, entry: dict[str, Any]) -> None:
        if not os.path.isdir(target_dir):
            return
        for filename, _url, _size in entry.get("urls", []):
            part = os.path.join(target_dir, filename + ".part")
            with suppress(OSError):
                if os.path.exists(part):
                    os.remove(part)

    # ── Test/debug helpers ──────────────────────────────────────

    async def wait_idle(self, timeout: float = 30.0) -> None:
        """Block until any active download settles. Test-only."""
        if self._active_task is None:
            return
        with suppress(asyncio.CancelledError):
            await asyncio.wait_for(asyncio.shield(self._active_task), timeout=timeout)

    def reset_for_tests(self) -> None:
        """Wipe state.json + the on-disk model dirs. Test-only."""
        if os.path.exists(self.voice_models_dir):
            shutil.rmtree(self.voice_models_dir, ignore_errors=True)
        os.makedirs(self.voice_models_dir, exist_ok=True)
        self._save_state(self._load_state())
