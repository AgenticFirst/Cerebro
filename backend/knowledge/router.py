"""FastAPI router for Knowledge Base pages — /knowledge/* endpoints.

The Knowledge Base is a Notion-style nested-page store: every node is a
``KnowledgePage`` and pages nest via ``parent_id``. Archiving (trash) cascades
to descendants; hard delete cascades via the ``ondelete=CASCADE`` FK.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func

from database import get_db
from models import KnowledgePage, _uuid_hex

from .schemas import (
    KnowledgePageCreate,
    KnowledgePageListItem,
    KnowledgePageListResponse,
    KnowledgePageReorder,
    KnowledgePageResponse,
    KnowledgePageTreeNode,
    KnowledgePageTreeResponse,
    KnowledgePageUpdate,
)

router = APIRouter(tags=["knowledge"])


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
