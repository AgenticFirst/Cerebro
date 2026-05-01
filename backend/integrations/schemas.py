from __future__ import annotations

from typing import Optional

from pydantic import BaseModel


class GHLConfig(BaseModel):
    api_key: str
    location_id: str


class GHLConfigResponse(BaseModel):
    location_id: str
    api_key_set: bool


class GHLPipelineConfig(BaseModel):
    pipeline_id: str
    stage_imd_audited: Optional[str] = None
    stage_call_attempted: Optional[str] = None
    stage_contacted: Optional[str] = None
    stage_call_scheduled: Optional[str] = None
    stage_proposal: Optional[str] = None
    stage_won: Optional[str] = None
    stage_not_interested: Optional[str] = None


class LeadData(BaseModel):
    business_name: str
    phone: Optional[str] = None
    email: Optional[str] = None
    website: Optional[str] = None
    instagram: Optional[str] = None
    city: Optional[str] = None
    industry: str = "aesthetic-medicine"
    language: str = "en"


class IMDScores(BaseModel):
    d1: Optional[float] = None
    d2: Optional[float] = None
    d3: Optional[float] = None
    d4: Optional[float] = None
    d5: Optional[float] = None
    d6: Optional[float] = None
    pain_points: list[str] = []
    notes: Optional[str] = None


class PushLeadRequest(BaseModel):
    lead: LeadData
    scores: Optional[IMDScores] = None


class PushLeadResponse(BaseModel):
    ok: bool
    contact_id: Optional[str] = None
    opportunity_id: Optional[str] = None
    tags_applied: list[str] = []
    error: Optional[str] = None


class TriggerCallRequest(BaseModel):
    contact_id: str
    language: str = "en"


class CallOutcomePayload(BaseModel):
    contact_id: Optional[str] = None
    contact_name: Optional[str] = None
    outcome: str  # answered | voicemail | no_answer | booked
    duration_seconds: Optional[int] = None
    notes: Optional[str] = None
    booking_time: Optional[str] = None


class IGDMSentRequest(BaseModel):
    contact_id: str
    sent_at: Optional[str] = None  # ISO timestamp, defaults to now


class IGResponseLogRequest(BaseModel):
    contact_id: str
    responded_at: Optional[str] = None  # ISO timestamp, defaults to now
    response_type: str = "replied"  # replied | ignored


class IMDAutoScoreRequest(BaseModel):
    website: str


class IMDAutoScoreResponse(BaseModel):
    d1_score: float
    d2_score: float
    d1_breakdown: dict
    d2_breakdown: dict
    total_auto: float
    error: Optional[str] = None


class GHLIMDFieldConfig(BaseModel):
    field_d1: Optional[str] = None
    field_d2: Optional[str] = None
    field_d3: Optional[str] = None
    field_d4: Optional[str] = None
    field_d5: Optional[str] = None
    field_d6: Optional[str] = None
    field_total: Optional[str] = None
    field_classification: Optional[str] = None


class GHLCustomField(BaseModel):
    id: str
    name: str
    field_key: Optional[str] = None
    data_type: Optional[str] = None
