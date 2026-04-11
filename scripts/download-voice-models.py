#!/usr/bin/env python3
"""Download voice models for local development.

Run once after cloning the repo:
    python scripts/download-voice-models.py

Models are saved to voice-models/ at the project root (gitignored).
In production builds, Electron Forge bundles this directory via extraResource.
"""

import os
import sys
import urllib.request

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VOICE_MODELS_DIR = os.path.join(PROJECT_ROOT, "voice-models")

KOKORO_RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
KOKORO_FILES = [
    ("kokoro-v1.0.onnx", 310_000_000),
    ("voices-v1.0.bin", 27_000_000),
]


def _download(url: str, dest: str, expected_size: int) -> None:
    """Download url to dest with a simple progress bar."""
    if os.path.exists(dest) and os.path.getsize(dest) >= expected_size * 0.95:
        print(f"  already present — skipping ({os.path.basename(dest)})")
        return

    print(f"  fetching {os.path.basename(dest)}…")
    tmp = dest + ".part"

    def hook(block: int, block_size: int, total: int) -> None:
        downloaded = block * block_size
        pct = 100.0 * downloaded / max(total, 1)
        bar = "#" * int(pct / 2.5)
        print(f"\r  [{bar:<40}] {pct:5.1f}% ({downloaded // 1_000_000} / {total // 1_000_000} MB)", end="", flush=True)

    urllib.request.urlretrieve(url, tmp, hook)
    os.rename(tmp, dest)
    print()


def download_whisper():
    """Faster-whisper downloads the model automatically on first use;
    we just create the cache dir so the backend can point at it."""
    dest = os.path.join(VOICE_MODELS_DIR, "whisper-cache")
    os.makedirs(dest, exist_ok=True)
    print(f"\n{'=' * 60}")
    print("Whisper: cache dir created at")
    print(f"  {dest}")
    print("(faster-whisper will auto-download the 'base' model on first use)")
    print(f"{'=' * 60}")


def download_kokoro():
    """Download Kokoro ONNX model + voices binary from the kokoro-onnx release."""
    dest = os.path.join(VOICE_MODELS_DIR, "kokoro")
    os.makedirs(dest, exist_ok=True)

    print(f"\n{'=' * 60}")
    print("Downloading: Kokoro-82M (TTS, ~340 MB)")
    print(f"  From: {KOKORO_RELEASE}")
    print(f"  To:   {dest}")
    print(f"{'=' * 60}")

    for filename, expected_size in KOKORO_FILES:
        url = f"{KOKORO_RELEASE}/{filename}"
        target = os.path.join(dest, filename)
        _download(url, target, expected_size)

    print("  Done: kokoro")


def main():
    os.makedirs(VOICE_MODELS_DIR, exist_ok=True)

    download_whisper()
    download_kokoro()

    print(f"\n{'=' * 60}")
    print("All voice models downloaded successfully!")
    print(f"Location: {VOICE_MODELS_DIR}")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
