"""FastAPI router for the experts system — /experts/* endpoints."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import or_

from database import get_db
from models import Expert, _uuid_hex

from .schemas import (
    ExpertCreate,
    ExpertListResponse,
    ExpertResponse,
    ExpertUpdate,
)

router = APIRouter(tags=["experts"])

# JSON text columns that store structured data
_JSON_FIELDS = frozenset(
    {"tool_access", "policies", "required_connections", "recommended_routines", "team_members"}
)


def _expert_to_response(expert: Expert) -> ExpertResponse:
    """Convert an ORM Expert to an ExpertResponse, parsing JSON text columns."""
    data = {}
    for col in ExpertResponse.model_fields:
        val = getattr(expert, col)
        if col in _JSON_FIELDS and isinstance(val, str):
            val = json.loads(val)
        data[col] = val
    return ExpertResponse(**data)


def _serialize_json_fields(values: dict) -> dict:
    """Serialize any JSON-typed fields from native Python to JSON strings."""
    for key in _JSON_FIELDS:
        if key in values and values[key] is not None:
            values[key] = json.dumps(values[key])
    return values


# ── CRUD Endpoints ───────────────────────────────────────────────


@router.get("", response_model=ExpertListResponse)
def list_experts(
    type: str | None = None,
    source: str | None = None,
    is_enabled: bool | None = None,
    search: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db=Depends(get_db),
):
    q = db.query(Expert)

    if type is not None:
        q = q.filter(Expert.type == type)
    if source is not None:
        q = q.filter(Expert.source == source)
    if is_enabled is not None:
        q = q.filter(Expert.is_enabled == is_enabled)
    if search:
        pattern = f"%{search}%"
        q = q.filter(or_(Expert.name.ilike(pattern), Expert.description.ilike(pattern)))

    total = q.count()
    experts = (
        q.order_by(Expert.is_pinned.desc(), Expert.name)
        .offset(offset)
        .limit(limit)
        .all()
    )
    return ExpertListResponse(
        experts=[_expert_to_response(e) for e in experts],
        total=total,
    )


@router.get("/{expert_id}", response_model=ExpertResponse)
def get_expert(expert_id: str, db=Depends(get_db)):
    expert = db.get(Expert, expert_id)
    if not expert:
        raise HTTPException(status_code=404, detail="Expert not found")
    return _expert_to_response(expert)


@router.post("", response_model=ExpertResponse, status_code=201)
def create_expert(body: ExpertCreate, db=Depends(get_db)):
    # Check slug uniqueness
    if body.slug:
        existing = db.query(Expert).filter(Expert.slug == body.slug).first()
        if existing:
            raise HTTPException(status_code=409, detail="Expert with this slug already exists")

    values = body.model_dump()
    values = _serialize_json_fields(values)
    expert = Expert(id=_uuid_hex(), **values)
    db.add(expert)
    db.commit()
    db.refresh(expert)
    return _expert_to_response(expert)


@router.patch("/{expert_id}", response_model=ExpertResponse)
def update_expert(expert_id: str, body: ExpertUpdate, db=Depends(get_db)):
    expert = db.get(Expert, expert_id)
    if not expert:
        raise HTTPException(status_code=404, detail="Expert not found")

    updates = body.model_dump(exclude_unset=True)
    updates = _serialize_json_fields(updates)

    # Check slug uniqueness if being changed
    if "slug" in updates and updates["slug"] is not None:
        existing = db.query(Expert).filter(Expert.slug == updates["slug"], Expert.id != expert_id).first()
        if existing:
            raise HTTPException(status_code=409, detail="Expert with this slug already exists")

    for key, val in updates.items():
        setattr(expert, key, val)
    db.commit()
    db.refresh(expert)
    return _expert_to_response(expert)


@router.delete("/{expert_id}", status_code=204)
def delete_expert(expert_id: str, db=Depends(get_db)):
    expert = db.get(Expert, expert_id)
    if not expert:
        raise HTTPException(status_code=404, detail="Expert not found")
    if expert.source == "builtin":
        raise HTTPException(status_code=403, detail="Cannot delete builtin experts")
    db.delete(expert)
    db.commit()
    return Response(status_code=204)
