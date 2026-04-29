"""FastAPI router for outbound integration config endpoints — /integrations/*."""
from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from models import Setting, _utcnow

from .schemas import GHLConfig, GHLConfigResponse

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
                "/contacts/search",
                params={"locationId": location_id, "query": "test"},
                timeout=10.0,
            )
            resp.raise_for_status()
        return {"ok": True, "status_code": resp.status_code}
    except httpx.HTTPStatusError as exc:
        return {"ok": False, "error": f"HTTP {exc.response.status_code}: {exc.response.text[:200]}"}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
