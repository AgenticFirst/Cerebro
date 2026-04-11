"""FastAPI router for voice STT and TTS — models are bundled with the app."""

from __future__ import annotations

import base64
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from .catalog import get_catalog, get_model_path
from .schemas import (
    SynthesizeRequest,
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


def init_voice_singletons() -> None:
    global _stt_engine, _tts_engine
    _stt_engine = STTEngine()
    _tts_engine = TTSEngine()


def _voice_models_dir(request: Request) -> str:
    return request.app.state.voice_models_dir


# ── Catalog ───────────────────────────────────────────────────────


@router.get("/catalog", response_model=VoiceCatalogResponse)
def voice_catalog(request: Request):
    models = get_catalog(_voice_models_dir(request))
    return VoiceCatalogResponse(models=models)


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


# ── STT load / unload / transcribe ───────────────────────────────


@router.post("/stt/load")
async def load_stt(request: Request):
    assert _stt_engine is not None

    voice_dir = _voice_models_dir(request)
    model_id = "faster-whisper-base"
    model_path = get_model_path(voice_dir, model_id)

    if not model_path:
        raise HTTPException(404, "STT model files not found — app bundle may be corrupted")

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


# ── TTS load / unload / synthesize ────────────────────────────────


@router.post("/tts/load")
async def load_tts(request: Request):
    assert _tts_engine is not None

    voice_dir = _voice_models_dir(request)
    model_id = "orpheus-3b-0.1-ft"
    model_path = get_model_path(voice_dir, model_id)

    if not model_path:
        raise HTTPException(404, "TTS model file not found — app bundle may be corrupted")

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
