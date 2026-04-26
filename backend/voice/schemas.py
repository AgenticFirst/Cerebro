from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


VoiceModelType = Literal["stt", "tts"]
EngineState = Literal["idle", "loading", "ready", "error"]
DownloadState = Literal["not_installed", "downloading", "installed", "failed"]

SPEAKERS = ["tara", "leah", "jess", "leo", "dan", "mia", "zac", "zoe"]


# ── Catalog ───────────────────────────────────────────────────────


class VoiceModelInfo(BaseModel):
    id: str
    name: str
    type: VoiceModelType
    description: str
    size_bytes: int
    available: bool  # True if model files exist on disk
    download_state: DownloadState = "not_installed"
    downloaded_bytes: int = 0
    error: str | None = None


class VoiceCatalogResponse(BaseModel):
    models: list[VoiceModelInfo]
    voice_models_dir: str
    all_installed: bool


# ── Download manager ─────────────────────────────────────────────


class DownloadProgressEvent(BaseModel):
    """One row in the SSE stream while a download is in flight."""

    model_id: str
    state: DownloadState
    downloaded_bytes: int
    total_bytes: int
    percent: float
    error: str | None = None


class DownloadStartRequest(BaseModel):
    model_id: str


class DownloadStartResponse(BaseModel):
    model_id: str
    state: DownloadState


# ── Engine status ─────────────────────────────────────────────────


class VoiceStatusResponse(BaseModel):
    stt: EngineState
    tts: EngineState
    stt_model_id: str | None = None
    tts_model_id: str | None = None


# ── STT ───────────────────────────────────────────────────────────


class TranscriptionSegment(BaseModel):
    start: float
    end: float
    text: str


class TranscriptionRequest(BaseModel):
    audio_base64: str
    sample_rate: int = 16000


class TranscriptionFileRequest(BaseModel):
    file_path: str


class TranscriptionResult(BaseModel):
    text: str
    segments: list[TranscriptionSegment]
    language: str


# ── TTS ───────────────────────────────────────────────────────────


class SynthesizeRequest(BaseModel):
    text: str
    speaker: str = "tara"
