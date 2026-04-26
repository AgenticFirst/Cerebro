"""FastAPI router for voice STT and TTS — models are downloaded on demand."""

from __future__ import annotations

import base64
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from .catalog import get_catalog, get_model_path
from .downloader import VoiceDownloader
from .schemas import (
    DownloadStartRequest,
    DownloadStartResponse,
    SynthesizeRequest,
    TranscriptionFileRequest,
    TranscriptionRequest,
    VoiceCatalogResponse,
    VoiceStatusResponse,
)
from .stt_engine import STTEngine
from .tts_engine import TTSEngine


router = APIRouter()

# Singletons — initialized in init_voice_singletons()
_stt_engine: STTEngine | None = None
_tts_engine: TTSEngine | None = None
_downloader: VoiceDownloader | None = None


def init_voice_singletons(voice_models_dir: str) -> None:
    """Idempotent init: building a downloader twice would lose state."""
    global _stt_engine, _tts_engine, _downloader
    _stt_engine = STTEngine()
    _tts_engine = TTSEngine()
    _downloader = VoiceDownloader(voice_models_dir)


def _voice_models_dir(request: Request) -> str:
    return request.app.state.voice_models_dir


def _get_downloader() -> VoiceDownloader:
    if _downloader is None:
        raise HTTPException(503, "Voice subsystem not initialized")
    return _downloader


# ── Catalog ───────────────────────────────────────────────────────


@router.get("/catalog", response_model=VoiceCatalogResponse)
def voice_catalog(request: Request):
    voice_dir = _voice_models_dir(request)
    states = _get_downloader().get_states() if _downloader is not None else None
    models = get_catalog(voice_dir, states)
    return VoiceCatalogResponse(
        models=models,
        voice_models_dir=voice_dir,
        all_installed=all(m.available for m in models),
    )


# ── Engine status ─────────────────────────────────────────────────


@router.get("/status", response_model=VoiceStatusResponse)
def voice_status():
    assert _stt_engine is not None
    assert _tts_engine is not None

    return VoiceStatusResponse(
        stt=_stt_engine.status(),
        tts=_tts_engine.status(),
        stt_model_id=_stt_engine.loaded_model_id,
        tts_model_id=_tts_engine.loaded_model_id,
    )


# ── Download manager ──────────────────────────────────────────────


@router.post("/download/start", response_model=DownloadStartResponse)
async def download_start(body: DownloadStartRequest):
    dl = _get_downloader()
    try:
        result = await dl.start(body.model_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc))
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))
    return DownloadStartResponse(model_id=body.model_id, state=result["state"])


@router.post("/download/cancel")
async def download_cancel(body: DownloadStartRequest):
    cancelled = await _get_downloader().cancel(body.model_id)
    return {"cancelled": cancelled}


@router.get("/download/stream/{model_id}")
async def download_stream(model_id: str):
    """SSE stream of progress events for `model_id` until terminal state."""
    dl = _get_downloader()

    async def gen():
        async for event in dl.subscribe(model_id):
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── STT load / unload / transcribe ───────────────────────────────


@router.post("/stt/load")
async def load_stt(request: Request):
    assert _stt_engine is not None

    voice_dir = _voice_models_dir(request)
    model_id = "faster-whisper-base"
    model_path = get_model_path(voice_dir, model_id)

    if not model_path:
        raise HTTPException(
            404,
            "STT model not installed. Open Settings → Voice to download it.",
        )

    await _stt_engine.load_model(model_id, model_path)
    return {"status": "loaded", "model_id": model_id}


@router.post("/stt/unload")
async def unload_stt():
    assert _stt_engine is not None
    await _stt_engine.unload()
    return {"status": "unloaded"}


@router.post("/stt/transcribe")
async def transcribe(body: TranscriptionRequest):
    assert _stt_engine is not None

    if not _stt_engine.is_ready:
        raise HTTPException(503, "STT engine not ready")

    audio_bytes = base64.b64decode(body.audio_base64)
    result = await _stt_engine.transcribe(audio_bytes, body.sample_rate)
    return result


@router.post("/stt/transcribe-file")
async def transcribe_file(body: TranscriptionFileRequest):
    """Transcribe an audio file at a server-readable path.

    Used by the Telegram bridge to pass OGG/Opus voice notes directly
    (faster-whisper decodes via PyAV).
    """
    assert _stt_engine is not None

    if not _stt_engine.is_ready:
        raise HTTPException(503, "STT engine not ready")

    try:
        result = await _stt_engine.transcribe_file(body.file_path)
    except FileNotFoundError as exc:
        raise HTTPException(404, f"File not found: {exc}")
    return result


# ── TTS load / unload / synthesize ────────────────────────────────


@router.post("/tts/load")
async def load_tts(request: Request):
    assert _tts_engine is not None

    voice_dir = _voice_models_dir(request)
    model_id = "kokoro-82m"
    model_path = get_model_path(voice_dir, model_id)

    if not model_path:
        raise HTTPException(
            404,
            "TTS model not installed. Open Settings → Voice to download it.",
        )

    await _tts_engine.load_model(model_id, model_path)
    return {"status": "loaded", "model_id": model_id}


@router.post("/tts/unload")
async def unload_tts():
    assert _tts_engine is not None
    await _tts_engine.unload()
    return {"status": "unloaded"}


@router.post("/tts/synthesize")
async def synthesize(body: SynthesizeRequest):
    assert _tts_engine is not None

    if not _tts_engine.is_ready:
        raise HTTPException(503, "TTS engine not ready")

    async def audio_stream():
        async for chunk in _tts_engine.synthesize_stream(body.text, body.speaker):
            encoded = base64.b64encode(chunk).decode("ascii")
            yield f"data: {json.dumps({'audio': encoded})}\n\n"
        yield f"data: {json.dumps({'done': True})}\n\n"

    return StreamingResponse(
        audio_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
