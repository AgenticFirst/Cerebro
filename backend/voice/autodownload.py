"""First-launch background install of the default voice models.

Kicked off from the FastAPI lifespan as a fire-and-forget task so voice
notes (STT) and voice replies (TTS) work out of the box. Never gates
startup: the server is fully responsive while this runs.

Ordering matters — the STT model downloads first so voice-note
transcription becomes available as early as possible; the (larger) TTS
model follows.
"""

from __future__ import annotations

import asyncio
import logging

from .downloader import VoiceDownloader

logger = logging.getLogger("voice.autodownload")

# STT first: transcription is the feature users hit first (voice notes
# from Slack/WhatsApp/Telegram); Kokoro TTS is bigger and less urgent.
DEFAULT_MODEL_IDS = ("faster-whisper-base", "kokoro-82m")

_POLL_SECONDS = 2.0


async def ensure_default_models(downloader: VoiceDownloader) -> None:
    """Best-effort, idempotent: install the default models one at a time.

    Already-installed models are skipped. If the user kicked off their own
    download from Settings → Voice (the downloader allows one active
    download), we skip rather than fight it. A cancelled or failed download
    is left alone — the user can retry from Settings; the next app launch
    will also retry.
    """
    for model_id in DEFAULT_MODEL_IDS:
        try:
            result = await downloader.start(model_id)
        except RuntimeError:
            # A different model is already downloading (user-initiated).
            logger.info("auto-download: another download in flight, skipping %s", model_id)
            continue
        except ValueError:
            logger.warning("auto-download: unknown model id %s", model_id)
            continue

        if result.get("state") == "installed":
            logger.info("auto-download: %s already installed", model_id)
            continue

        logger.info("auto-download: downloading %s…", model_id)
        # Poll state.json (reconciled with disk) instead of subscribe():
        # polling can't miss the terminal event if the run finishes between
        # start() and our first check, and one active download means the
        # single-download invariant is respected for the next model.
        while True:
            await asyncio.sleep(_POLL_SECONDS)
            state = downloader.get_states().get(model_id, {}).get("state")
            if state != "downloading":
                break

        if state == "installed":
            logger.info("auto-download: %s installed", model_id)
        else:
            logger.warning("auto-download: %s ended in state %s", model_id, state)
