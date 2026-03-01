"""FastAPI router for the memory system — /memory/* endpoints."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from database import get_db
from models import KnowledgeEntry, MemoryItem, Setting, _utcnow, _uuid_hex

from .schemas import (
    ContextFileResponse,
    ContextFileUpdate,
    ExtractionRequest,
    KnowledgeEntriesListResponse,
    KnowledgeEntryCreate,
    KnowledgeEntryResponse,
    MemoryContextRequest,
    MemoryContextResponse,
    MemoryItemResponse,
    MemoryItemsListResponse,
)

router = APIRouter(tags=["memory"])

CONTEXT_PREFIX = "memory:context:"
ALLOWED_CONTEXT_KEYS = {"profile", "style"}


# ── Context Files (Tier 1) ───────────────────────────────────────


@router.get("/context-files", response_model=list[ContextFileResponse])
def list_context_files(db=Depends(get_db)):
    settings = (
        db.query(Setting)
        .filter(Setting.key.startswith(CONTEXT_PREFIX))
        .order_by(Setting.key)
        .all()
    )
    return [
        ContextFileResponse(
            key=s.key[len(CONTEXT_PREFIX):],
            content=s.value,
            updated_at=s.updated_at,
        )
        for s in settings
    ]


@router.get("/context-files/{key}", response_model=ContextFileResponse)
def get_context_file(key: str, db=Depends(get_db)):
    full_key = CONTEXT_PREFIX + key
    setting = db.get(Setting, full_key)
    if not setting:
        raise HTTPException(status_code=404, detail="Context file not found")
    return ContextFileResponse(
        key=key,
        content=setting.value,
        updated_at=setting.updated_at,
    )


@router.put("/context-files/{key}", response_model=ContextFileResponse)
def upsert_context_file(key: str, body: ContextFileUpdate, db=Depends(get_db)):
    # Allow well-known keys + expert/routine scoped keys
    if key not in ALLOWED_CONTEXT_KEYS and not key.startswith(("expert:", "routine:")):
        raise HTTPException(status_code=400, detail=f"Invalid context file key: {key}")
    full_key = CONTEXT_PREFIX + key
    setting = db.get(Setting, full_key)
    if setting:
        setting.value = body.content
        setting.updated_at = _utcnow()
    else:
        setting = Setting(key=full_key, value=body.content)
        db.add(setting)
    db.commit()
    db.refresh(setting)
    return ContextFileResponse(
        key=key,
        content=setting.value,
        updated_at=setting.updated_at,
    )


@router.delete("/context-files/{key}", status_code=204)
def delete_context_file(key: str, db=Depends(get_db)):
    full_key = CONTEXT_PREFIX + key
    setting = db.get(Setting, full_key)
    if setting:
        db.delete(setting)
        db.commit()
    return Response(status_code=204)


# ── Learned Facts (Tier 2) ───────────────────────────────────────


@router.get("/items", response_model=MemoryItemsListResponse)
def list_memory_items(
    scope: str = "personal",
    scope_id: str | None = None,
    search: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db=Depends(get_db),
):
    q = db.query(MemoryItem).filter(MemoryItem.scope == scope)
    if scope_id:
        q = q.filter(MemoryItem.scope_id == scope_id)
    else:
        q = q.filter(MemoryItem.scope_id.is_(None))

    if search:
        q = q.filter(MemoryItem.content.ilike(f"%{search}%"))

    total = q.count()
    items = q.order_by(MemoryItem.created_at.desc()).offset(offset).limit(limit).all()
    return MemoryItemsListResponse(
        items=[MemoryItemResponse.model_validate(item) for item in items],
        total=total,
    )


@router.delete("/items/{item_id}", status_code=204)
def delete_memory_item(item_id: str, db=Depends(get_db)):
    item = db.get(MemoryItem, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Memory item not found")
    db.delete(item)
    db.commit()
    return Response(status_code=204)


# ── Knowledge Entries (Tier 3) ───────────────────────────────────


@router.get("/knowledge", response_model=KnowledgeEntriesListResponse)
def list_knowledge_entries(
    scope: str = "personal",
    scope_id: str | None = None,
    entry_type: str | None = None,
    search: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db=Depends(get_db),
):
    q = db.query(KnowledgeEntry).filter(KnowledgeEntry.scope == scope)
    if scope_id:
        q = q.filter(KnowledgeEntry.scope_id == scope_id)
    else:
        q = q.filter(KnowledgeEntry.scope_id.is_(None))

    if entry_type:
        q = q.filter(KnowledgeEntry.entry_type == entry_type)
    if search:
        q = q.filter(KnowledgeEntry.summary.ilike(f"%{search}%"))

    total = q.count()
    entries = (
        q.order_by(KnowledgeEntry.occurred_at.desc()).offset(offset).limit(limit).all()
    )
    return KnowledgeEntriesListResponse(
        entries=[KnowledgeEntryResponse.model_validate(e) for e in entries],
        total=total,
    )


@router.post("/knowledge", response_model=KnowledgeEntryResponse, status_code=201)
def create_knowledge_entry(body: KnowledgeEntryCreate, db=Depends(get_db)):
    entry = KnowledgeEntry(
        id=_uuid_hex(),
        scope=body.scope,
        scope_id=body.scope_id,
        entry_type=body.entry_type,
        occurred_at=body.occurred_at,
        summary=body.summary,
        content=body.content,
        source=body.source,
        source_conversation_id=body.source_conversation_id,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return KnowledgeEntryResponse.model_validate(entry)


@router.delete("/knowledge/{entry_id}", status_code=204)
def delete_knowledge_entry(entry_id: str, db=Depends(get_db)):
    entry = db.get(KnowledgeEntry, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Knowledge entry not found")
    db.delete(entry)
    db.commit()
    return Response(status_code=204)


# ── System Prompt Assembly ───────────────────────────────────────


@router.post("/context", response_model=MemoryContextResponse)
async def get_memory_context(body: MemoryContextRequest, db=Depends(get_db)):
    from .recall import assemble_system_prompt

    return await assemble_system_prompt(
        recent_messages=body.messages,
        scope=body.scope,
        scope_id=body.scope_id,
        db=db,
    )


# ── Extraction ───────────────────────────────────────────────────


@router.post("/extract", status_code=202)
async def trigger_extraction(body: ExtractionRequest, db=Depends(get_db)):
    from .extraction import run_extraction

    # Fire-and-forget: run extraction as a background task
    asyncio.create_task(
        run_extraction(
            messages=body.messages,
            conversation_id=body.conversation_id,
            scope=body.scope,
            scope_id=body.scope_id,
        )
    )
    return {"status": "accepted"}
