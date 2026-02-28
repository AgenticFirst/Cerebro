"""Hardcoded model catalog and on-disk state management."""

from __future__ import annotations

import json
import os
import platform
import subprocess
from typing import Any

import psutil

from .schemas import HardwareInfo, ModelInfo, ModelStatus

# ── Curated catalog ──────────────────────────────────────────────

CATALOG: list[dict[str, Any]] = [
    {
        "id": "gemma-3-4b",
        "name": "Gemma 3 4B",
        "family": "Gemma",
        "variant": "4B-Q4_K_M",
        "description": "Google's compact 4B model — fast responses with solid quality for everyday tasks.",
        "tagline": "Fast & lightweight — works on any Mac or PC",
        "tier": "starter",
        "size_bytes": 2_680_000_000,  # ~2.5 GB GGUF
        "context_length": 128_000,
        "architecture": "dense",
        "total_params": "4B",
        "active_params": "4B",
        "hf_repo": "bartowski/google_gemma-3-4b-it-GGUF",
        "hf_filename": "google_gemma-3-4b-it-Q4_K_M.gguf",
        "requires_ram_gb": 8,
        "recommended_ram_gb": 10,
    },
    {
        "id": "gemma-3-12b",
        "name": "Gemma 3 12B",
        "family": "Gemma",
        "variant": "12B-Q4_K_M",
        "description": "Google's 12B model — excellent quality-to-size ratio for most tasks.",
        "tagline": "Great quality for most tasks",
        "tier": "balanced",
        "size_bytes": 7_330_000_000,  # ~7 GB GGUF
        "context_length": 128_000,
        "architecture": "dense",
        "total_params": "12B",
        "active_params": "12B",
        "hf_repo": "bartowski/google_gemma-3-12b-it-GGUF",
        "hf_filename": "google_gemma-3-12b-it-Q4_K_M.gguf",
        "requires_ram_gb": 16,
        "recommended_ram_gb": 18,
    },
    {
        "id": "qwen3.5-35b-a3b",
        "name": "Qwen3.5 35B A3B",
        "family": "Qwen",
        "variant": "35B-A3B-Q4_K_M",
        "description": "Alibaba's MoE model — 35B total params but only 3B active, balancing quality and speed.",
        "tagline": "Maximum quality — best with dedicated GPU",
        "tier": "power",
        "size_bytes": 21_000_000_000,  # ~20 GB GGUF
        "context_length": 262_144,
        "architecture": "moe",
        "total_params": "35B",
        "active_params": "3B",
        "hf_repo": "bartowski/Qwen_Qwen3.5-35B-A3B-GGUF",
        "hf_filename": "Qwen_Qwen3.5-35B-A3B-Q4_K_M.gguf",
        "requires_ram_gb": 24,
        "recommended_ram_gb": 28,
    },
]


# ── On-disk state ────────────────────────────────────────────────

STATE_FILENAME = "state.json"


def _state_path(models_dir: str) -> str:
    return os.path.join(models_dir, STATE_FILENAME)


def load_state(models_dir: str) -> dict[str, Any]:
    """Load state.json, returning {} if missing or corrupt."""
    path = _state_path(models_dir)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_state(models_dir: str, state: dict[str, Any]) -> None:
    """Atomically write state.json."""
    path = _state_path(models_dir)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, path)


def recover_interrupted(models_dir: str) -> None:
    """Mark any 'downloading' entries as 'interrupted' (e.g. after app crash)."""
    state = load_state(models_dir)
    changed = False
    for model_id, entry in state.items():
        if entry.get("status") == "downloading":
            entry["status"] = "interrupted"
            changed = True
    if changed:
        save_state(models_dir, state)


def get_model_state(models_dir: str, model_id: str) -> dict[str, Any]:
    """Get state for a single model."""
    state = load_state(models_dir)
    return state.get(model_id, {})


def set_model_state(
    models_dir: str,
    model_id: str,
    *,
    status: ModelStatus | None = None,
    file_path: str | None = None,
    sha256: str | None = None,
    downloaded_at: str | None = None,
) -> None:
    """Update state for a single model."""
    state = load_state(models_dir)
    entry = state.get(model_id, {})
    if status is not None:
        entry["status"] = status
    if file_path is not None:
        entry["file_path"] = file_path
    if sha256 is not None:
        entry["sha256"] = sha256
    if downloaded_at is not None:
        entry["downloaded_at"] = downloaded_at
    state[model_id] = entry
    save_state(models_dir, state)


def remove_model_state(models_dir: str, model_id: str) -> None:
    """Remove a model entry from state."""
    state = load_state(models_dir)
    state.pop(model_id, None)
    save_state(models_dir, state)


# ── Catalog + state merge ────────────────────────────────────────


def get_catalog(models_dir: str) -> list[ModelInfo]:
    """Return all catalog models merged with on-disk state."""
    state = load_state(models_dir)
    models = []
    for entry in CATALOG:
        model_state = state.get(entry["id"], {})
        models.append(
            ModelInfo(
                **entry,
                status=model_state.get("status", "available"),
                file_path=model_state.get("file_path"),
                sha256=model_state.get("sha256"),
                downloaded_at=model_state.get("downloaded_at"),
            )
        )
    return models


def get_catalog_entry(model_id: str) -> dict[str, Any] | None:
    """Look up a raw catalog entry by id."""
    for entry in CATALOG:
        if entry["id"] == model_id:
            return entry
    return None


# ── Hardware detection ───────────────────────────────────────────


def detect_hardware() -> HardwareInfo:
    """Detect system RAM and GPU info."""
    mem = psutil.virtual_memory()
    total_ram_gb = round(mem.total / (1024**3), 1)
    available_ram_gb = round(mem.available / (1024**3), 1)

    gpu_name: str | None = None
    gpu_vram_gb: float | None = None

    # macOS Apple Silicon — Metal is automatic
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        gpu_name = "Apple Silicon (Metal)"
        # On Apple Silicon, GPU shares unified memory
        gpu_vram_gb = total_ram_gb

    # NVIDIA GPU
    if gpu_name is None:
        try:
            result = subprocess.run(
                [
                    "nvidia-smi",
                    "--query-gpu=name,memory.total",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.returncode == 0:
                line = result.stdout.strip().split("\n")[0]
                parts = [p.strip() for p in line.split(",")]
                if len(parts) >= 2:
                    gpu_name = parts[0]
                    gpu_vram_gb = round(float(parts[1]) / 1024, 1)
        except (FileNotFoundError, subprocess.TimeoutExpired, ValueError):
            pass

    return HardwareInfo(
        total_ram_gb=total_ram_gb,
        available_ram_gb=available_ram_gb,
        gpu_name=gpu_name,
        gpu_vram_gb=gpu_vram_gb,
    )


def recommend_model(hardware: HardwareInfo) -> str | None:
    """Recommend a model based on detected hardware."""
    ram = hardware.total_ram_gb
    if ram >= 24:
        return "qwen3.5-35b-a3b"
    elif ram >= 12:
        return "gemma-3-12b"
    elif ram >= 8:
        return "gemma-3-4b"
    return None
