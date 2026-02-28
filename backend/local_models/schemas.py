"""Pydantic request/response models for the local models API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


# ── Catalog ──────────────────────────────────────────────────────

ModelTier = Literal["starter", "balanced", "power"]
ModelStatus = Literal["available", "downloading", "downloaded", "interrupted"]
Architecture = Literal["dense", "moe"]


class ModelInfo(BaseModel):
    """Catalog entry merged with local on-disk state."""

    id: str
    name: str
    family: str
    variant: str
    description: str
    tagline: str
    tier: ModelTier
    size_bytes: int
    context_length: int
    architecture: Architecture
    total_params: str
    active_params: str
    hf_repo: str
    hf_filename: str
    requires_ram_gb: int
    recommended_ram_gb: int
    # On-disk state (defaults for "not downloaded")
    status: ModelStatus = "available"
    file_path: str | None = None
    sha256: str | None = None
    downloaded_at: str | None = None


class ModelCatalogResponse(BaseModel):
    models: list[ModelInfo]
    recommended_model_id: str | None = None


# ── Hardware ─────────────────────────────────────────────────────


class HardwareInfo(BaseModel):
    total_ram_gb: float
    available_ram_gb: float
    gpu_name: str | None = None
    gpu_vram_gb: float | None = None


# ── Download ─────────────────────────────────────────────────────

DownloadStatus = Literal[
    "downloading", "verifying", "completed", "cancelled", "error", "interrupted"
]


class DownloadStartResponse(BaseModel):
    ok: bool
    model_id: str
    message: str


class DownloadProgressEvent(BaseModel):
    status: DownloadStatus
    downloaded_bytes: int = 0
    total_bytes: int = 0
    speed_bps: float = 0
    eta_seconds: float = 0
    file_path: str | None = None
    error: str | None = None


# ── Engine ───────────────────────────────────────────────────────

EngineState = Literal["idle", "loading", "ready", "error"]


class EngineStatusResponse(BaseModel):
    state: EngineState = "idle"
    loaded_model_id: str | None = None
    error: str | None = None


class LoadModelRequest(BaseModel):
    n_ctx: int = 8192
    n_gpu_layers: int = -1


# ── Chat ─────────────────────────────────────────────────────────


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    temperature: float = 0.7
    max_tokens: int = 4096
    stream: bool = True
    top_p: float = 0.95


class ChatStreamEvent(BaseModel):
    """SSE event for chat streaming. Either a token chunk or a done signal."""

    token: str | None = None
    done: bool = False
    finish_reason: str | None = None
    usage: dict | None = None
