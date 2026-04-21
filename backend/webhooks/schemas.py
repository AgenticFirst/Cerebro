"""Pydantic schemas for the webhook listener system."""

from __future__ import annotations

from datetime import datetime
from pydantic import BaseModel


class WebhookListenRequest(BaseModel):
    match_path: str = ""
    timeout: int = 3600
    description: str = ""


class WebhookListenerResponse(BaseModel):
    listener_id: str
    endpoint_url: str
    match_path: str
    timeout: int
    created_at: str


class WebhookStatusResponse(BaseModel):
    received: bool
    payload: dict | None = None
    headers: dict | None = None
    received_at: str | None = None


class WebhookListenerSummary(BaseModel):
    listener_id: str
    match_path: str
    description: str
    received: bool
    created_at: str


class WebhookListListResponse(BaseModel):
    listeners: list[WebhookListenerSummary]
