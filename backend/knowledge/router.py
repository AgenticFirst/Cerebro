"""FastAPI router for Knowledge Base pages — /knowledge/* endpoints.

The Knowledge Base is a Notion-style nested-page store: every node is a
``KnowledgePage`` and pages nest via ``parent_id``. Archiving (trash) cascades
to descendants; hard delete cascades via the ``ondelete=CASCADE`` FK.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, or_, text

import database
from database import get_db
from models import KnowledgeAiMessage, KnowledgeAiThread, KnowledgePage, _utcnow, _uuid_hex

from .schemas import (
    KnowledgeAiMessageCreate,
    KnowledgeAiMessageListResponse,
    KnowledgeAiMessageResponse,
    KnowledgeAiThreadCreate,
    KnowledgeAiThreadListResponse,
    KnowledgeAiThreadResponse,
    KnowledgeAiThreadUpdate,
    KnowledgePageCreate,
    KnowledgePageListItem,
    KnowledgePageListResponse,
    KnowledgePageReorder,
    KnowledgePageResponse,
    KnowledgePageSearchHit,
    KnowledgePageSearchResponse,
    KnowledgePageTreeNode,
    KnowledgePageTreeResponse,
    KnowledgePageUpdate,
)

router = APIRouter(tags=["knowledge"])

# Sentinel chars wrapping matched spans in snippets; the UI splits on these to
# bold matches without parsing HTML.
SNIP_START = "\x01"
SNIP_END = "\x02"


# ── Helpers ───────────────────────────────────────────────────────


def _descendant_ids(db, root_id: str) -> list[str]:
    """All descendant page ids of ``root_id`` (excludes the root itself)."""
    out: list[str] = []
    frontier = [root_id]
    while frontier:
        children = (
            db.query(KnowledgePage.id)
            .filter(KnowledgePage.parent_id.in_(frontier))
            .all()
        )
        ids = [row[0] for row in children]
        if not ids:
            break
        out.extend(ids)
        frontier = ids
    return out


def _fts_match_query(q: str) -> str | None:
    """Turn free text into a safe FTS5 query: each alphanumeric word becomes a
    quoted prefix term, AND-joined. Returns None when there are no usable tokens."""
    tokens = re.findall(r"[A-Za-z0-9]+", q)
    if not tokens:
        return None
    return " ".join(f'"{t}"*' for t in tokens)


def _plain_snippet(value: str, query: str, radius: int = 60) -> str:
    """Build a snippet around the first match of the full phrase or any token,
    wrapping the matched span in the sentinel chars. Returns '' if no match."""
    if not value:
        return ""
    low = value.lower()
    needle = query.lower().strip()
    idx = low.find(needle) if needle else -1
    if idx < 0:
        for tok in re.findall(r"[A-Za-z0-9]+", query):
            idx = low.find(tok.lower())
            if idx >= 0:
                needle = tok.lower()
                break
    if idx < 0:
        return ""
    start = max(0, idx - radius)
    end = min(len(value), idx + len(needle) + radius)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(value) else ""
    matched = value[idx : idx + len(needle)]
    return (
        f"{prefix}{value[start:idx]}{SNIP_START}{matched}{SNIP_END}"
        f"{value[idx + len(needle):end]}{suffix}"
    )


def _to_hit(p: KnowledgePage, snippet: str) -> KnowledgePageSearchHit:
    return KnowledgePageSearchHit(
        id=p.id,
        parent_id=p.parent_id,
        title=p.title,
        icon=p.icon,
        snippet=snippet,
        updated_at=p.updated_at,
    )


def _best_snippet(p: KnowledgePage, query: str) -> str:
    """Prefer a body snippet, then a title snippet, then a plain body/title head.
    `_plain_snippet` returns '' iff there's no match, so truthiness == matched."""
    body = p.content_markdown or ""
    snip = _plain_snippet(body, query)
    if snip:
        return snip
    title_snip = _plain_snippet(p.title or "", query)
    if title_snip:
        return title_snip
    return (body[:120] + "…") if len(body) > 120 else (body or (p.title or ""))


