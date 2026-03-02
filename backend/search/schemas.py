"""Pydantic models for web search."""

from __future__ import annotations

from pydantic import BaseModel


class SearchRequest(BaseModel):
    query: str
    max_results: int = 5
    search_depth: str = "basic"  # "basic" (fast) or "advanced" (thorough)
    include_domains: list[str] = []
    exclude_domains: list[str] = []


class SearchResult(BaseModel):
    title: str
    url: str
    content: str  # AI-extracted snippet
    score: float  # relevance score 0-1


class SearchResponse(BaseModel):
    query: str
    results: list[SearchResult]
    answer: str | None = None  # Tavily's AI-generated answer summary
