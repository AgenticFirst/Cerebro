"""Text-to-speech engine using Kokoro-82M via kokoro-onnx.

Kokoro is a non-autoregressive StyleTTS2-based TTS model: text in,
mel-spectrogram out in a single forward pass. Deterministic output,
no sampling loop, no runaway-generation failure modes.

- ~310 MB ONNX model + 27 MB voices binary
- 54 voices, 24 kHz mono output
- ~1-2 s per sentence on CPU
- Apache 2.0 license
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import AsyncGenerator
from typing import TYPE_CHECKING

import numpy as np

from .schemas import EngineState, SPEAKERS

if TYPE_CHECKING:
    from kokoro_onnx import Kokoro

logger = logging.getLogger("voice.tts")

# Map Cerebro's external speaker names to Kokoro voice IDs.
# af_* = American Female, am_* = American Male.
_VOICE_MAP: dict[str, str] = {
    "tara": "af_heart",
    "leah": "af_bella",
    "jess": "af_sarah",
    "mia":  "af_nicole",
    "zoe":  "af_alloy",
    "leo":  "am_michael",
    "dan":  "am_adam",
    "zac":  "am_puck",
}
_DEFAULT_VOICE = "af_heart"

_SAMPLE_RATE = 24000


class TTSEngine:
    def __init__(self) -> None:
        self._model: Kokoro | None = None
        self._model_id: str | None = None
        self._loading = False
        self._error: str | None = None
        self._lock = asyncio.Lock()
        self._synth_lock = asyncio.Lock()

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

    async def load_model(self, model_id: str, model_path: str) -> None:
        """Load Kokoro. `model_path` is either the directory containing
        `kokoro-v1.0.onnx` + `voices-v1.0.bin`, or the onnx file itself
        (we walk up to the directory)."""
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

    def _load_sync(self, model_path: str):
        from kokoro_onnx import Kokoro

        model_dir = model_path if os.path.isdir(model_path) else os.path.dirname(model_path)
        onnx_path = os.path.join(model_dir, "kokoro-v1.0.onnx")
        voices_path = os.path.join(model_dir, "voices-v1.0.bin")

        if not os.path.exists(onnx_path):
            raise RuntimeError(f"Kokoro ONNX model not found at {onnx_path}")
        if not os.path.exists(voices_path):
            raise RuntimeError(f"Kokoro voices not found at {voices_path}")

        t0 = time.monotonic()
        model = Kokoro(onnx_path, voices_path)
        logger.info(
            "Kokoro loaded from %s (%d voices, %.0fms)",
            model_dir, len(model.get_voices()), (time.monotonic() - t0) * 1000,
        )
        return model

    async def unload(self) -> None:
        self._model = None
        self._model_id = None
        self._error = None

    async def synthesize_stream(
        self,
        text: str,
        speaker: str = "tara",
    ) -> AsyncGenerator[bytes, None]:
        """Yield PCM int16 audio (24 kHz mono) for the given text.

        Kokoro is one-shot, so this yields exactly one chunk per call.
        Kept as an async generator so the router's SSE streaming path
        can iterate it uniformly.
        """
        if self._model is None:
            raise RuntimeError("TTS model not loaded")
        if speaker not in SPEAKERS:
            raise ValueError(f"Unknown speaker: {speaker}. Choose from: {SPEAKERS}")

        voice = _VOICE_MAP.get(speaker, _DEFAULT_VOICE)

        async with self._synth_lock:
            loop = asyncio.get_running_loop()
            pcm_bytes = await loop.run_in_executor(
                None, self._synthesize_sync, text, voice
            )
            if pcm_bytes:
                yield pcm_bytes

    def _synthesize_sync(self, text: str, voice: str) -> bytes:
        assert self._model is not None
        t0 = time.monotonic()
        samples, sample_rate = self._model.create(
            text, voice=voice, speed=1.0, lang="en-us"
        )
        # samples: float32 in [-1, 1] → int16 PCM
        pcm_int16 = (samples * 32767).clip(-32768, 32767).astype(np.int16)
        elapsed = time.monotonic() - t0
        duration = len(samples) / sample_rate
        logger.info(
            "TTS: gen=%.0fms audio=%.2fs voice=%s text=%s",
            elapsed * 1000, duration, voice, repr(text[:80]),
        )
        return pcm_int16.tobytes()
