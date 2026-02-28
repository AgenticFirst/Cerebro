"""HuggingFace model download manager with progress, resume, and cancellation."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any

from .catalog import remove_model_state, set_model_state
from .schemas import DownloadProgressEvent

log = logging.getLogger(__name__)


class DownloadManager:
    """Manages model downloads — one at a time."""

    def __init__(self) -> None:
        self.active_model_id: str | None = None
        self.progress_queue: asyncio.Queue[DownloadProgressEvent] | None = None
        self._cancel_event: threading.Event | None = None
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    @property
    def is_active(self) -> bool:
        return self.active_model_id is not None

    def start(
        self,
        model_id: str,
        catalog_entry: dict[str, Any],
        models_dir: str,
    ) -> None:
        """Start a download in a background thread."""
        self._loop = asyncio.get_event_loop()
        self.active_model_id = model_id
        self.progress_queue = asyncio.Queue()
        self._cancel_event = threading.Event()

        set_model_state(models_dir, model_id, status="downloading")

        self._thread = threading.Thread(
            target=self._download_sync,
            args=(model_id, catalog_entry, models_dir, self.progress_queue, self._cancel_event, self._loop),
            daemon=True,
        )
        self._thread.start()

    def cancel(self) -> None:
        """Request cancellation of the active download.

        Immediately marks the manager as inactive so a new download can start.
        The background thread will finish cleanup using its own captured references.
        """
        if self._cancel_event:
            self._cancel_event.set()
        # Clear active state immediately so is_active returns False
        # and a new download can be started right away.
        self.active_model_id = None
        self._cancel_event = None
        self._thread = None

    @staticmethod
    def _delete_model_file(catalog_entry: dict[str, Any], models_dir: str) -> None:
        """Delete the downloaded model file from disk after cancellation."""
        hf_filename = catalog_entry.get("hf_filename", "")
        if not hf_filename:
            return
        file_path = os.path.join(models_dir, hf_filename)
        try:
            if os.path.exists(file_path):
                os.remove(file_path)
                log.info("Deleted cancelled model file: %s", file_path)
        except OSError as e:
            log.warning("Failed to delete model file %s: %s", file_path, e)

    def _download_sync(
        self,
        model_id: str,
        catalog_entry: dict[str, Any],
        models_dir: str,
        queue: asyncio.Queue[DownloadProgressEvent],
        cancel_event: threading.Event,
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        """Synchronous download running in a background thread.

        All shared state (queue, cancel_event, loop) is passed as arguments
        so this thread is self-contained even if cancel() clears the manager's
        instance variables before we finish.
        """

        def emit(event: DownloadProgressEvent) -> None:
            """Thread-safe push to the asyncio queue."""
            try:
                loop.call_soon_threadsafe(queue.put_nowait, event)
            except RuntimeError:
                pass  # loop closed

        try:
            from huggingface_hub import hf_hub_download

            total_bytes = catalog_entry["size_bytes"]
            hf_repo = catalog_entry["hf_repo"]
            hf_filename = catalog_entry["hf_filename"]

            # Build a tqdm-compatible class that reports progress and checks cancellation
            class _ProgressBar:
                """tqdm-compatible progress bar passed to hf_hub_download."""

                def __init__(self, *args: Any, **kwargs: Any) -> None:
                    self.total: int = kwargs.get("total", total_bytes) or total_bytes
                    self.n: int = kwargs.get("initial", 0)
                    self.disable: bool = kwargs.get("disable", False)
                    self._last_report = time.time()
                    self._last_bytes = self.n

                def update(self, n: int = 1) -> None:
                    self.n += n

                    # Check for cancellation — use BaseException subclass
                    # so hf_hub_download's `except Exception` handlers can't swallow it
                    if cancel_event.is_set():
                        raise _CancelledError()

                    # Throttle progress events to every 300ms
                    now = time.time()
                    elapsed = now - self._last_report
                    if elapsed < 0.3 and self.n < self.total:
                        return

                    speed = (self.n - self._last_bytes) / elapsed if elapsed > 0 else 0
                    eta = (self.total - self.n) / speed if speed > 0 else 0
                    self._last_report = now
                    self._last_bytes = self.n

                    emit(
                        DownloadProgressEvent(
                            status="downloading",
                            downloaded_bytes=self.n,
                            total_bytes=self.total,
                            speed_bps=speed,
                            eta_seconds=eta,
                        )
                    )

                def close(self) -> None:
                    pass

                def set_description(self, *args: Any, **kwargs: Any) -> None:
                    pass

                def set_postfix(self, *args: Any, **kwargs: Any) -> None:
                    pass

                def refresh(self) -> None:
                    pass

                def reset(self, total: int | None = None) -> None:
                    if total is not None:
                        self.total = total
                    self.n = 0

                def __enter__(self) -> _ProgressBar:
                    return self

                def __exit__(self, *args: Any) -> None:
                    self.close()

            file_path = hf_hub_download(
                repo_id=hf_repo,
                filename=hf_filename,
                local_dir=models_dir,
                tqdm_class=_ProgressBar,
            )

            # Check for cancellation after download completed
            # (in case the exception was swallowed)
            if cancel_event.is_set():
                log.info("Download cancelled for %s (post-completion)", model_id)
                self._delete_model_file(catalog_entry, models_dir)
                remove_model_state(models_dir, model_id)
                emit(DownloadProgressEvent(status="cancelled"))
                return

            # Verification
            emit(DownloadProgressEvent(status="verifying"))

            # Update state
            now_str = datetime.now(timezone.utc).isoformat()
            set_model_state(
                models_dir,
                model_id,
                status="downloaded",
                file_path=file_path,
                downloaded_at=now_str,
            )

            log.info("Download completed for %s at %s", model_id, file_path)
            emit(
                DownloadProgressEvent(
                    status="completed",
                    downloaded_bytes=total_bytes,
                    total_bytes=total_bytes,
                    file_path=file_path,
                )
            )

        except _CancelledError:
            log.info("Download cancelled for %s", model_id)
            self._delete_model_file(catalog_entry, models_dir)
            remove_model_state(models_dir, model_id)
            emit(DownloadProgressEvent(status="cancelled"))

        except OSError as e:
            log.error("Download OS error for %s: %s", model_id, e)
            self._delete_model_file(catalog_entry, models_dir)
            remove_model_state(models_dir, model_id)
            if e.errno == 28:  # ENOSPC
                emit(
                    DownloadProgressEvent(
                        status="error",
                        error="Disk full. Free up space and try again.",
                    )
                )
            else:
                emit(DownloadProgressEvent(status="error", error=str(e)))

        except Exception as e:
            log.error("Download error for %s: %s", model_id, e, exc_info=True)
            self._delete_model_file(catalog_entry, models_dir)
            remove_model_state(models_dir, model_id)
            emit(DownloadProgressEvent(status="error", error=str(e)))

        finally:
            # Only clean up manager state if WE are still the active download.
            # If cancel() already cleared it (or a new download started),
            # don't clobber the new state.
            if self.active_model_id == model_id:
                self.active_model_id = None
                self._cancel_event = None
                self._thread = None


class _CancelledError(BaseException):
    """Download cancellation signal.

    Inherits from BaseException (not Exception) so that broad
    ``except Exception`` handlers inside hf_hub_download cannot swallow it.
    """
