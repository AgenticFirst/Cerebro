"""Streaming adapters for cloud LLM providers.

Each adapter is an async generator that yields ``ChatStreamEvent`` objects
(same format as local inference) so the frontend streaming logic is unchanged.
"""

from __future__ import annotations

import json
from typing import Any, AsyncGenerator

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


# ── Tool format converters ──────────────────────────────────────


def _tools_to_anthropic(tools: list[dict]) -> list[dict]:
    """Convert generic tool defs to Anthropic format."""
    return [
        {
            "name": t["name"],
            "description": t["description"],
            "input_schema": t["parameters"],
        }
        for t in tools
    ]


def _tools_to_openai(tools: list[dict]) -> list[dict]:
    """Convert generic tool defs to OpenAI function-calling format."""
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["parameters"],
            },
        }
        for t in tools
    ]


def _tools_to_google(tools: list[dict]) -> list[dict]:
    """Convert generic tool defs to Gemini format."""
    return [
        {
            "functionDeclarations": [
                {
                    "name": t["name"],
                    "description": t["description"],
                    "parameters": t["parameters"],
                }
                for t in tools
            ]
        }
    ]


def _messages_to_anthropic(messages: list[dict]) -> tuple[list[str], list[dict]]:
    """Convert messages to Anthropic format, handling tool calls and results."""
    system_parts: list[str] = []
    chat_messages: list[dict] = []
    for m in messages:
        role = m.get("role", "")
        if role == "system":
            system_parts.append(m.get("content", ""))
        elif role == "assistant":
            content_parts: list[dict] = []
            if m.get("content"):
                content_parts.append({"type": "text", "text": m["content"]})
            for tc in m.get("tool_calls") or []:
                args = tc.get("arguments", "{}")
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except json.JSONDecodeError:
                        args = {}
                content_parts.append({
                    "type": "tool_use",
                    "id": tc["id"],
                    "name": tc["name"],
                    "input": args,
                })
            chat_messages.append({"role": "assistant", "content": content_parts or m.get("content", "")})
        elif role == "tool":
            chat_messages.append({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": m.get("tool_call_id", ""),
                    "content": m.get("content", ""),
                }],
            })
        else:
            chat_messages.append({"role": m.get("role", "user"), "content": m.get("content", "")})
    return system_parts, chat_messages


def _messages_to_openai(messages: list[dict]) -> list[dict]:
    """Convert messages to OpenAI format, handling tool calls and results."""
    oai_messages: list[dict] = []
    for m in messages:
        role = m.get("role", "")
        if role == "tool":
            oai_messages.append({
                "role": "tool",
                "tool_call_id": m.get("tool_call_id", ""),
                "content": m.get("content", ""),
            })
        elif role == "assistant" and m.get("tool_calls"):
            msg: dict[str, Any] = {"role": "assistant"}
            if m.get("content"):
                msg["content"] = m["content"]
            else:
                msg["content"] = None
            msg["tool_calls"] = [
                {
                    "id": tc["id"],
                    "type": "function",
                    "function": {
                        "name": tc["name"],
                        "arguments": tc.get("arguments", "{}") if isinstance(tc.get("arguments"), str) else json.dumps(tc.get("arguments", {})),
                    },
                }
                for tc in m["tool_calls"]
            ]
            oai_messages.append(msg)
        else:
            oai_messages.append({"role": role, "content": m.get("content", "")})
    return oai_messages


def _messages_to_google(messages: list[dict]) -> tuple[list[str], list[dict]]:
    """Convert messages to Gemini format, handling tool calls and results."""
    system_parts: list[str] = []
    gemini_contents: list[dict] = []
    for m in messages:
        role = m.get("role", "")
        if role == "system":
            system_parts.append(m.get("content", ""))
        elif role == "tool":
            gemini_contents.append({
                "role": "user",
                "parts": [{
                    "functionResponse": {
                        "name": m.get("tool_name", "tool"),
                        "response": {"result": m.get("content", "")},
                    }
                }],
            })
        elif role == "assistant" and m.get("tool_calls"):
            parts: list[dict] = []
            if m.get("content"):
                parts.append({"text": m["content"]})
            for tc in m["tool_calls"]:
                args = tc.get("arguments", "{}")
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except json.JSONDecodeError:
                        args = {}
                parts.append({
                    "functionCall": {
                        "name": tc["name"],
                        "args": args,
                    }
                })
            gemini_contents.append({"role": "model", "parts": parts})
        else:
            g_role = "model" if role == "assistant" else "user"
            gemini_contents.append({
                "role": g_role,
                "parts": [{"text": m.get("content", "")}],
            })
    return system_parts, gemini_contents


