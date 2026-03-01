"""Streaming adapters for cloud LLM providers.

Each adapter is an async generator that yields ``ChatStreamEvent`` objects
(same format as local inference) so the frontend streaming logic is unchanged.
"""

from __future__ import annotations

import json
from typing import AsyncGenerator

import httpx

from credentials import get_credential
from local_models.schemas import ChatStreamEvent

# Maps provider id → env/credential key
CREDENTIAL_KEYS: dict[str, str] = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "google": "GOOGLE_API_KEY",
}


def get_provider_key(provider: str) -> str | None:
    cred_key = CREDENTIAL_KEYS.get(provider)
    if not cred_key:
        return None
    return get_credential(cred_key)


# ── Anthropic ────────────────────────────────────────────────────


async def stream_anthropic(
    model: str,
    messages: list[dict],
    temperature: float,
    max_tokens: int,
    top_p: float,
    api_key: str,
) -> AsyncGenerator[ChatStreamEvent, None]:
    # Separate system messages (Anthropic uses a top-level `system` param)
    system_parts: list[str] = []
    chat_messages: list[dict] = []
    for m in messages:
        if m["role"] == "system":
            system_parts.append(m["content"])
        else:
            chat_messages.append({"role": m["role"], "content": m["content"]})

    body: dict = {
        "model": model,
        "messages": chat_messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "top_p": top_p,
        "stream": True,
    }
    if system_parts:
        body["system"] = "\n\n".join(system_parts)

    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }

    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
        async with client.stream(
            "POST",
            "https://api.anthropic.com/v1/messages",
            json=body,
            headers=headers,
        ) as response:
            if response.status_code != 200:
                error_body = await response.aread()
                try:
                    detail = json.loads(error_body).get("error", {}).get("message", error_body.decode())
                except Exception:
                    detail = error_body.decode()
                yield ChatStreamEvent(token=None, done=True, finish_reason="error",
                                      usage={"error": detail})
                return

            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data_str = line[6:]
                if data_str.strip() == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                event_type = data.get("type", "")

                if event_type == "content_block_delta":
                    delta = data.get("delta", {})
                    text = delta.get("text", "")
                    if text:
                        yield ChatStreamEvent(token=text)

                elif event_type == "message_delta":
                    stop_reason = data.get("delta", {}).get("stop_reason")
                    usage = data.get("usage")
                    yield ChatStreamEvent(
                        done=True,
                        finish_reason=stop_reason or "stop",
                        usage=usage,
                    )
                    return

    # Safety: if we exit the loop without a done event
    yield ChatStreamEvent(done=True, finish_reason="stop")


# ── OpenAI ───────────────────────────────────────────────────────


