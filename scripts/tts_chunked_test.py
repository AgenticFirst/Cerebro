#!/usr/bin/env python3
"""Test the chunked streaming decode exactly as tts_engine.py does it.

This validates the EXACT pipeline: freddyaboulton prompt → model.generate()
→ chunked decode (6 frames/chunk) → WAV output.
"""
import os
import wave
import numpy as np

MODEL_PATH = os.path.abspath("voice-models/orpheus-3b-0.1-ft/orpheus-3b-0.1-ft-q4_k_m.gguf")
SNAC_DIR = os.path.abspath("voice-models/snac-24khz")

TEST_TEXTS = [
    ("long", "Hello, how are you doing today? I hope everything is going well."),
    ("short", "Hi there!"),
    ("medium", "The quick brown fox jumps over the lazy dog."),
]
SPEAKER = "tara"

# Constants matching tts_engine.py
AUDIO_START_MARKER = 156939
EOT = 128009
END_OF_HUMAN = 128260
END_OF_SPEECH = 128258
AUDIO_TOKEN_BASE = 128266
SNAC_CODES_PER_FRAME = 7
POSITION_OFFSETS = [0, 4096, 8192, 12288, 16384, 20480, 24576]
CHUNK_FRAMES = 6

from llama_cpp import Llama
import torch
from snac import SNAC

print("Loading model...")
llm = Llama(model_path=MODEL_PATH, n_ctx=8192, n_gpu_layers=-1, verbose=False)
snac = SNAC.from_pretrained(SNAC_DIR)
device = "mps" if torch.backends.mps.is_available() else "cpu"
snac = snac.to(device).eval()
print(f"Ready. SNAC on {device}")


def snac_layers(codes, n_frames):
    layer0, layer1, layer2 = [], [], []
    for i in range(n_frames):
        b = i * SNAC_CODES_PER_FRAME
        layer0.append(codes[b])
        layer1.extend([codes[b + 1], codes[b + 4]])
        layer2.extend([codes[b + 2], codes[b + 3], codes[b + 5], codes[b + 6]])
    return layer0, layer1, layer2


def decode_chunk(codes):
    n_frames = len(codes) // SNAC_CODES_PER_FRAME
    if n_frames == 0:
        return b""
    l0, l1, l2 = snac_layers(codes, n_frames)
    t0 = torch.tensor([l0], dtype=torch.long, device=device)
    t1 = torch.tensor([l1], dtype=torch.long, device=device)
    t2 = torch.tensor([l2], dtype=torch.long, device=device)
    with torch.no_grad():
        audio = snac.decode([t0, t1, t2])
    audio_np = audio.squeeze().cpu().numpy()
    return (audio_np * 32767).clip(-32768, 32767).astype(np.int16).tobytes()


def synthesize(text):
    voice_text = f"{SPEAKER}: {text}"
    text_ids = list(llm.tokenize(voice_text.encode("utf-8"), add_bos=False, special=False))
    prompt_tokens = [AUDIO_START_MARKER] + text_ids + [EOT, END_OF_HUMAN]

    audio_codes = []
    pcm_chunks = []
    next_chunk_start = 0
    total_tokens = 0

    for tid in llm.generate(prompt_tokens, top_k=40, top_p=0.9, temp=0.6, repeat_penalty=1.1, reset=True):
        total_tokens += 1
        if tid == END_OF_SPEECH or tid == llm.token_eos() or total_tokens > 2500:
            break
        if 128256 <= tid < AUDIO_TOKEN_BASE:
            continue
        if tid >= AUDIO_TOKEN_BASE:
            pos = len(audio_codes) % SNAC_CODES_PER_FRAME
            code = tid - AUDIO_TOKEN_BASE - POSITION_OFFSETS[pos]
            if 0 <= code <= 4095:
                audio_codes.append(code)
                new_frames = (len(audio_codes) - next_chunk_start) // SNAC_CODES_PER_FRAME
                if new_frames >= CHUNK_FRAMES:
                    chunk_end = next_chunk_start + CHUNK_FRAMES * SNAC_CODES_PER_FRAME
                    pcm = decode_chunk(audio_codes[next_chunk_start:chunk_end])
                    pcm_chunks.append(pcm)
                    next_chunk_start = chunk_end
        elif len(audio_codes) > 0:
            break

    # Flush trailing partial chunk
    remaining_codes = len(audio_codes) - next_chunk_start
    remaining_frames = remaining_codes // SNAC_CODES_PER_FRAME
    if remaining_frames > 0:
        chunk_end = next_chunk_start + remaining_frames * SNAC_CODES_PER_FRAME
        pcm = decode_chunk(audio_codes[next_chunk_start:chunk_end])
        pcm_chunks.append(pcm)

    total_samples = sum(len(c) for c in pcm_chunks) // 2
    return pcm_chunks, total_tokens, len(audio_codes), total_samples


for name, text in TEST_TEXTS:
    print(f"\n── {name}: {text!r}")
    chunks, ttoks, acodes, tsamp = synthesize(text)
    print(f"  tokens: {ttoks}  audio_codes: {acodes}  frames: {acodes // 7}")
    print(f"  chunks: {len(chunks)}  total samples: {tsamp}  duration: {tsamp / 24000:.2f}s")

    out = f"/tmp/tts_chunked_{name}.wav"
    with wave.open(out, "wb") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(24000)
        f.writeframes(b"".join(chunks))
    print(f"  saved: {out}")