# ── Anthropic ────────────────────────────────────────────────────


async def stream_anthropic(
    model: str,
    messages: list[dict],
    temperature: float,
    max_tokens: int,
    top_p: float,
    api_key: str,
    tools: list[dict] | None = None,
) -> AsyncGenerator[ChatStreamEvent, None]:
    system_parts, chat_messages = _messages_to_anthropic(messages)

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
    if tools:
        body["tools"] = _tools_to_anthropic(tools)

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

            # Track active tool use blocks
            active_tool: dict[str, Any] | None = None
            active_tool_json = ""

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

                if event_type == "content_block_start":
                    block = data.get("content_block", {})
                    if block.get("type") == "tool_use":
                        active_tool = {"id": block["id"], "name": block["name"]}
                        active_tool_json = ""

                elif event_type == "content_block_delta":
                    delta = data.get("delta", {})
                    delta_type = delta.get("type", "")
                    if delta_type == "text_delta":
                        text = delta.get("text", "")
                        if text:
                            yield ChatStreamEvent(token=text)
                    elif delta_type == "input_json_delta" and active_tool:
                        active_tool_json += delta.get("partial_json", "")

                elif event_type == "content_block_stop":
                    if active_tool:
                        yield ChatStreamEvent(
                            tool_calls=[{
                                "id": active_tool["id"],
                                "name": active_tool["name"],
                                "arguments": active_tool_json,
                            }]
                        )
                        active_tool = None
                        active_tool_json = ""

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
    tools: list[dict] | None = None,
) -> AsyncGenerator[ChatStreamEvent, None]:
    oai_messages = _messages_to_openai(messages)

    body: dict[str, Any] = {
        "model": model,
        "messages": oai_messages,
        "temperature": temperature,
        "max_completion_tokens": max_tokens,
        "top_p": top_p,
        "stream": True,
    }
    if tools:
        body["tools"] = _tools_to_openai(tools)

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

            # Accumulate tool calls across streaming chunks
            pending_tool_calls: dict[int, dict[str, str]] = {}

            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data_str = line[6:]
                if data_str.strip() == "[DONE]":
                    # Emit accumulated tool calls before done
                    if pending_tool_calls:
                        calls = []
                        for _idx, tc in sorted(pending_tool_calls.items()):
                            calls.append({
                                "id": tc.get("id", ""),
                                "name": tc.get("name", ""),
                                "arguments": tc.get("arguments", ""),
                            })
                        yield ChatStreamEvent(tool_calls=calls)
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

                # Accumulate tool call deltas
                delta_tool_calls = delta.get("tool_calls")
                if delta_tool_calls:
                    for tc_delta in delta_tool_calls:
                        idx = tc_delta.get("index", 0)
                        if idx not in pending_tool_calls:
                            pending_tool_calls[idx] = {"id": "", "name": "", "arguments": ""}
                        if tc_delta.get("id"):
                            pending_tool_calls[idx]["id"] = tc_delta["id"]
                        func = tc_delta.get("function", {})
                        if func.get("name"):
                            pending_tool_calls[idx]["name"] = func["name"]
                        if func.get("arguments"):
                            pending_tool_calls[idx]["arguments"] += func["arguments"]

                if finish_reason:
                    # Emit accumulated tool calls before finish
                    if pending_tool_calls:
                        calls = []
                        for _idx, tc in sorted(pending_tool_calls.items()):
                            calls.append({
                                "id": tc.get("id", ""),
                                "name": tc.get("name", ""),
                                "arguments": tc.get("arguments", ""),
                            })
                        yield ChatStreamEvent(tool_calls=calls)
                        pending_tool_calls.clear()
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
    tools: list[dict] | None = None,
) -> AsyncGenerator[ChatStreamEvent, None]:
    system_parts, gemini_contents = _messages_to_google(messages)

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
    if tools:
        body["tools"] = _tools_to_google(tools)

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
                    tool_calls_batch: list[dict] = []
                    for part in parts:
                        text = part.get("text", "")
                        if text:
                            yield ChatStreamEvent(token=text)
                        fc = part.get("functionCall")
                        if fc:
                            import uuid
                            tool_calls_batch.append({
                                "id": f"call_{uuid.uuid4().hex[:8]}",
                                "name": fc.get("name", ""),
                                "arguments": json.dumps(fc.get("args", {})),
                            })
                    if tool_calls_batch:
                        yield ChatStreamEvent(tool_calls=tool_calls_batch)

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