def _next_sort_order(db, parent_id: str | None) -> float:
    """Place a new page at the end of its sibling list."""
    q = db.query(func.max(KnowledgePage.sort_order))
    q = q.filter(KnowledgePage.parent_id.is_(parent_id)) if parent_id is None \
        else q.filter(KnowledgePage.parent_id == parent_id)
    current_max = q.scalar()
    return (current_max or 0.0) + 1.0


# ── Tree ──────────────────────────────────────────────────────────


@router.get("/pages", response_model=KnowledgePageTreeResponse)
def get_tree(db=Depends(get_db)):
    """Return the full non-archived page tree, ordered by sort_order."""
    rows = (
        db.query(KnowledgePage)
        .filter(KnowledgePage.is_archived.is_(False))
        .order_by(KnowledgePage.sort_order, KnowledgePage.created_at)
        .all()
    )
    nodes: dict[str, KnowledgePageTreeNode] = {
        p.id: KnowledgePageTreeNode(
            id=p.id,
            parent_id=p.parent_id,
            title=p.title,
            icon=p.icon,
            sort_order=p.sort_order,
            has_children=False,
            children=[],
        )
        for p in rows
    }
    roots: list[KnowledgePageTreeNode] = []
    for p in rows:
        node = nodes[p.id]
        parent = nodes.get(p.parent_id) if p.parent_id else None
        if parent is not None:
            parent.children.append(node)
            parent.has_children = True
        else:
            # parent_id is None, or the parent is archived/missing → treat as root.
            roots.append(node)
    return KnowledgePageTreeResponse(pages=roots)


@router.get("/trash", response_model=KnowledgePageListResponse)
def list_trash(db=Depends(get_db)):
    """Flat list of archived pages, newest first."""
    rows = (
        db.query(KnowledgePage)
        .filter(KnowledgePage.is_archived.is_(True))
        .order_by(KnowledgePage.updated_at.desc())
        .all()
    )
    return KnowledgePageListResponse(
        pages=[KnowledgePageListItem.model_validate(p) for p in rows]
    )


# ── Search ────────────────────────────────────────────────────────


@router.get("/search", response_model=KnowledgePageSearchResponse)
def search_pages(
    q: str = Query("", description="Search text"),
    limit: int = Query(20, ge=1, le=100),
    db=Depends(get_db),
):
    """Full-text search over non-archived pages (title + body).

    Uses SQLite FTS5 (BM25 relevance, title weighted 10×, word/prefix match)
    when available; otherwise an escaped ilike substring search. Both return
    snippets with matches wrapped in sentinel chars for the UI to highlight.
    """
    query = (q or "").strip()
    if not query:
        return KnowledgePageSearchResponse(results=[])

    # ── FTS5 path ──
    if database.KNOWLEDGE_FTS_AVAILABLE:
        match = _fts_match_query(query)
        if match is None:
            return KnowledgePageSearchResponse(results=[])
        try:
            # One JOIN projecting everything a hit needs, already in rank order —
            # no second ORM fetch or id→row rejoin.
            rows = db.execute(
                text(
                    "SELECT p.id, p.parent_id, p.title, p.icon, p.updated_at, "
                    "snippet(knowledge_pages_fts, 2, :s, :e, '…', 12) AS snip "
                    "FROM knowledge_pages_fts f "
                    "JOIN knowledge_pages p ON p.id = f.id "
                    "WHERE knowledge_pages_fts MATCH :m AND p.is_archived = 0 "
                    "ORDER BY bm25(knowledge_pages_fts, 10.0, 1.0) "
                    "LIMIT :lim"
                ),
                {"s": SNIP_START, "e": SNIP_END, "m": match, "lim": limit},
            ).all()
            results: list[KnowledgePageSearchHit] = []
            for row in rows:
                snip = row.snip or ""
                # snippet() targets the body column; if the match was only in the
                # title there's no highlight — prefer a title snippet then.
                if SNIP_START not in snip:
                    snip = _plain_snippet(row.title or "", query) or snip or (row.title or "")
                results.append(
                    KnowledgePageSearchHit(
                        id=row.id,
                        parent_id=row.parent_id,
                        title=row.title,
                        icon=row.icon,
                        snippet=snip,
                        updated_at=row.updated_at,
                    )
                )
            return KnowledgePageSearchResponse(results=results)
        except Exception:  # noqa: BLE001 — fall back to ilike on any FTS runtime error
            db.rollback()

    # ── ilike fallback ──
    safe = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    pattern = f"%{safe}%"
    rows = (
        db.query(KnowledgePage)
        .filter(KnowledgePage.is_archived.is_(False))
        .filter(
            or_(
                KnowledgePage.title.ilike(pattern, escape="\\"),
                KnowledgePage.content_markdown.ilike(pattern, escape="\\"),
            )
        )
        .all()
    )
    ql = query.lower()
    rows.sort(
        key=lambda p: (
            0 if ql in (p.title or "").lower() else 1,
            -p.updated_at.timestamp(),
        )
    )
    return KnowledgePageSearchResponse(
        results=[_to_hit(p, _best_snippet(p, query)) for p in rows[:limit]]
    )


