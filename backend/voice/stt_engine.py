"""Speech-to-text engine wrapping faster-whisper (CTranslate2 backend).

faster-whisper is 4-8x faster than openai-whisper on CPU thanks to
CTranslate2 optimizations, int8 quantization, and VAD-based audio
segmentation (only processes speech frames, not silence/padding).

For a 2-second voice clip this typically returns in <0.5 seconds.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import TYPE_CHECKING

import numpy as np

from .schemas import EngineState, TranscriptionResult, TranscriptionSegment

if TYPE_CHECKING:
    from faster_whisper import WhisperModel

logger = logging.getLogger("voice.stt")


class STTEngine:
    def __init__(self) -> None:
        self._model: WhisperModel | None = None
        self._model_id: str | None = None
        self._loading = False
        self._error: str | None = None
        self._lock = asyncio.Lock()

    # ── Properties ────────────────────────────────────────────────

    @property
    def loaded_model_id(self) -> str | None:
        return self._model_id

    @property
    def is_ready(self) -> bool:
        return self._model is not None and not self._loading

    def status(self) -> EngineState:
        if self._error:
            return "error"
        if self._loading:
            return "loading"
        if self._model is not None:
            return "ready"
        return "idle"

    # ── Load / unload ─────────────────────────────────────────────

    async def load_model(self, model_id: str, model_path: str) -> None:
        """Load a faster-whisper model.

        model_path is used as the download/cache directory.  faster-whisper
        will auto-download the CTranslate2-converted model on first use.
        """
        async with self._lock:
            if self._model is not None and self._model_id == model_id:
                return
            if self._model is not None:
                await self.unload()

            self._loading = True
            self._error = None
            try:
                loop = asyncio.get_running_loop()
                self._model = await loop.run_in_executor(
                    None, self._load_sync, model_path
                )
                self._model_id = model_id
            except Exception as exc:
                self._error = str(exc)
                raise
            finally:
                self._loading = False

    def _load_sync(self, model_path: str) -> "WhisperModel":
        from faster_whisper import WhisperModel

        # Use "base" for speed — transcribes short clips in <200ms on CPU.
        # Upgrade to "small" or "medium" if quality is insufficient.
        # model_path serves as the download cache directory.
        model_size = "base"
        logger.info("Loading faster-whisper model '%s' (cache: %s)", model_size, model_path)
        t0 = time.monotonic()

        model = WhisperModel(
            model_size,
            device="cpu",
            compute_type="int8",
            download_root=model_path,
        )

        logger.info("faster-whisper '%s' loaded in %.1fs", model_size, time.monotonic() - t0)
        return model

    async def unload(self) -> None:
        self._model = None
        self._model_id = None
        self._error = None

    # ── Transcription ─────────────────────────────────────────────

    async def transcribe(
        self,
        audio_bytes: bytes,
        sample_rate: int = 16000,
    ) -> TranscriptionResult:
        if self._model is None:
            raise RuntimeError("STT model not loaded")

        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None, self._transcribe_sync, audio_bytes, sample_rate
        )

    def _transcribe_sync(
        self,
        audio_bytes: bytes,
        sample_rate: int,
    ) -> TranscriptionResult:
        assert self._model is not None

        t0 = time.monotonic()

        # Convert PCM int16 bytes → float32 numpy array
        audio_array = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0

        # faster-whisper handles variable-length audio natively — no 30s padding needed.
        # beam_size=1 (greedy) for speed; vad_filter skips silence segments.
        segments_iter, info = self._model.transcribe(
            audio_array,
            beam_size=1,
            vad_filter=True,
            vad_parameters=dict(
                min_silence_duration_ms=300,
            ),
        )

        # Materialize segments
        segments: list[TranscriptionSegment] = []
        text_parts: list[str] = []
        for seg in segments_iter:
            text_parts.append(seg.text.strip())
            segments.append(
                TranscriptionSegment(
                    start=seg.start,
                    end=seg.end,
                    text=seg.text.strip(),
                )
            )

        text = " ".join(text_parts).strip()
        language = info.language or "en"

        elapsed = time.monotonic() - t0
        audio_duration = len(audio_array) / sample_rate
        logger.info(
            "STT transcribe: %.2fs wall, %.1fs audio, lang=%s, text=%s",
            elapsed,
            audio_duration,
            language,
            repr(text[:100]),
        )

        return TranscriptionResult(
            text=text,
            segments=segments,
            language=language,
        )
