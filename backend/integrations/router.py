"""FastAPI router for outbound integration config endpoints — /integrations/*."""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import Setting, _utcnow

from .ghl import GHLClient
from .imd_scorer import auto_score as _imd_auto_score
from .schemas import (
    CallOutcomePayload,
    GHLConfig,
    GHLConfigResponse,
    GHLIMDFieldConfig,
    GHLPipelineConfig,
    IGDMSentRequest,
    IGResponseLogRequest,
    IMDAutoScoreRequest,
    IMDAutoScoreResponse,
    PushLeadRequest,
    PushLeadResponse,
    TriggerCallRequest,
)

router = APIRouter(tags=["integrations"])
logger = logging.getLogger(__name__)

GHL_BASE_URL = "https://services.leadconnectorhq.com"
GHL_API_VERSION = "2021-07-28"

# ── Settings helpers ──────────────────────────────────────────────────────────


def _upsert_setting(db: Session, key: str, value: str) -> None:
    setting = db.get(Setting, key)
    if setting:
        setting.value = value
        setting.updated_at = _utcnow()
    else:
        setting = Setting(key=key, value=value)
        db.add(setting)


def _get_setting(db: Session, key: str) -> str | None:
    setting = db.get(Setting, key)
    return setting.value if setting else None


def _log_dir() -> str:
    """Return a writable log directory, creating it if needed."""
    log_dir = os.environ.get("GHL_LOG_DIR", "/tmp/ghl-logs")
    os.makedirs(log_dir, exist_ok=True)
    return log_dir


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── GHL client helper ─────────────────────────────────────────────────────────


def _require_ghl_client(db: Session) -> GHLClient:
    """Return a GHLClient using stored credentials, or raise 400."""
    api_key = _get_setting(db, "ghl_api_key")
    location_id = _get_setting(db, "ghl_location_id")
    if not api_key or not location_id:
        raise HTTPException(status_code=400, detail="GHL credentials not configured")
    return GHLClient(api_key=api_key, location_id=location_id)


# ── Endpoints ─────────────────────────────────────────────────────────────────


@router.get("/ghl/config", response_model=GHLConfigResponse)
def get_ghl_config(db: Session = Depends(get_db)) -> GHLConfigResponse:
    api_key = _get_setting(db, "ghl_api_key")
    location_id = _get_setting(db, "ghl_location_id") or ""
    return GHLConfigResponse(location_id=location_id, api_key_set=bool(api_key))


@router.put("/ghl/config", response_model=GHLConfigResponse)
def put_ghl_config(body: GHLConfig, db: Session = Depends(get_db)) -> GHLConfigResponse:
    _upsert_setting(db, "ghl_api_key", body.api_key)
    _upsert_setting(db, "ghl_location_id", body.location_id)
    db.commit()
    return GHLConfigResponse(location_id=body.location_id, api_key_set=True)