# ── Single page CRUD ──────────────────────────────────────────────


@router.get("/pages/{page_id}", response_model=KnowledgePageResponse)
def get_page(page_id: str, db=Depends(get_db)):
    page = db.get(KnowledgePage, page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    return KnowledgePageResponse.model_validate(page)


@router.post("/pages", response_model=KnowledgePageResponse, status_code=201)
def create_page(body: KnowledgePageCreate, db=Depends(get_db)):
    if body.parent_id is not None and not db.get(KnowledgePage, body.parent_id):
        raise HTTPException(status_code=404, detail="Parent page not found")
    page = KnowledgePage(
        id=body.id or _uuid_hex(),
        parent_id=body.parent_id,
        title=body.title,
        icon=body.icon,
        content_json=body.content_json,
        content_markdown=body.content_markdown,
        sort_order=body.sort_order
        if body.sort_order is not None
        else _next_sort_order(db, body.parent_id),
    )
    db.add(page)
    db.commit()
    db.refresh(page)
    return KnowledgePageResponse.model_validate(page)


@router.patch("/pages/{page_id}", response_model=KnowledgePageResponse)
def update_page(page_id: str, body: KnowledgePageUpdate, db=Depends(get_db)):
    page = db.get(KnowledgePage, page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")

    updates = body.model_dump(exclude_unset=True)

    if "parent_id" in updates and updates["parent_id"] is not None:
        new_parent = updates["parent_id"]
        if new_parent == page_id or new_parent in _descendant_ids(db, page_id):
            raise HTTPException(status_code=400, detail="Cannot move a page into itself")
        if not db.get(KnowledgePage, new_parent):
            raise HTTPException(status_code=404, detail="Parent page not found")

    # Archiving/restoring cascades to the whole subtree (Notion behaviour).
    if "is_archived" in updates:
        for desc_id in _descendant_ids(db, page_id):
            desc = db.get(KnowledgePage, desc_id)
            if desc:
                desc.is_archived = updates["is_archived"]

    for key, val in updates.items():
        setattr(page, key, val)

    db.commit()
    db.refresh(page)
    return KnowledgePageResponse.model_validate(page)


@router.post("/pages/reorder", status_code=204)
def reorder_pages(body: KnowledgePageReorder, db=Depends(get_db)):
    """Batch-apply parent_id + sort_order for drag-reorder/re-parent."""
    for item in body.items:
        page = db.get(KnowledgePage, item.id)
        if not page:
            continue
        if item.parent_id is not None and (
            item.parent_id == item.id or item.parent_id in _descendant_ids(db, item.id)
        ):
            raise HTTPException(status_code=400, detail="Cannot move a page into itself")
        page.parent_id = item.parent_id
        page.sort_order = item.sort_order
    db.commit()
    return Response(status_code=204)


@router.delete("/pages/{page_id}", status_code=204)
def delete_page(page_id: str, db=Depends(get_db)):
    page = db.get(KnowledgePage, page_id)
    if not page:
        raise HTTPException(status_code=404, detail="Page not found")
    db.delete(page)  # descendants cascade via FK ondelete=CASCADE
    db.commit()
    return Response(status_code=204)


# ── Ask AI: threads + messages ────────────────────────────────────


@router.get("/ai/threads", response_model=KnowledgeAiThreadListResponse)
def list_ai_threads(page_id: str = Query(...), db=Depends(get_db)):
    rows = (
        db.query(KnowledgeAiThread)
        .filter(KnowledgeAiThread.page_id == page_id)
        .order_by(KnowledgeAiThread.updated_at.desc())
        .all()
    )
    return KnowledgeAiThreadListResponse(
        threads=[KnowledgeAiThreadResponse.model_validate(t) for t in rows]
    )


@router.post("/ai/threads", response_model=KnowledgeAiThreadResponse, status_code=201)
def create_ai_thread(body: KnowledgeAiThreadCreate, db=Depends(get_db)):
    if not db.get(KnowledgePage, body.page_id):
        raise HTTPException(status_code=404, detail="Page not found")
    thread = KnowledgeAiThread(id=_uuid_hex(), page_id=body.page_id, title=body.title)
    db.add(thread)
    db.commit()
    db.refresh(thread)
    return KnowledgeAiThreadResponse.model_validate(thread)


@router.patch("/ai/threads/{thread_id}", response_model=KnowledgeAiThreadResponse)
def update_ai_thread(thread_id: str, body: KnowledgeAiThreadUpdate, db=Depends(get_db)):
    thread = db.get(KnowledgeAiThread, thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    for key, val in body.model_dump(exclude_unset=True).items():
        setattr(thread, key, val)
    db.commit()
    db.refresh(thread)
    return KnowledgeAiThreadResponse.model_validate(thread)


@router.delete("/ai/threads/{thread_id}", status_code=204)
def delete_ai_thread(thread_id: str, db=Depends(get_db)):
    thread = db.get(KnowledgeAiThread, thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    db.delete(thread)  # messages cascade via FK ondelete=CASCADE
    db.commit()
    return Response(status_code=204)


@router.get("/ai/threads/{thread_id}/messages", response_model=KnowledgeAiMessageListResponse)
def list_ai_messages(thread_id: str, db=Depends(get_db)):
    if not db.get(KnowledgeAiThread, thread_id):
        raise HTTPException(status_code=404, detail="Thread not found")
    rows = (
        db.query(KnowledgeAiMessage)
        .filter(KnowledgeAiMessage.thread_id == thread_id)
        .order_by(KnowledgeAiMessage.created_at)
        .all()
    )
    return KnowledgeAiMessageListResponse(
        messages=[KnowledgeAiMessageResponse.model_validate(m) for m in rows]
    )


@router.post(
    "/ai/threads/{thread_id}/messages",
    response_model=KnowledgeAiMessageResponse,
    status_code=201,
)
def create_ai_message(thread_id: str, body: KnowledgeAiMessageCreate, db=Depends(get_db)):
    thread = db.get(KnowledgeAiThread, thread_id)
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    msg = KnowledgeAiMessage(
        id=_uuid_hex(), thread_id=thread_id, role=body.role, content=body.content
    )
    db.add(msg)
    # Bump the thread's updated_at so the list stays newest-first.
    thread.updated_at = _utcnow()
    db.commit()
    db.refresh(msg)
    return KnowledgeAiMessageResponse.model_validate(msg)
