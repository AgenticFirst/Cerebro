"""Pydantic response models for the News API."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class NewsArticleOut(BaseModel):
    id: str
    feed_id: str
    source_name: str
    title: str
    url: str
    summary: str | None = None
    image_url: str | None = None
    category: str | None = None
    published_at: datetime | None = None

    model_config = {"from_attributes": True}


class NewsFeedResponse(BaseModel):
    articles: list[NewsArticleOut]
    fetched_at: datetime | None = None
    stale: bool = False
    category: str = "top"
    count: int = 0
