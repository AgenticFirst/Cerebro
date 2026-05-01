from __future__ import annotations
from datetime import datetime
from typing import Optional
from pydantic import BaseModel


class IMDAuditCreate(BaseModel):
    business_name: str
    phone: Optional[str] = None
    email: Optional[str] = None
    website: Optional[str] = None
    instagram: Optional[str] = None
    city: Optional[str] = None
    industry: str = "aesthetic-medicine"
    language: str = "en"
    ghl_contact_id: Optional[str] = None
    ghl_opportunity_id: Optional[str] = None
    d1: Optional[float] = None
    d2: Optional[float] = None
    d3: Optional[float] = None
    d4: Optional[float] = None
    d5: Optional[float] = None
    d6: Optional[float] = None
    pain_points: Optional[list[str]] = None
    notes: Optional[str] = None
    pipeline_stage: str = "raw"


class IMDAuditUpdate(BaseModel):
    phone: Optional[str] = None
    email: Optional[str] = None
    website: Optional[str] = None
    instagram: Optional[str] = None
    city: Optional[str] = None
    ghl_contact_id: Optional[str] = None
    ghl_opportunity_id: Optional[str] = None
    d1: Optional[float] = None
    d2: Optional[float] = None
    d3: Optional[float] = None
    d4: Optional[float] = None
    d5: Optional[float] = None
    d6: Optional[float] = None
    d1_breakdown: Optional[dict] = None
    d2_breakdown: Optional[dict] = None
    pain_points: Optional[list[str]] = None
    d5_dm_sent_at: Optional[datetime] = None
    d5_responded_at: Optional[datetime] = None
    d5_hours_to_respond: Optional[float] = None
    d6_called_at: Optional[datetime] = None
    d6_call_outcome: Optional[str] = None
    pipeline_stage: Optional[str] = None
    notes: Optional[str] = None


class IMDAuditRead(BaseModel):
    id: str
    business_name: str
    phone: Optional[str]
    email: Optional[str]
    website: Optional[str]
    instagram: Optional[str]
    city: Optional[str]
    industry: str
    language: str
    ghl_contact_id: Optional[str]
    ghl_opportunity_id: Optional[str]
    d1: Optional[float]
    d2: Optional[float]
    d3: Optional[float]
    d4: Optional[float]
    d5: Optional[float]
    d6: Optional[float]
    total: Optional[float]
    classification: Optional[str]
    d1_breakdown: Optional[dict]
    d2_breakdown: Optional[dict]
    pain_points: Optional[list[str]]
    d5_dm_sent_at: Optional[datetime]
    d5_responded_at: Optional[datetime]
    d5_hours_to_respond: Optional[float]
    d6_called_at: Optional[datetime]
    d6_call_outcome: Optional[str]
    pipeline_stage: str
    notes: Optional[str]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