async def stream_openai(
    model: str,
    messages: list[dict],
    temperature: float,
    max_tokens: int,
    top_p: float,
    api_key: str,
) -> AsyncGenerator[ChatStreamEvent, None]:
    body = {
        "model": model,
        "messages": [{"role": m["role"], "content": m["content"]} for m in messages],
        "temperature": temperature,
        "max_completion_tokens": max_tokens,
        "top_p": top_p,
        "stream": True,
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
        async with client.stream(
            "POST",
            "https://api.openai.com/v1/chat/completions",
            json=body,
            headers=headers,
        ) as response:
            if response.status_code != 200:
                error_body = await response.aread()
                try:
                    detail = json.loads(error_body).get("error", {}).get("message", error_body.decode())
                except Exception:
                    detail = error_body.decode()
                yield ChatStreamEvent(token=None, done=True, finish_reason="error",
                                      usage={"error": detail})
                return

            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data_str = line[6:]
                if data_str.strip() == "[DONE]":
                    yield ChatStreamEvent(done=True, finish_reason="stop")
                    return
                try:
                    data = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                choices = data.get("choices", [])
                if not choices:
                    continue
                choice = choices[0]
                delta = choice.get("delta", {})
                finish_reason = choice.get("finish_reason")

                content = delta.get("content")
                if content:
                    yield ChatStreamEvent(token=content)

                if finish_reason:
                    usage = data.get("usage")
                    yield ChatStreamEvent(done=True, finish_reason=finish_reason, usage=usage)
                    return

    yield ChatStreamEvent(done=True, finish_reason="stop")


# ── Google (Gemini) ──────────────────────────────────────────────


async def stream_google(
    model: str,
    messages: list[dict],
    temperature: float,
    max_tokens: int,
    top_p: float,
    api_key: str,
) -> AsyncGenerator[ChatStreamEvent, None]:
    # Convert to Gemini format: role "assistant" → "model", content → parts array
    system_parts: list[str] = []
    gemini_contents: list[dict] = []
    for m in messages:
        if m["role"] == "system":
            system_parts.append(m["content"])
        else:
            role = "model" if m["role"] == "assistant" else "user"
            gemini_contents.append({
                "role": role,
                "parts": [{"text": m["content"]}],
            })

    body: dict = {
        "contents": gemini_contents,
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_tokens,
            "topP": top_p,
        },
    }
    if system_parts:
        body["systemInstruction"] = {
            "parts": [{"text": "\n\n".join(system_parts)}],
        }

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse&key={api_key}"

    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
        async with client.stream("POST", url, json=body) as response:
            if response.status_code != 200:
                error_body = await response.aread()
                try:
                    detail = json.loads(error_body).get("error", {}).get("message", error_body.decode())
                except Exception:
                    detail = error_body.decode()
                yield ChatStreamEvent(token=None, done=True, finish_reason="error",
                                      usage={"error": detail})
                return

            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data_str = line[6:]
                try:
                    data = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                candidates = data.get("candidates", [])
                if candidates:
                    parts = candidates[0].get("content", {}).get("parts", [])
                    for part in parts:
                        text = part.get("text", "")
                        if text:
                            yield ChatStreamEvent(token=text)

                # Check for usage metadata (signals end)
                usage = data.get("usageMetadata")
                if usage:
                    finish_reason = candidates[0].get("finishReason", "STOP") if candidates else "STOP"
                    yield ChatStreamEvent(
                        done=True,
                        finish_reason=finish_reason.lower(),
                        usage=usage,
                    )
                    return

    yield ChatStreamEvent(done=True, finish_reason="stop")


# ── Adapter registry ─────────────────────────────────────────────

STREAM_ADAPTERS = {
    "anthropic": stream_anthropic,
    "openai": stream_openai,
    "google": stream_google,
}


# ── Key verification ─────────────────────────────────────────────


async def verify_key(provider: str, api_key: str) -> tuple[bool, str | None]:
    """Test a provider API key with a minimal request.

    Returns (ok, error_message).
    """
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, connect=5.0)) as client:
            if provider == "anthropic":
                res = await client.post(
                    "https://api.anthropic.com/v1/messages",
                    json={
                        "model": "claude-haiku-3-5",
                        "max_tokens": 1,
                        "messages": [{"role": "user", "content": "hi"}],
                    },
                    headers={
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                )
                if res.status_code == 200:
                    return True, None
                # 401 = invalid key, anything else might be a different issue
                try:
                    detail = res.json().get("error", {}).get("message", res.text)
                except Exception:
                    detail = res.text
                return False, detail

            elif provider == "openai":
                res = await client.get(
                    "https://api.openai.com/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                if res.status_code == 200:
                    return True, None
                try:
                    detail = res.json().get("error", {}).get("message", res.text)
                except Exception:
                    detail = res.text
                return False, detail

            elif provider == "google":
                res = await client.get(
                    f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}",
                )
                if res.status_code == 200:
                    return True, None
                try:
                    detail = res.json().get("error", {}).get("message", res.text)
                except Exception:
                    detail = res.text
                return False, detail

            else:
                return False, f"Unknown provider: {provider}"

    except httpx.ConnectError:
        return False, "Connection failed — check your network"
    except httpx.TimeoutException:
        return False, "Request timed out"
    except Exception as e:
        return False, str(e)
