"""Text-to-speech engine wrapping Orpheus TTS via llama-cpp-python.

Orpheus uses a LLaMA backbone to generate discrete audio tokens that are
decoded to PCM via the SNAC codec.  This engine handles the full pipeline:
text → token IDs → llama.cpp inference → SNAC decode → PCM int16 chunks.

Reference implementations used to validate this implementation:
- canopyai/Orpheus-TTS (canonical decoder)
- Zuellni/Orpheus-GGUF (llama-cpp token-ID approach)
- freddyaboulton/orpheus-cpp
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import AsyncGenerator
from typing import TYPE_CHECKING

from .schemas import EngineState, SPEAKERS

if TYPE_CHECKING:
    from llama_cpp import Llama

logger = logging.getLogger("voice.tts")

# Orpheus special token IDs (verified against orpheus-3b-0.1-ft-q4_k_m.gguf).
# Prompt format: <|audio|>{voice}: {text}<|eot_id|><custom_token_4>
_AUDIO_START_MARKER = 156939   # <|audio|>
_EOT                = 128009   # <|eot_id|>
_END_OF_HUMAN       = 128260   # <custom_token_4>
_END_OF_SPEECH      = 128258   # end-of-audio signal
_AUDIO_TOKEN_BASE   = 128266   # first audio-code token

# SNAC frame layout: 7 codes per frame, 3 codebook layers.
# Positions within a frame are stacked 4096 apart in the Orpheus token space.
#   [L0, L1a, L2a, L2b, L1b, L2c, L2d]
_SNAC_CODES_PER_FRAME = 7
_POSITION_OFFSETS = [0, 4096, 8192, 12288, 16384, 20480, 24576]

# Each SNAC frame ≈ 85ms (2048 samples at 24kHz). 6 frames ≈ 510ms —
# a good latency/context tradeoff for streaming.
_CHUNK_FRAMES = 6


class TTSEngine:
    def __init__(self) -> None:
        self._model: Llama | None = None
        self._model_id: str | None = None
        self._loading = False
        self._error: str | None = None
        self._lock = asyncio.Lock()
        self._snac_model = None
        self._snac_device: str = "cpu"
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
        async with self._lock:
            if self._model is not None and self._model_id == model_id:
                return
            if self._model is not None:
                await self.unload()

            self._loading = True
            self._error = None
            try:
                loop = asyncio.get_running_loop()
                self._model, self._snac_model, self._snac_device = (
                    await loop.run_in_executor(None, self._load_sync, model_path)
                )
                self._model_id = model_id
            except Exception as exc:
                self._error = str(exc)
                raise
            finally:
                self._loading = False

    def _load_sync(self, model_path: str) -> tuple:
        from llama_cpp import Llama
        import torch
        from snac import SNAC

        model = Llama(
            model_path=model_path,
            n_ctx=8192,
            n_gpu_layers=-1,
            verbose=False,
        )

        device = "mps" if torch.backends.mps.is_available() else "cpu"

        snac_dir = os.path.join(os.path.dirname(os.path.dirname(model_path)), "snac-24khz")
        if os.path.isdir(snac_dir):
            logger.info("SNAC loaded from bundled directory: %s", snac_dir)
            snac = SNAC.from_pretrained(snac_dir)
        else:
            logger.warning(
                "Bundled SNAC dir not found at %s — attempting HuggingFace download",
                snac_dir,
            )
            try:
                snac = SNAC.from_pretrained("hubertsiuzdak/snac_24khz")
                logger.info("SNAC loaded from HuggingFace")
            except Exception:
                logger.exception("SNAC HuggingFace download failed")
                raise RuntimeError(
                    f"SNAC codec not found at {snac_dir} and HuggingFace download failed"
                )

        snac = snac.to(device).eval()
        logger.info("TTS model loaded: %s  SNAC on %s", model_path, device)
        return model, snac, device

    async def unload(self) -> None:
        self._model = None
        self._snac_model = None
        self._model_id = None
        self._error = None

    async def synthesize_stream(
        self,
        text: str,
        speaker: str = "tara",
    ) -> AsyncGenerator[bytes, None]:
        """Yield PCM int16 audio chunks (24 kHz mono) as they are generated."""
        if self._model is None:
            raise RuntimeError("TTS model not loaded")
        if speaker not in SPEAKERS:
            raise ValueError(f"Unknown speaker: {speaker}. Choose from: {SPEAKERS}")

        async with self._synth_lock:
            loop = asyncio.get_running_loop()
            queue: asyncio.Queue[bytes | None] = asyncio.Queue()

            def _generate() -> None:
                try:
                    self._generate_sync(text, speaker, queue, loop)
                except Exception:
                    logger.exception("TTS generation failed for text: %s", text[:200])
                    loop.call_soon_threadsafe(queue.put_nowait, None)

            loop.run_in_executor(None, _generate)

            while True:
                chunk = await queue.get()
                if chunk is None:
                    break
                yield chunk

    def _build_prompt_tokens(self, text: str, speaker: str) -> list[int]:
        """Build Orpheus prompt: <|audio|>{voice}: {text}<|eot_id|><custom_token_4>.

        The model auto-generates start_of_ai/start_of_speech after this —
        pre-providing them causes audio for the wrong content.
        """
        assert self._model is not None
        voice_text = f"{speaker}: {text}"
        text_ids = list(
            self._model.tokenize(voice_text.encode("utf-8"), add_bos=False, special=False)
        )
        return [_AUDIO_START_MARKER] + text_ids + [_EOT, _END_OF_HUMAN]

    def _generate_sync(
        self,
        text: str,
        speaker: str,
        queue: asyncio.Queue[bytes | None],
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        assert self._model is not None
        assert self._snac_model is not None

        prompt_tokens = self._build_prompt_tokens(text, speaker)
        t0 = time.monotonic()
        total_tokens = 0
        audio_codes: list[int] = []
        pcm_chunks_emitted = 0
        next_chunk_start = 0
        chunk_size_codes = _CHUNK_FRAMES * _SNAC_CODES_PER_FRAME
        eos_token = self._model.token_eos()

        logger.info(
            "TTS generating: %d prompt tokens, speaker=%s, text=%s",
            len(prompt_tokens), speaker, repr(text[:100]),
        )

        for token_id in self._model.generate(
            prompt_tokens,
            top_k=40,
            top_p=0.9,
            temp=0.6,
            repeat_penalty=1.1,
            reset=True,
        ):
            total_tokens += 1

            if token_id == _END_OF_SPEECH or token_id == eos_token:
                break
            if total_tokens > 4096:
                logger.warning("TTS: hit token limit (4096)")
                break

            if 128256 <= token_id < _AUDIO_TOKEN_BASE:
                continue

            if token_id >= _AUDIO_TOKEN_BASE:
                position = len(audio_codes) % _SNAC_CODES_PER_FRAME
                snac_code = token_id - _AUDIO_TOKEN_BASE - _POSITION_OFFSETS[position]

                if not (0 <= snac_code <= 4095):
                    logger.warning(
                        "TTS: invalid SNAC code %d at position %d (token=%d)",
                        snac_code, position, token_id,
                    )
                    continue

                audio_codes.append(snac_code)

                if len(audio_codes) - next_chunk_start >= chunk_size_codes:
                    chunk_end = next_chunk_start + chunk_size_codes
                    pcm = self._decode_chunk(audio_codes[next_chunk_start:chunk_end])
                    if pcm:
                        pcm_chunks_emitted += 1
                        loop.call_soon_threadsafe(queue.put_nowait, pcm)
                    next_chunk_start = chunk_end

            elif len(audio_codes) > 0:
                break

        remaining_frames = (len(audio_codes) - next_chunk_start) // _SNAC_CODES_PER_FRAME
        if remaining_frames > 0:
            chunk_end = next_chunk_start + remaining_frames * _SNAC_CODES_PER_FRAME
            pcm = self._decode_chunk(audio_codes[next_chunk_start:chunk_end])
            if pcm:
                pcm_chunks_emitted += 1
                loop.call_soon_threadsafe(queue.put_nowait, pcm)

        elapsed = time.monotonic() - t0
        logger.info(
            "TTS complete: %.1fs  %d tokens  %d audio codes  %d chunks  text=%s",
            elapsed, total_tokens, len(audio_codes), pcm_chunks_emitted, repr(text[:100]),
        )

        if len(audio_codes) == 0:
            logger.error("TTS produced 0 audio codes (prompt head: %s)", prompt_tokens[:10])

        loop.call_soon_threadsafe(queue.put_nowait, None)

    def _snac_layers(self, codes: list[int], n_frames: int):
        layer0: list[int] = []
        layer1: list[int] = []
        layer2: list[int] = []
        for i in range(n_frames):
            b = i * _SNAC_CODES_PER_FRAME
            layer0.append(codes[b])
            layer1.extend([codes[b + 1], codes[b + 4]])
            layer2.extend([codes[b + 2], codes[b + 3], codes[b + 5], codes[b + 6]])
        return layer0, layer1, layer2

    def _decode_chunk(self, codes: list[int]) -> bytes | None:
        """Decode N complete SNAC frames → PCM int16 bytes (2048 samples/frame)."""
        if self._snac_model is None:
            return None

        n_frames = len(codes) // _SNAC_CODES_PER_FRAME
        if n_frames == 0:
            return None

        try:
            import torch

            layer0, layer1, layer2 = self._snac_layers(codes, n_frames)
            device = self._snac_device

            t0 = torch.tensor([layer0], dtype=torch.long, device=device)
            t1 = torch.tensor([layer1], dtype=torch.long, device=device)
            t2 = torch.tensor([layer2], dtype=torch.long, device=device)

            with torch.no_grad():
                audio = self._snac_model.decode([t0, t1, t2])
                pcm = (audio.squeeze() * 32767).clamp(-32768, 32767).to(torch.int16)

            return pcm.cpu().numpy().tobytes()
        except Exception:
            logger.exception("SNAC decode failed for %d frames", n_frames)
            return None
