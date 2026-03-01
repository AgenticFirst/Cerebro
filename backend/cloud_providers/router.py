"""FastAPI router for cloud provider chat endpoints."""

from __future__ import annotations

from typing import AsyncGenerator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from local_models.schemas import ChatStreamEvent

from .adapters import CREDENTIAL_KEYS, STREAM_ADAPTERS, get_provider_key, verify_key
from .schemas import CloudChatRequest, VerifyKeyRequest, VerifyKeyResponse

router = APIRouter(tags=["cloud"])


@router.post("/chat")
async def cloud_chat(body: CloudChatRequest):
    api_key = get_provider_key(body.provider)
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail=f"No API key configured for {body.provider}",
        )

    adapter = STREAM_ADAPTERS.get(body.provider)
    if not adapter:
        raise HTTPException(status_code=400, detail=f"Unknown provider: {body.provider}")

    messages = [{"role": m.role, "content": m.content} for m in body.messages]

    async def event_stream() -> AsyncGenerator[str, None]:
        try:
            async for event in adapter(
                model=body.model,
                messages=messages,
                temperature=body.temperature,
                max_tokens=body.max_tokens,
                top_p=body.top_p,
                api_key=api_key,
            ):
                yield f"data: {event.model_dump_json()}\n\n"
        except Exception as e:
            error_event = ChatStreamEvent(
                token=None,
                done=True,
                finish_reason="error",
                usage={"error": str(e)},
            )
            yield f"data: {error_event.model_dump_json()}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/verify", response_model=VerifyKeyResponse)
async def verify_connection(body: VerifyKeyRequest):
    api_key = get_provider_key(body.provider)
    if not api_key:
        return VerifyKeyResponse(
            ok=False,
            provider=body.provider,
            error="No API key configured",
        )

    ok, error = await verify_key(body.provider, api_key)
    return VerifyKeyResponse(ok=ok, provider=body.provider, error=error)


@router.get("/status")
async def cloud_status():
    result = {}
    for provider, cred_key in CREDENTIAL_KEYS.items():
        key = get_provider_key(provider)
        result[provider] = {"has_key": key is not None and len(key) > 0}
    return result
