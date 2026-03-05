"""FastAPI router for the routines system — /routines/* endpoints."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import or_

from database import get_db
from models import Routine, _utcnow, _uuid_hex

from .schemas import (
    RoutineCreate,
    RoutineListResponse,
    RoutineResponse,
    RoutineUpdate,
)

router = APIRouter(tags=["routines"])

# JSON text columns that store structured data
_JSON_FIELDS = frozenset({"plain_english_steps", "approval_gates", "required_connections"})


def _routine_to_response(routine: Routine) -> RoutineResponse:
    """Convert an ORM Routine to a RoutineResponse, parsing JSON text columns."""
    data = {}
    for col in RoutineResponse.model_fields:
        val = getattr(routine, col, None)
        if col in _JSON_FIELDS and isinstance(val, str):
            val = json.loads(val)
        data[col] = val
    return RoutineResponse(**data)


def _serialize_json_fields(values: dict) -> dict:
    """Serialize any JSON-typed fields from native Python to JSON strings."""
    for key in _JSON_FIELDS:
        if key in values and values[key] is not None:
            values[key] = json.dumps(values[key])
    return values


# ── CRUD Endpoints ───────────────────────────────────────────────


@router.get("", response_model=RoutineListResponse)
def list_routines(
    is_enabled: bool | None = None,
    trigger_type: str | None = None,
    source: str | None = None,
    search: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
    db=Depends(get_db),
):
    q = db.query(Routine)

    if is_enabled is not None:
        q = q.filter(Routine.is_enabled == is_enabled)
    if trigger_type is not None:
        q = q.filter(Routine.trigger_type == trigger_type)
    if source is not None:
        q = q.filter(Routine.source == source)
    if search:
        # Escape LIKE wildcards so user input is matched literally
        safe = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{safe}%"
        q = q.filter(or_(
            Routine.name.ilike(pattern, escape="\\"),
            Routine.description.ilike(pattern, escape="\\"),
        ))

    total = q.count()
    routines = (
        q.order_by(Routine.updated_at.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return RoutineListResponse(
        routines=[_routine_to_response(r) for r in routines],
        total=total,
    )


@router.get("/{routine_id}", response_model=RoutineResponse)
def get_routine(routine_id: str, db=Depends(get_db)):
    routine = db.get(Routine, routine_id)
    if not routine:
        raise HTTPException(status_code=404, detail="Routine not found")
    return _routine_to_response(routine)


@router.post("", response_model=RoutineResponse, status_code=201)
def create_routine(body: RoutineCreate, db=Depends(get_db)):
    values = body.model_dump()
    values = _serialize_json_fields(values)
    routine = Routine(id=_uuid_hex(), **values)
    db.add(routine)
    db.commit()
    db.refresh(routine)
    return _routine_to_response(routine)


@router.patch("/{routine_id}", response_model=RoutineResponse)
def update_routine(routine_id: str, body: RoutineUpdate, db=Depends(get_db)):
    routine = db.get(Routine, routine_id)
    if not routine:
        raise HTTPException(status_code=404, detail="Routine not found")

    updates = body.model_dump(exclude_unset=True)
    updates = _serialize_json_fields(updates)

    for key, val in updates.items():
        setattr(routine, key, val)
    db.commit()
    db.refresh(routine)
    return _routine_to_response(routine)


@router.delete("/{routine_id}", status_code=204)
def delete_routine(routine_id: str, db=Depends(get_db)):
    routine = db.get(Routine, routine_id)
    if not routine:
        raise HTTPException(status_code=404, detail="Routine not found")
    db.delete(routine)
    db.commit()
    return Response(status_code=204)


# ── Run Endpoint ─────────────────────────────────────────────────


@router.post("/{routine_id}/run", response_model=RoutineResponse)
def trigger_routine_run(routine_id: str, db=Depends(get_db)):
    """Return the routine data needed for execution.

    The actual execution happens in the Electron main process via
    ExecutionEngine. This endpoint updates run metadata (last_run_at,
    run_count) and returns the full routine for the caller to compile
    and execute.
    """
    routine = db.get(Routine, routine_id)
    if not routine:
        raise HTTPException(status_code=404, detail="Routine not found")
    if not routine.is_enabled:
        raise HTTPException(status_code=400, detail="Routine is disabled")

    routine.last_run_at = _utcnow()
    routine.run_count = (routine.run_count or 0) + 1
    db.commit()
    db.refresh(routine)
    return _routine_to_response(routine)
