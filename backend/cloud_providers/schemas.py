"""Pydantic schemas for cloud provider chat endpoints."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class CloudChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class CloudChatRequest(BaseModel):
    provider: Literal["anthropic", "openai", "google"]
    model: str
    messages: list[CloudChatMessage]
    temperature: float = 0.7
    max_tokens: int = 4096
    stream: bool = True
    top_p: float = 0.95


class VerifyKeyRequest(BaseModel):
    provider: Literal["anthropic", "openai", "google"]


class VerifyKeyResponse(BaseModel):
    ok: bool
    provider: str
    error: str | None = None
