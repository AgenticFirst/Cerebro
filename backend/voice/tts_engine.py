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

# Progressive re-decode streaming parameters. Each SNAC frame ≈ 85ms (2048
# samples at 24kHz). We re-decode audio_codes[0:n] from frame 0 every time
# (no chunked boundary artifacts) and emit only the new samples since the
# last emission. The first decode happens at 6 frames so the user hears
# something within ~600ms. Subsequent decodes fire every 6 new frames.
# SAFETY_FRAMES holds back the last 2 frames to let them benefit from more
# right context on the next decode — reduces interior drift at the joins.
_FIRST_DECODE_FRAMES = 6
_DECODE_INTERVAL_FRAMES = 6
_SAFETY_FRAMES = 2


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
        eos_token = self._model.token_eos()

        # Streaming state: we re-decode from frame 0 on each pass and emit
        # only the new samples since the last emission. Re-decoding (rather
        # than decoding disjoint chunks) keeps the emitted samples stable
        # against boundary artifacts — SNAC's convolutional decoder has a
        # receptive field that extends across chunk boundaries, so disjoint
        # chunk decodes produced severe noise (the old bug we just fixed).
        last_emit_sample: int = 0
        decoded_at_frames: int = 0
        chunks_emitted: int = 0

        logger.info(
            "TTS generating: %d prompt tokens, speaker=%s, text=%s",
            len(prompt_tokens), speaker, repr(text[:100]),
        )

        def emit_from_decode(n_frames: int, safe_end_sample: int) -> None:
            nonlocal last_emit_sample, chunks_emitted
            if safe_end_sample <= last_emit_sample:
                return
            pcm = self._decode_all(audio_codes[: n_frames * _SNAC_CODES_PER_FRAME])
            if not pcm:
                return
            chunk = pcm[last_emit_sample * 2 : safe_end_sample * 2]
            if not chunk:
                return
            loop.call_soon_threadsafe(queue.put_nowait, chunk)
            last_emit_sample = safe_end_sample
            chunks_emitted += 1

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
                n_frames = len(audio_codes) // _SNAC_CODES_PER_FRAME

                new_since_last = n_frames - decoded_at_frames
                first_decode = decoded_at_frames == 0 and n_frames >= _FIRST_DECODE_FRAMES
                interval_hit = decoded_at_frames > 0 and new_since_last >= _DECODE_INTERVAL_FRAMES

                if first_decode or interval_hit:
                    # First decode: emit all frames (decode(6) is stable
                    # within ~1 amplitude diff vs a full-sentence decode —
                    # verified empirically, see receptive-field tests).
                    # Subsequent decodes: hold back SAFETY_FRAMES to reduce
                    # interior-drift audibility at the join.
                    if decoded_at_frames == 0:
                        safe_end = n_frames * 2048
                    else:
                        safe_end = max(0, n_frames - _SAFETY_FRAMES) * 2048
                    emit_from_decode(n_frames, safe_end)
                    decoded_at_frames = n_frames

            elif len(audio_codes) > 0:
                break

        t_gen = time.monotonic() - t0

        # Final emit: re-decode everything and emit any trailing samples
        # that weren't covered by intermediate emits (including the last
        # SAFETY_FRAMES that were held back).
        n_frames = len(audio_codes) // _SNAC_CODES_PER_FRAME
        if n_frames > 0:
            t_dec0 = time.monotonic()
            emit_from_decode(n_frames, n_frames * 2048)
            t_dec = time.monotonic() - t_dec0
            logger.info(
                "TTS complete: gen=%.2fs final_dec=%.2fs  %d tokens  %d frames  %d chunks  text=%s",
                t_gen, t_dec, total_tokens, n_frames, chunks_emitted, repr(text[:100]),
            )
        else:
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

    def _decode_all(self, codes: list[int]) -> bytes | None:
        """Decode N complete SNAC frames → PCM int16 bytes (2048 samples/frame).

        Single-shot decode — no chunking, no boundary artifacts.
        """
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

            result = pcm.cpu().numpy().tobytes()

            # Release MPS buffers so they don't accumulate across calls
            if device == "mps" and hasattr(torch.mps, "empty_cache"):
                torch.mps.empty_cache()

            return result
        except Exception:
            logger.exception("SNAC decode failed for %d frames", n_frames)
            return None
