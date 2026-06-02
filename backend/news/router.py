"""FastAPI router for the News app — /news.

Stale-while-revalidate: a category's cached rows are served instantly; the
network is only touched when that category's cache is older than ``TTL_SECONDS``
(or the caller passes ``?refresh=true``). A failed refresh degrades gracefully —
whatever is cached is returned with ``stale=true``.

Articles are always stored tagged with their **intrinsic** feed category
(world/tech/business/science) so the same story surfaced by both the ``top``
aggregate and its own tab keeps a single, stable row (PK = sha1(url)). The
virtual ``top`` tab refreshes every real category and returns the most recent
across all of them.
"""
from __future__ import annotations

import logging
from datetime import timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database import get_db
from models import NewsArticle, NewsFetchMeta, _utcnow

from . import service
from .feeds import CATEGORIES, feeds_for_category
from .schemas import NewsArticleOut, NewsFeedResponse

router = APIRouter(tags=["news"])
log = logging.getLogger(__name__)

REAL_CATEGORIES = [c for c in CATEGORIES if c != "top"]


@router.get("", response_model=NewsFeedResponse)
async def get_news(
    db: Session = Depends(get_db),
    category: str = Query("top"),
    refresh: bool = Query(False),
) -> NewsFeedResponse:
    if category not in CATEGORIES:
        raise HTTPException(status_code=400, detail=f"Unknown category: {category}")

    meta = db.get(NewsFetchMeta, category)
    age = _age_seconds(meta)
    is_stale = meta is None or age is None or age > service.TTL_SECONDS or refresh

    refreshed = False
    if is_stale:
        refreshed = await _try_refresh(db, category)

    query = db.query(NewsArticle)
    if category != "top":
        query = query.filter(NewsArticle.category == category)
    rows = (
        query.order_by(NewsArticle.published_at.desc().nullslast())
        .limit(service.MAX_ARTICLES)
        .all()
    )
    served_meta = db.get(NewsFetchMeta, category)
    return NewsFeedResponse(
        articles=[NewsArticleOut.model_validate(r) for r in rows],
        fetched_at=served_meta.last_fetched_at if served_meta else None,
        # stale = we wanted fresh data but couldn't get it this call.
        stale=is_stale and not refreshed,
        category=category,
        count=len(rows),
    )


def _age_seconds(meta: NewsFetchMeta | None) -> float | None:
    if meta is None:
        return None
    last = meta.last_fetched_at
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return (_utcnow() - last).total_seconds()


async def _try_refresh(db: Session, category: str) -> bool:
    """Refresh the requested tab. ``top`` refreshes every real category. Returns
    True if at least one category was refreshed; on total failure the caller
    serves whatever is cached."""
    targets = REAL_CATEGORIES if category == "top" else [category]
    refreshed_any = False
    for real in targets:
        if await _refresh_category(db, real):
            refreshed_any = True
    if refreshed_any:
        _touch_meta(db, category)
        db.commit()
    return refreshed_any


async def _refresh_category(db: Session, real_category: str) -> bool:
    """Fetch + parse + rank one real category, then replace its cached rows.
    Tags articles with their intrinsic category. Returns False (serve stale) on
    any error or when no articles came back."""
    try:
        parsed = await service.fetch_feeds(feeds_for_category(real_category))
        ranked = service.rank_articles(parsed)
        if not ranked:
            return False

        db.query(NewsArticle).filter(NewsArticle.category == real_category).delete()
        now = _utcnow()
        for art in ranked:
            db.merge(
                NewsArticle(
                    id=art.id,
                    feed_id=art.feed_id,
                    source_name=art.source_name,
                    title=art.title,
                    url=art.url,
                    summary=art.summary,
                    image_url=art.image_url,
                    category=real_category,
                    published_at=art.published_at,
                    fetched_at=now,
                )
            )
        _touch_meta(db, real_category)
        db.commit()
        return True
    except Exception as exc:  # noqa: BLE001 — degrade to cached on any failure
        db.rollback()
        log.warning("news: refresh of category %s failed: %s", real_category, exc)
        return False


def _touch_meta(db: Session, category: str) -> None:
    meta = db.get(NewsFetchMeta, category)
    now = _utcnow()
    if meta is None:
        db.add(NewsFetchMeta(id=category, last_fetched_at=now))
    else:
        meta.last_fetched_at = now
