#!/usr/bin/env python3
"""Download voice models for local development.

Run once after cloning the repo:
    python scripts/download-voice-models.py

Models are saved to voice-models/ at the project root (gitignored).
In production builds, Electron Forge bundles this directory via extraResource.
"""

import os
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VOICE_MODELS_DIR = os.path.join(PROJECT_ROOT, "voice-models")


def download_whisper():
    """Download Whisper Large V3 Turbo via OpenAI's whisper package."""
    try:
        import whisper
    except ImportError:
        print("Error: openai-whisper not installed.")
        print("Run: pip install openai-whisper")
        sys.exit(1)

    dest = os.path.join(VOICE_MODELS_DIR, "whisper-large-v3-turbo")
    os.makedirs(dest, exist_ok=True)

    print(f"\n{'=' * 60}")
    print("Downloading: Whisper Large V3 Turbo (STT, ~1.5 GB)")
    print(f"  To: {dest}")
    print(f"{'=' * 60}\n")

    # whisper.load_model downloads the .pt file to download_root
    whisper.load_model("turbo", download_root=dest)
    print("  Done: whisper-large-v3-turbo")


def download_orpheus():
    """Download Orpheus TTS 3B Q4_K_M GGUF from HuggingFace."""
    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        print("Error: huggingface_hub not installed.")
        print("Run: pip install huggingface-hub")
        sys.exit(1)

    dest = os.path.join(VOICE_MODELS_DIR, "orpheus-3b-0.1-ft")
    os.makedirs(dest, exist_ok=True)

    print(f"\n{'=' * 60}")
    print("Downloading: Orpheus TTS 3B Q4 (TTS, ~1.8 GB)")
    print(f"  From: isaiahbjork/orpheus-3b-0.1-ft-Q4_K_M-GGUF")
    print(f"  To:   {dest}")
    print(f"{'=' * 60}\n")

    hf_hub_download(
        repo_id="isaiahbjork/orpheus-3b-0.1-ft-Q4_K_M-GGUF",
        filename="orpheus-3b-0.1-ft-q4_k_m.gguf",
        local_dir=dest,
        local_dir_use_symlinks=False,
        token=False,  # Public repo
    )
    print("  Done: orpheus-3b-0.1-ft")


def download_snac():
    """Download SNAC audio codec used by Orpheus TTS."""
    try:
        from snac import SNAC
    except ImportError:
        print("Error: snac not installed.")
        print("Run: pip install snac")
        sys.exit(1)

    dest = os.path.join(VOICE_MODELS_DIR, "snac-24khz")
    if os.path.exists(os.path.join(dest, "pytorch_model.bin")):
        print("  SNAC codec already present — skipping")
        return

    os.makedirs(dest, exist_ok=True)

    print(f"\n{'=' * 60}")
    print("Downloading: SNAC 24kHz audio codec (~76 MB)")
    print(f"  To: {dest}")
    print(f"{'=' * 60}\n")

    # Load model (downloads from HuggingFace)
    model = SNAC.from_pretrained("hubertsiuzdak/snac_24khz")

    # Save locally — SNAC doesn't have save_pretrained, so copy from HF cache
    import shutil
    from huggingface_hub import scan_cache_dir
    cache = scan_cache_dir()
    for repo in cache.repos:
        if "snac_24khz" in repo.repo_id:
            for rev in repo.revisions:
                for f in rev.files:
                    fname = os.path.basename(str(f.file_path))
                    shutil.copy2(str(f.file_path), os.path.join(dest, fname))

    print("  Done: snac-24khz")


def main():
    os.makedirs(VOICE_MODELS_DIR, exist_ok=True)

    download_whisper()
    download_orpheus()
    download_snac()

    print(f"\n{'=' * 60}")
    print("All voice models downloaded successfully!")
    print(f"Location: {VOICE_MODELS_DIR}")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