@router.post("/ghl/test")
async def test_ghl_connection(db: Session = Depends(get_db)) -> dict:
    api_key = _get_setting(db, "ghl_api_key")
    location_id = _get_setting(db, "ghl_location_id")

    if not api_key or not location_id:
        raise HTTPException(status_code=400, detail="GHL credentials not configured")

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Version": GHL_API_VERSION,
    }
    try:
        async with httpx.AsyncClient(base_url=GHL_BASE_URL, headers=headers) as client:
            resp = await client.get(
                f"/locations/{location_id}",
                timeout=10.0,
            )
            resp.raise_for_status()
        return {"ok": True, "status_code": resp.status_code}
    except httpx.HTTPStatusError as exc:
        return {"ok": False, "error": f"HTTP {exc.response.status_code}: {exc.response.text[:200]}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


# ── Pipeline config ───────────────────────────────────────────────────────────

_PIPELINE_FIELDS = [
    "pipeline_id",
    "stage_imd_audited",
    "stage_call_attempted",
    "stage_contacted",
    "stage_call_scheduled",
    "stage_proposal",
    "stage_won",
    "stage_not_interested",
]


@router.put("/ghl/pipeline-config")
def put_pipeline_config(body: GHLPipelineConfig, db: Session = Depends(get_db)) -> dict:
    for field in _PIPELINE_FIELDS:
        value = getattr(body, field)
        if value is not None:
            _upsert_setting(db, f"ghl_pipeline_{field}", value)
        else:
            # Clear the setting if explicitly null
            existing = db.get(Setting, f"ghl_pipeline_{field}")
            if existing:
                db.delete(existing)
    db.commit()
    return {"ok": True}


@router.get("/ghl/pipeline-config")
def get_pipeline_config(db: Session = Depends(get_db)) -> dict:
    result: dict = {}
    for field in _PIPELINE_FIELDS:
        value = _get_setting(db, f"ghl_pipeline_{field}")
        result[field] = value  # None becomes null in JSON — that's the empty default
    return result


# ── Push lead ─────────────────────────────────────────────────────────────────


@router.post("/ghl/push-lead", response_model=PushLeadResponse)
async def push_lead(body: PushLeadRequest, db: Session = Depends(get_db)) -> PushLeadResponse:
    api_key = _get_setting(db, "ghl_api_key")
    location_id = _get_setting(db, "ghl_location_id")

    if not api_key or not location_id:
        raise HTTPException(status_code=400, detail="GHL credentials not configured")

    pipeline_id = _get_setting(db, "ghl_pipeline_pipeline_id")
    stage_id = _get_setting(db, "ghl_pipeline_stage_imd_audited")

    client = GHLClient(api_key=api_key, location_id=location_id)
    scores_dict = body.scores.model_dump() if body.scores else None
    lead_dict = body.lead.model_dump()

    try:
        contact_id, opportunity_id, tags_applied = await client.push_lead(
            lead=lead_dict,
            scores=scores_dict,
            pipeline_id=pipeline_id,
            stage_id=stage_id,
        )
        if contact_id is None:
            return PushLeadResponse(ok=False, error="Could not resolve or create GHL contact")
        return PushLeadResponse(
            ok=True,
            contact_id=contact_id,
            opportunity_id=opportunity_id,
            tags_applied=tags_applied,
        )
    except Exception as exc:
        logger.error("push_lead failed: %s", exc)
        return PushLeadResponse(ok=False, error=str(exc))


# ── Trigger call ──────────────────────────────────────────────────────────────


@router.post("/ghl/trigger-call")
async def trigger_call(body: TriggerCallRequest, db: Session = Depends(get_db)) -> dict:
    api_key = _get_setting(db, "ghl_api_key")
    location_id = _get_setting(db, "ghl_location_id")

    if not api_key or not location_id:
        raise HTTPException(status_code=400, detail="GHL credentials not configured")

    ghl = GHLClient(api_key=api_key, location_id=location_id)
    try:
        ok = await ghl.trigger_call(contact_id=body.contact_id, language=body.language)
        return {"ok": ok}
    except Exception as exc:
        logger.error("trigger_call failed: %s", exc)
        return {"ok": False, "error": str(exc)}


# ── IG DM tracking ────────────────────────────────────────────────────────────


@router.post("/ghl/ig-dm-sent")
def ig_dm_sent(body: IGDMSentRequest) -> dict:
    sent_at = body.sent_at or _utcnow_iso()
    log_path = os.path.join(_log_dir(), "ig_dm_sent.jsonl")
    record = {"contact_id": body.contact_id, "sent_at": sent_at}
    try:
        with open(log_path, "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception as exc:
        logger.error("ig_dm_sent: failed to write log: %s", exc)
    return {"ok": True, "logged_at": sent_at}


@router.post("/ghl/ig-response")
def ig_response(body: IGResponseLogRequest) -> dict:
    responded_at = body.responded_at or _utcnow_iso()
    log_path = os.path.join(_log_dir(), "ig_dm_sent.jsonl")

    # Try to read the last DM sent timestamp for this contact
    hours_to_respond: float | None = None
    d5_score: float | None = None

    if os.path.exists(log_path):
        last_sent: str | None = None
        try:
            with open(log_path) as f:
                for line in f:
                    try:
                        entry = json.loads(line.strip())
                        if entry.get("contact_id") == body.contact_id:
                            last_sent = entry.get("sent_at")
                    except Exception:
                        continue
        except Exception as exc:
            logger.error("ig_response: failed to read log: %s", exc)

        if last_sent:
            try:
                sent_dt = datetime.fromisoformat(last_sent)
                responded_dt = datetime.fromisoformat(responded_at)
                delta_hours = (responded_dt - sent_dt).total_seconds() / 3600
                hours_to_respond = round(delta_hours, 2)
                # D5 score: <1h=20, <4h=15, <24h=10, else 5
                if delta_hours < 1:
                    d5_score = 20.0
                elif delta_hours < 4:
                    d5_score = 15.0
                elif delta_hours < 24:
                    d5_score = 10.0
                else:
                    d5_score = 5.0
            except Exception as exc:
                logger.error("ig_response: failed to compute delta: %s", exc)

    # Append to response log
    response_log_path = os.path.join(_log_dir(), "ig_responses.jsonl")
    record = {
        "contact_id": body.contact_id,
        "responded_at": responded_at,
        "response_type": body.response_type,
        "hours_to_respond": hours_to_respond,
        "d5_score": d5_score,
    }
    try:
        with open(response_log_path, "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception as exc:
        logger.error("ig_response: failed to write log: %s", exc)

    return {"ok": True, "hours_to_respond": hours_to_respond, "d5_score": d5_score}


# ── Call outcome webhook ──────────────────────────────────────────────────────


@router.post("/ghl/webhook/call-outcome")
def call_outcome_webhook(body: CallOutcomePayload) -> dict:
    log_path = os.path.join(_log_dir(), "call_outcomes.jsonl")
    record = {
        "contact_id": body.contact_id,
        "contact_name": body.contact_name,
        "outcome": body.outcome,
        "duration_seconds": body.duration_seconds,
        "notes": body.notes,
        "booking_time": body.booking_time,
        "logged_at": _utcnow_iso(),
    }
    try:
        with open(log_path, "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception as exc:
        logger.error("call_outcome_webhook: failed to write log: %s", exc)
    return {"ok": True}


# ── GHL custom fields ────────────────────────────────────────────────────────


@router.get("/ghl/custom-fields")
async def list_ghl_custom_fields(db: Session = Depends(get_db)) -> dict:
    """Fetch all custom fields defined in the GHL location."""
    client = _require_ghl_client(db)
    fields = await client.get_custom_fields()
    return {"fields": fields, "count": len(fields)}


# ── IMD field config ──────────────────────────────────────────────────────────

_IMD_FIELD_CONFIG_KEY = "ghl_imd_field_config_json"


@router.get("/ghl/imd-field-config")
def get_imd_field_config(db: Session = Depends(get_db)) -> dict:
    """Read stored IMD field-to-GHL-custom-field mapping from settings."""
    raw = _get_setting(db, _IMD_FIELD_CONFIG_KEY)
    if raw:
        try:
            return json.loads(raw)
        except Exception:
            pass
    return GHLIMDFieldConfig().model_dump()


@router.put("/ghl/imd-field-config")
def put_imd_field_config(body: GHLIMDFieldConfig, db: Session = Depends(get_db)) -> dict:
    """Persist IMD field-to-GHL-custom-field mapping in settings."""
    _upsert_setting(db, _IMD_FIELD_CONFIG_KEY, json.dumps(body.model_dump()))
    db.commit()
    return {"ok": True}


# ── Push IMD scores ───────────────────────────────────────────────────────────


class PushIMDScoresRequest(BaseModel):
    contact_id: str
    d1: Optional[float] = None
    d2: Optional[float] = None
    d3: Optional[float] = None
    d4: Optional[float] = None
    d5: Optional[float] = None
    d6: Optional[float] = None


@router.post("/ghl/push-imd-scores")
async def push_imd_scores(body: PushIMDScoresRequest, db: Session = Depends(get_db)) -> dict:
    """Compute totals/classification and push IMD scores to a GHL contact."""
    client = _require_ghl_client(db)

    # Read field mapping from settings
    raw = _get_setting(db, _IMD_FIELD_CONFIG_KEY)
    field_config: dict = {}
    if raw:
        try:
            field_config = json.loads(raw)
        except Exception:
            field_config = {}

    # Collect dimension values
    dimension_values = [
        v for v in (body.d1, body.d2, body.d3, body.d4, body.d5, body.d6)
        if v is not None
    ]
    total = sum(dimension_values)

    if total >= 96:
        classification = "Líder"
    elif total >= 80:
        classification = "Avanzado"
    elif total >= 60:
        classification = "Intermedio"
    else:
        classification = "Básico"

    scores: dict = {
        "d1": body.d1,
        "d2": body.d2,
        "d3": body.d3,
        "d4": body.d4,
        "d5": body.d5,
        "d6": body.d6,
        "total": total,
        "classification": classification,
    }

    ok = await client.push_imd_scores_to_fields(body.contact_id, scores, field_config)

    # Count how many fields were configured and had values
    score_key_to_config_key = {
        "d1": "field_d1",
        "d2": "field_d2",
        "d3": "field_d3",
        "d4": "field_d4",
        "d5": "field_d5",
        "d6": "field_d6",
        "total": "field_total",
        "classification": "field_classification",
    }
    fields_updated = sum(
        1
        for score_key, config_key in score_key_to_config_key.items()
        if field_config.get(config_key) and scores.get(score_key) is not None
    )

    return {"ok": ok, "fields_updated": fields_updated}


# ── IMD auto-score ────────────────────────────────────────────────────────────


@router.post("/imd/auto-score", response_model=IMDAutoScoreResponse)
async def imd_auto_score(body: IMDAutoScoreRequest) -> IMDAutoScoreResponse:
    """Fetch a website and score D1 (Presencia) and D2 (Tecnología) per IMD-120 rubric.

    Failures (unreachable URLs, timeouts) return scores of 0 with the error field set.
    This endpoint never raises a 5xx — network errors are surfaced in the response body.
    """
    result = await _imd_auto_score(body.website)
    return IMDAutoScoreResponse(
        d1_score=result["d1_score"],
        d2_score=result["d2_score"],
        d1_breakdown=result["d1_breakdown"],
        d2_breakdown=result["d2_breakdown"],
        total_auto=result["total_auto"],
        error=result.get("error"),
    )
