"""Tests for GoHighLevel integration endpoints under /integrations/*."""
from __future__ import annotations


# ── GHL config ────────────────────────────────────────────────────────────────


def test_get_ghl_config_empty(client):
    """Fresh DB returns empty location_id and api_key_set=false."""
    resp = client.get("/integrations/ghl/config")
    assert resp.status_code == 200
    body = resp.json()
    assert body["api_key_set"] is False
    assert body["location_id"] == ""


def test_set_and_get_ghl_config(client):
    """PUT then GET round-trips location_id and marks api_key_set=true."""
    put_resp = client.put(
        "/integrations/ghl/config",
        json={"api_key": "test-key-abc", "location_id": "loc-123"},
    )
    assert put_resp.status_code == 200
    put_body = put_resp.json()
    assert put_body["api_key_set"] is True
    assert put_body["location_id"] == "loc-123"

    get_resp = client.get("/integrations/ghl/config")
    assert get_resp.status_code == 200
    get_body = get_resp.json()
    assert get_body["api_key_set"] is True
    assert get_body["location_id"] == "loc-123"


# ── GHL test connection ───────────────────────────────────────────────────────


def test_test_ghl_connection_requires_credentials(client):
    """POST /integrations/ghl/test returns 400 when no credentials are stored."""
    resp = client.post("/integrations/ghl/test")
    assert resp.status_code == 400
    assert "credentials" in resp.json()["detail"].lower()


def test_test_ghl_connection_with_credentials_returns_ok_field(client):
    """With credentials set, test returns {ok: bool} (network will fail but no 500)."""
    client.put(
        "/integrations/ghl/config",
        json={"api_key": "fake-key", "location_id": "fake-loc"},
    )
    resp = client.post("/integrations/ghl/test")
    # Must not be 500; actual GHL call will fail so ok=false is expected
    assert resp.status_code == 200
    body = resp.json()
    assert "ok" in body
    assert isinstance(body["ok"], bool)


# ── Pipeline config ───────────────────────────────────────────────────────────


def test_set_pipeline_config(client):
    """Store pipeline config and read it back with correct values."""
    payload = {
        "pipeline_id": "pipe-abc",
        "stage_imd_audited": "stage-001",
        "stage_call_attempted": "stage-002",
        "stage_contacted": None,
        "stage_call_scheduled": None,
        "stage_proposal": None,
        "stage_won": None,
        "stage_not_interested": None,
    }
    put_resp = client.put("/integrations/ghl/pipeline-config", json=payload)
    assert put_resp.status_code == 200
    assert put_resp.json().get("ok") is True

    get_resp = client.get("/integrations/ghl/pipeline-config")
    assert get_resp.status_code == 200
    body = get_resp.json()
    assert body["pipeline_id"] == "pipe-abc"
    assert body["stage_imd_audited"] == "stage-001"
    assert body["stage_call_attempted"] == "stage-002"
    # Fields not set should be null/None
    assert body["stage_contacted"] is None


def test_get_pipeline_config_empty_defaults(client):
    """GET pipeline config on fresh DB returns all null values."""
    resp = client.get("/integrations/ghl/pipeline-config")
    assert resp.status_code == 200
    body = resp.json()
    assert body["pipeline_id"] is None
    assert body["stage_imd_audited"] is None


# ── Push lead ─────────────────────────────────────────────────────────────────


def test_push_lead_requires_ghl_credentials(client):
    """POST /integrations/ghl/push-lead returns 400 when no credentials stored."""
    resp = client.post(
        "/integrations/ghl/push-lead",
        json={
            "lead": {"business_name": "Test Clinic"},
        },
    )
    assert resp.status_code == 400
    assert "credentials" in resp.json()["detail"].lower()


