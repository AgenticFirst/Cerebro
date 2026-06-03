"""FastAPI router for IMD audit CRUD — /imd/*."""
from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from database import get_db
from models import IMDAudit, _utcnow

from .schemas import IMDAuditCreate, IMDAuditRead, IMDAuditUpdate

router = APIRouter(tags=["imd"])
logger = logging.getLogger(__name__)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _compute_total_and_classification(
    d1: Optional[float],
    d2: Optional[float],
    d3: Optional[float],
    d4: Optional[float],
    d5: Optional[float],
    d6: Optional[float],
) -> tuple[Optional[float], Optional[str]]:
    scores = [d for d in (d1, d2, d3, d4, d5, d6) if d is not None]
    if not scores:
        return None, None
    total = sum(scores)
    if total >= 96:
        classification = "Líder"
    elif total >= 80:
        classification = "Avanzado"
    elif total >= 60:
        classification = "Intermedio"
    else:
        classification = "Básico"
    return total, classification


def _audit_to_read(audit: IMDAudit) -> IMDAuditRead:
    """Convert ORM instance to IMDAuditRead, parsing JSON fields."""
    data = {
        "id": audit.id,
        "business_name": audit.business_name,
        "phone": audit.phone,
        "email": audit.email,
        "website": audit.website,
        "instagram": audit.instagram,
        "city": audit.city,
        "industry": audit.industry,
        "language": audit.language,
        "ghl_contact_id": audit.ghl_contact_id,
        "ghl_opportunity_id": audit.ghl_opportunity_id,
        "d1": audit.d1,
        "d2": audit.d2,
        "d3": audit.d3,
        "d4": audit.d4,
        "d5": audit.d5,
        "d6": audit.d6,
        "total": audit.total,
        "classification": audit.classification,
        "d1_breakdown": _parse_json(audit.d1_breakdown),
        "d2_breakdown": _parse_json(audit.d2_breakdown),
        "pain_points": _parse_json(audit.pain_points),
        "d5_dm_sent_at": audit.d5_dm_sent_at,
        "d5_responded_at": audit.d5_responded_at,
        "d5_hours_to_respond": audit.d5_hours_to_respond,
        "d6_called_at": audit.d6_called_at,
        "d6_call_outcome": audit.d6_call_outcome,
        "pipeline_stage": audit.pipeline_stage,
        "notes": audit.notes,
        "created_at": audit.created_at,
        "updated_at": audit.updated_at,
    }
    return IMDAuditRead(**data)


def _parse_json(value: Optional[str]):
    if value is None:
        return None
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return None


# ── Endpoints ─────────────────────────────────────────────────────────────────


@router.get("/audits/stats")
def get_audit_stats(db: Session = Depends(get_db)) -> dict:
    """Return aggregate stats: total count and breakdowns by classification, stage, industry."""
    audits = db.query(IMDAudit).all()
    by_classification: dict[str, int] = {}
    by_stage: dict[str, int] = {}
    by_industry: dict[str, int] = {}
    for audit in audits:
        cls = audit.classification or "unscored"
        by_classification[cls] = by_classification.get(cls, 0) + 1
        stage = audit.pipeline_stage or "raw"
        by_stage[stage] = by_stage.get(stage, 0) + 1
        industry = audit.industry or "unknown"
        by_industry[industry] = by_industry.get(industry, 0) + 1
    return {
        "total": len(audits),
        "by_classification": by_classification,
        "by_stage": by_stage,
        "by_industry": by_industry,
    }


@router.get("/audits", response_model=list[IMDAuditRead])
def list_audits(
    industry: Optional[str] = Query(None),
    classification: Optional[str] = Query(None),
    pipeline_stage: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    db: Session = Depends(get_db),
) -> list[IMDAuditRead]:
    """List all audits with optional filters."""
    q = db.query(IMDAudit)
    if industry is not None:
        q = q.filter(IMDAudit.industry == industry)
    if classification is not None:
        q = q.filter(IMDAudit.classification == classification)
    if pipeline_stage is not None:
        q = q.filter(IMDAudit.pipeline_stage == pipeline_stage)
    if search is not None:
        q = q.filter(IMDAudit.business_name.ilike(f"%{search}%"))
    audits = q.order_by(IMDAudit.created_at.desc()).all()
    return [_audit_to_read(a) for a in audits]


@router.post("/audits", response_model=IMDAuditRead, status_code=201)
def create_audit(body: IMDAuditCreate, db: Session = Depends(get_db)) -> IMDAuditRead:
    """Create a new IMD audit. Auto-computes total and classification if scores provided."""
    total, classification = _compute_total_and_classification(
        body.d1, body.d2, body.d3, body.d4, body.d5, body.d6
    )
    audit = IMDAudit(
        business_name=body.business_name,
        phone=body.phone,
        email=body.email,
        website=body.website,
        instagram=body.instagram,
        city=body.city,
        industry=body.industry,
        language=body.language,
        ghl_contact_id=body.ghl_contact_id,
        ghl_opportunity_id=body.ghl_opportunity_id,
        d1=body.d1,
        d2=body.d2,
        d3=body.d3,
        d4=body.d4,
        d5=body.d5,
        d6=body.d6,
        total=total,
        classification=classification,
        pain_points=json.dumps(body.pain_points) if body.pain_points is not None else None,
        notes=body.notes,
        pipeline_stage=body.pipeline_stage,
    )
    db.add(audit)
    db.commit()
    db.refresh(audit)
    return _audit_to_read(audit)


@router.get("/audits/{audit_id}", response_model=IMDAuditRead)
def get_audit(audit_id: str, db: Session = Depends(get_db)) -> IMDAuditRead:
    """Get a single audit by ID."""
    audit = db.get(IMDAudit, audit_id)
    if not audit:
        raise HTTPException(status_code=404, detail="Audit not found")
    return _audit_to_read(audit)


@router.patch("/audits/{audit_id}", response_model=IMDAuditRead)
def patch_audit(
    audit_id: str, body: IMDAuditUpdate, db: Session = Depends(get_db)
) -> IMDAuditRead:
    """Update audit fields. Recomputes total and classification after update."""
    audit = db.get(IMDAudit, audit_id)
    if not audit:
        raise HTTPException(status_code=404, detail="Audit not found")

    update_data = body.model_dump(exclude_unset=True)

    # Handle JSON-serialized fields
    for json_field in ("d1_breakdown", "d2_breakdown"):
        if json_field in update_data:
            val = update_data.pop(json_field)
            setattr(audit, json_field, json.dumps(val) if val is not None else None)

    if "pain_points" in update_data:
        val = update_data.pop("pain_points")
        audit.pain_points = json.dumps(val) if val is not None else None

    for field, value in update_data.items():
        setattr(audit, field, value)

    # Recompute total and classification
    total, classification = _compute_total_and_classification(
        audit.d1, audit.d2, audit.d3, audit.d4, audit.d5, audit.d6
    )
    audit.total = total
    audit.classification = classification
    audit.updated_at = _utcnow()

    db.commit()
    db.refresh(audit)
    return _audit_to_read(audit)


@router.delete("/audits/{audit_id}", status_code=204)
def delete_audit(audit_id: str, db: Session = Depends(get_db)) -> Response:
    """Delete an audit. Returns 204 No Content."""
    audit = db.get(IMDAudit, audit_id)
    if not audit:
        raise HTTPException(status_code=404, detail="Audit not found")
    db.delete(audit)
    db.commit()
    return Response(status_code=204)
