"""Pydantic schemas for cloud provider chat endpoints."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel


# ── Tool definitions ─────────────────────────────────────────────


class ToolDefinition(BaseModel):
    """Provider-agnostic tool definition."""

    name: str
    description: str
    parameters: dict[str, Any]  # JSON Schema object


# ── Messages ─────────────────────────────────────────────────────


class ToolCallData(BaseModel):
    id: str
    name: str
    arguments: str  # JSON string


class CloudChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str | None = None
    tool_calls: list[ToolCallData] | None = None
    tool_call_id: str | None = None  # For role="tool" (tool result messages)


class CloudChatRequest(BaseModel):
    provider: Literal["anthropic", "openai", "google"]
    model: str
    messages: list[CloudChatMessage]
    temperature: float = 0.7
    max_tokens: int = 4096
    stream: bool = True
    top_p: float = 0.95
    tools: list[ToolDefinition] | None = None


class VerifyKeyRequest(BaseModel):
    provider: Literal["anthropic", "openai", "google"]


class VerifyKeyResponse(BaseModel):
    ok: bool
    provider: str
    error: str | None = None
