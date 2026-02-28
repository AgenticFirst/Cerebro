"""FastAPI router for all /models/* endpoints."""

from __future__ import annotations

import asyncio
import os
from typing import AsyncGenerator

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from .catalog import (
    detect_hardware,
    get_catalog,
    get_catalog_entry,
    get_model_state,
    recommend_model,
    remove_model_state,
    set_model_state,
)
from .downloader import DownloadManager
from .inference import InferenceEngine
from .schemas import (
    ChatRequest,
    ChatStreamEvent,
    DownloadProgressEvent,
    DownloadStartResponse,
    EngineStatusResponse,
    HardwareInfo,
    LoadModelRequest,
    ModelCatalogResponse,
)

router = APIRouter(tags=["models"])

# Singletons — initialized when router is mounted
_download_manager: DownloadManager | None = None
_inference_engine: InferenceEngine | None = None


def init_singletons() -> None:
    """Create singletons. Called from lifespan after models_dir is set."""
    global _download_manager, _inference_engine
    _download_manager = DownloadManager()
    _inference_engine = InferenceEngine()


def get_models_dir(request: Request) -> str:
    return request.app.state.models_dir


# ── Catalog & hardware ───────────────────────────────────────────


@router.get("/catalog", response_model=ModelCatalogResponse)
def catalog(request: Request):
    models_dir = get_models_dir(request)
    models = get_catalog(models_dir)
    hw = detect_hardware()
    recommended = recommend_model(hw)
    return ModelCatalogResponse(models=models, recommended_model_id=recommended)


@router.get("/hardware", response_model=HardwareInfo)
def hardware():
    return detect_hardware()


@router.get("/status", response_model=EngineStatusResponse)
def engine_status():
    if _inference_engine is None:
        return EngineStatusResponse()
    return _inference_engine.status()


# ── Downloads ────────────────────────────────────────────────────


@router.post("/{model_id}/download", response_model=DownloadStartResponse)
async def start_download(model_id: str, request: Request):
    models_dir = get_models_dir(request)
    entry = get_catalog_entry(model_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")

    if _download_manager is None:
        raise HTTPException(status_code=500, detail="Download manager not initialized")

    if _download_manager.is_active:
        raise HTTPException(
            status_code=409,
            detail="A download is already in progress. Cancel it first or wait for it to finish.",
        )

    # Check disk space
    import shutil

    disk = shutil.disk_usage(models_dir)
    required = int(entry["size_bytes"] * 1.1)
    if disk.free < required:
        free_gb = round(disk.free / (1024**3), 1)
        need_gb = round(required / (1024**3), 1)
        raise HTTPException(
            status_code=507,
            detail=f"Not enough disk space. Need {need_gb} GB but only {free_gb} GB free.",
        )

    # Start download
    _download_manager.start(model_id, entry, models_dir)

    return DownloadStartResponse(
        ok=True,
        model_id=model_id,
        message=f"Download started for {entry['name']}",
    )


@router.get("/{model_id}/download/progress")
async def download_progress(model_id: str):
    if _download_manager is None:
        raise HTTPException(status_code=500, detail="Download manager not initialized")

    if _download_manager.active_model_id != model_id:
        raise HTTPException(status_code=404, detail="No active download for this model")

    async def event_stream() -> AsyncGenerator[str, None]:
        queue = _download_manager.progress_queue
        if queue is None:
            return
        while True:
            try:
                event: DownloadProgressEvent = await asyncio.wait_for(queue.get(), timeout=30)
                yield f"data: {event.model_dump_json()}\n\n"
                if event.status in ("completed", "cancelled", "error"):
                    break
            except asyncio.TimeoutError:
                # Keep-alive
                yield ": keepalive\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/{model_id}/download/cancel")
async def cancel_download(model_id: str):
    if _download_manager is None:
        raise HTTPException(status_code=500, detail="Download manager not initialized")

    if _download_manager.active_model_id != model_id:
        raise HTTPException(status_code=404, detail="No active download for this model")

    _download_manager.cancel()
    return {"ok": True, "message": "Download cancellation requested"}


@router.delete("/{model_id}")
async def delete_model(model_id: str, request: Request):
    models_dir = get_models_dir(request)
    entry = get_catalog_entry(model_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")

    # Don't delete a loaded model
    if _inference_engine and _inference_engine.loaded_model_id == model_id:
        raise HTTPException(
            status_code=409,
            detail="Cannot delete a loaded model. Unload it first.",
        )

    state = get_model_state(models_dir, model_id)
    file_path = state.get("file_path")
    if file_path and os.path.exists(file_path):
        os.remove(file_path)

    remove_model_state(models_dir, model_id)
    return {"ok": True, "message": f"Model {model_id} deleted"}


# ── Inference ────────────────────────────────────────────────────


@router.post("/{model_id}/load")
async def load_model(model_id: str, request: Request, body: LoadModelRequest | None = None):
    models_dir = get_models_dir(request)
    entry = get_catalog_entry(model_id)
    if entry is None:
        raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")

    state = get_model_state(models_dir, model_id)
    if state.get("status") != "downloaded":
        raise HTTPException(status_code=400, detail="Model is not downloaded")

    file_path = state.get("file_path")
    if not file_path or not os.path.exists(file_path):
        raise HTTPException(status_code=400, detail="Model file not found on disk")

    if _inference_engine is None:
        raise HTTPException(status_code=500, detail="Inference engine not initialized")

    params = body or LoadModelRequest()
    try:
        await _inference_engine.load_model(
            model_id=model_id,
            model_path=file_path,
            n_ctx=params.n_ctx,
            n_gpu_layers=params.n_gpu_layers,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load model: {e}")

    return {"ok": True, "model_id": model_id, "message": f"{entry['name']} loaded"}


@router.post("/unload")
async def unload_model():
    if _inference_engine is None:
        raise HTTPException(status_code=500, detail="Inference engine not initialized")

    await _inference_engine.unload_model()
    return {"ok": True, "message": "Model unloaded"}


@router.post("/chat")
async def chat(body: ChatRequest):
    if _inference_engine is None:
        raise HTTPException(status_code=500, detail="Inference engine not initialized")

    if not _inference_engine.is_ready:
        raise HTTPException(status_code=400, detail="No model loaded")

    messages = [{"role": m.role, "content": m.content} for m in body.messages]

    async def event_stream() -> AsyncGenerator[str, None]:
        assert _inference_engine is not None
        async for event in _inference_engine.generate_stream(
            messages=messages,
            temperature=body.temperature,
            max_tokens=body.max_tokens,
            top_p=body.top_p,
        ):
            yield f"data: {event.model_dump_json()}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
