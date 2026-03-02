"""FastAPI router for web search endpoints."""

from __future__ import annotations

import httpx
from fastapi import APIRouter, HTTPException

from credentials import get_credential

from .schemas import SearchRequest, SearchResponse, SearchResult

router = APIRouter(tags=["search"])

TAVILY_SEARCH_URL = "https://api.tavily.com/search"


def _get_tavily_key() -> str | None:
    return get_credential("TAVILY_API_KEY")


@router.post("", response_model=SearchResponse)
async def search(body: SearchRequest):
    api_key = _get_tavily_key()
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="No Tavily API key configured. Add your key in Integrations → Connected Apps.",
        )

    payload: dict = {
        "api_key": api_key,
        "query": body.query,
        "max_results": body.max_results,
        "search_depth": body.search_depth,
    }
    if body.include_domains:
        payload["include_domains"] = body.include_domains
    if body.exclude_domains:
        payload["exclude_domains"] = body.exclude_domains

    async with httpx.AsyncClient(timeout=30.0) as client:
        try:
            resp = await client.post(TAVILY_SEARCH_URL, json=payload)
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Search request failed: {e}")

    if resp.status_code != 200:
        detail = resp.text
        try:
            detail = resp.json().get("detail", resp.text)
        except Exception:
            pass
        raise HTTPException(status_code=resp.status_code, detail=f"Tavily API error: {detail}")

    data = resp.json()
    results = [
        SearchResult(
            title=r.get("title", ""),
            url=r.get("url", ""),
            content=r.get("content", ""),
            score=r.get("score", 0.0),
        )
        for r in data.get("results", [])
    ]

    return SearchResponse(
        query=body.query,
        results=results,
        answer=data.get("answer"),
    )


@router.post("/verify")
async def verify_search_key():
    api_key = _get_tavily_key()
    if not api_key:
        return {"valid": False, "error": "No API key configured"}

    payload = {
        "api_key": api_key,
        "query": "test",
        "max_results": 1,
        "search_depth": "basic",
    }

    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.post(TAVILY_SEARCH_URL, json=payload)
        except httpx.RequestError as e:
            return {"valid": False, "error": str(e)}

    if resp.status_code == 200:
        return {"valid": True}
    return {"valid": False, "error": f"API returned status {resp.status_code}"}


@router.get("/status")
async def search_status():
    key = _get_tavily_key()
    return {"has_key": key is not None and len(key) > 0}