def test_push_lead_structure(client):
    """With credentials set, push-lead returns proper PushLeadResponse shape.

    The actual GHL network call will fail (fake key), so ok=false is expected,
    but the endpoint must not return 500.
    """
    client.put(
        "/integrations/ghl/config",
        json={"api_key": "fake-key", "location_id": "fake-loc"},
    )
    resp = client.post(
        "/integrations/ghl/push-lead",
        json={
            "lead": {
                "business_name": "Test Clinic",
                "phone": "+1555000000",
                "email": "test@example.com",
                "website": "https://test.example.com",
                "industry": "aesthetic-medicine",
                "language": "en",
            },
            "scores": {
                "d1": 15.0,
                "d2": 12.0,
                "pain_points": ["low online presence"],
            },
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "ok" in body
    assert isinstance(body["ok"], bool)
    # Whether ok or not, the response must carry these keys
    assert "contact_id" in body
    assert "opportunity_id" in body
    assert "tags_applied" in body
    assert isinstance(body["tags_applied"], list)


# ── Trigger call ──────────────────────────────────────────────────────────────


def test_trigger_call_requires_credentials(client):
    """POST /integrations/ghl/trigger-call returns 400 without credentials."""
    resp = client.post(
        "/integrations/ghl/trigger-call",
        json={"contact_id": "contact-xyz", "language": "en"},
    )
    assert resp.status_code == 400
    assert "credentials" in resp.json()["detail"].lower()


def test_trigger_call_with_credentials_returns_ok_field(client):
    """With credentials, trigger-call returns {ok: bool}, not a 500."""
    client.put(
        "/integrations/ghl/config",
        json={"api_key": "fake-key", "location_id": "fake-loc"},
    )
    resp = client.post(
        "/integrations/ghl/trigger-call",
        json={"contact_id": "contact-xyz", "language": "es"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "ok" in body
    assert isinstance(body["ok"], bool)


# ── IG DM tracking ────────────────────────────────────────────────────────────


def test_ig_dm_sent_logs(client):
    """POST ig-dm-sent returns ok=true and a logged_at timestamp."""
    resp = client.post(
        "/integrations/ghl/ig-dm-sent",
        json={"contact_id": "contact-abc"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert "logged_at" in body
    assert body["logged_at"]  # non-empty string


def test_ig_dm_sent_accepts_explicit_timestamp(client):
    """ig-dm-sent echoes back the caller-supplied sent_at value."""
    sent_at = "2026-04-30T12:00:00+00:00"
    resp = client.post(
        "/integrations/ghl/ig-dm-sent",
        json={"contact_id": "contact-abc", "sent_at": sent_at},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["logged_at"] == sent_at


def test_ig_response_without_prior_dm(client):
    """ig-response for a contact with no prior DM returns ok=true, hours_to_respond=null."""
    resp = client.post(
        "/integrations/ghl/ig-response",
        json={"contact_id": "contact-no-dm", "response_type": "replied"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["hours_to_respond"] is None
    assert body["d5_score"] is None


def test_ig_response_after_dm_computes_hours(client, tmp_path, monkeypatch):
    """ig-response after a DM was sent computes hours_to_respond and a d5_score."""
    monkeypatch.setenv("GHL_LOG_DIR", str(tmp_path / "ghl-logs"))

    contact_id = "contact-with-dm"

    # Send the DM first
    sent_at = "2026-04-30T10:00:00+00:00"
    dm_resp = client.post(
        "/integrations/ghl/ig-dm-sent",
        json={"contact_id": contact_id, "sent_at": sent_at},
    )
    assert dm_resp.status_code == 200

    # Respond 2 hours later (should give d5_score=15)
    responded_at = "2026-04-30T12:00:00+00:00"
    resp = client.post(
        "/integrations/ghl/ig-response",
        json={
            "contact_id": contact_id,
            "responded_at": responded_at,
            "response_type": "replied",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["hours_to_respond"] == 2.0
    assert body["d5_score"] == 15.0


# ── Call outcome webhook ──────────────────────────────────────────────────────


def test_call_outcome_webhook_logs(client):
    """POST /integrations/ghl/webhook/call-outcome returns ok=true."""
    resp = client.post(
        "/integrations/ghl/webhook/call-outcome",
        json={
            "contact_id": "contact-xyz",
            "contact_name": "Dr. Smith",
            "outcome": "answered",
            "duration_seconds": 120,
            "notes": "Interested in follow-up",
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True


def test_call_outcome_webhook_minimal_payload(client):
    """Only required field (outcome) — endpoint still returns ok=true."""
    resp = client.post(
        "/integrations/ghl/webhook/call-outcome",
        json={"outcome": "voicemail"},
    )
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


# ── IMD auto-score ────────────────────────────────────────────────────────────


def test_imd_auto_score_invalid_url(client):
    """Unreachable URL returns all-zero scores with error field set (not a 500)."""
    resp = client.post(
        "/integrations/imd/auto-score",
        json={"website": "https://this-domain-does-not-exist-at-all-xyz.invalid"},
    )
    assert resp.status_code == 200
    body = resp.json()
    # Scores must be 0 when the site is unreachable
    assert body["d1_score"] == 0.0
    assert body["d2_score"] == 0.0
    assert body["total_auto"] == 0.0
    # Error must be populated
    assert body["error"] is not None
    assert body["error"] != ""
    # Shape must be complete
    assert "d1_breakdown" in body
    assert "d2_breakdown" in body
    assert isinstance(body["d1_breakdown"], dict)
    assert isinstance(body["d2_breakdown"], dict)


def test_imd_auto_score_response_shape(client):
    """Response always includes all required fields regardless of outcome."""
    resp = client.post(
        "/integrations/imd/auto-score",
        json={"website": "https://unreachable.example.invalid"},
    )
    assert resp.status_code == 200
    body = resp.json()
    for key in ("d1_score", "d2_score", "d1_breakdown", "d2_breakdown", "total_auto"):
        assert key in body, f"missing required field '{key}' in /imd/auto-score response"


# ── GHL custom fields ─────────────────────────────────────────────────────────


def test_get_custom_fields_requires_credentials(client):
    """GET /integrations/ghl/custom-fields returns 400 without stored credentials."""
    resp = client.get("/integrations/ghl/custom-fields")
    assert resp.status_code == 400
    assert "credentials" in resp.json()["detail"].lower()


def test_get_custom_fields_returns_fields_shape(client):
    """With credentials set, custom-fields returns {fields: list, count: int}.

    The real GHL network call will fail (fake credentials), but the endpoint
    must still return 200 with the expected shape (empty list on network error).
    """
    client.put(
        "/integrations/ghl/config",
        json={"api_key": "fake-key", "location_id": "fake-loc"},
    )
    resp = client.get("/integrations/ghl/custom-fields")
    assert resp.status_code == 200
    body = resp.json()
    assert "fields" in body
    assert "count" in body
    assert isinstance(body["fields"], list)
    assert isinstance(body["count"], int)
    assert body["count"] == len(body["fields"])


# ── IMD field config ──────────────────────────────────────────────────────────


def test_set_and_get_imd_field_config(client):
    """PUT then GET round-trips the IMD field config including pipeline_id."""
    payload = {
        "field_d1": "field-id-d1",
        "field_d2": "field-id-d2",
        "field_d3": None,
        "field_d4": None,
        "field_d5": None,
        "field_d6": None,
        "field_total": "field-id-total",
        "field_classification": "field-id-class",
    }
    put_resp = client.put("/integrations/ghl/imd-field-config", json=payload)
    assert put_resp.status_code == 200
    assert put_resp.json().get("ok") is True

    get_resp = client.get("/integrations/ghl/imd-field-config")
    assert get_resp.status_code == 200
    body = get_resp.json()
    assert body["field_d1"] == "field-id-d1"
    assert body["field_d2"] == "field-id-d2"
    assert body["field_d3"] is None
    assert body["field_total"] == "field-id-total"
    assert body["field_classification"] == "field-id-class"


# ── Push IMD scores ───────────────────────────────────────────────────────────


def test_push_imd_scores_requires_credentials(client):
    """POST /integrations/ghl/push-imd-scores returns 400 without credentials."""
    resp = client.post(
        "/integrations/ghl/push-imd-scores",
        json={"contact_id": "contact-xyz", "d1": 15.0, "d2": 12.0},
    )
    assert resp.status_code == 400
    assert "credentials" in resp.json()["detail"].lower()


def test_push_imd_scores_no_fields_configured(client):
    """With credentials but no field config, returns ok=False or fields_updated=0."""
    client.put(
        "/integrations/ghl/config",
        json={"api_key": "fake-key", "location_id": "fake-loc"},
    )
    # No IMD field config stored — all field_* values are None
    resp = client.post(
        "/integrations/ghl/push-imd-scores",
        json={"contact_id": "contact-xyz", "d1": 15.0, "d2": 12.0},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "ok" in body
    # When no fields are configured, either ok=False or ok=True with fields_updated=0
    assert body["ok"] is False or body.get("fields_updated", 0) == 0
