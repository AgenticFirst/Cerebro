"""Tests for the /imd/audits CRUD API."""
import pytest


# ── Helpers ───────────────────────────────────────────────────────────────────


def _create_audit(client, **kwargs):
    payload = {"business_name": "Test Business", **kwargs}
    return client.post("/imd/audits", json=payload)


# ── Tests ──────────────────────────────────────────────────────────────────────


def test_create_audit_minimal(client):
    resp = client.post("/imd/audits", json={"business_name": "Minimal Clinic"})
    assert resp.status_code == 201
    data = resp.json()
    assert "id" in data
    assert len(data["id"]) == 32
    assert data["business_name"] == "Minimal Clinic"
    assert data["pipeline_stage"] == "raw"
    assert data["industry"] == "aesthetic-medicine"
    assert data["total"] is None
    assert data["classification"] is None


def test_create_audit_with_scores_computes_total(client):
    resp = client.post(
        "/imd/audits",
        json={
            "business_name": "Score Test Clinic",
            "d1": 16,
            "d2": 12,
            "d3": 14,
            "d4": 17,
        },
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["total"] == pytest.approx(59.0)
    assert data["classification"] == "Básico"


def test_create_lider_audit(client):
    resp = client.post(
        "/imd/audits",
        json={
            "business_name": "Líder Clinic",
            "d1": 20,
            "d2": 20,
            "d3": 18,
            "d4": 19,
            "d5": 16,
            "d6": 18,
        },
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["total"] == pytest.approx(111.0)
    assert data["classification"] == "Líder"


def test_list_audits_empty(client):
    resp = client.get("/imd/audits")
    assert resp.status_code == 200
    assert resp.json() == []


def test_list_audits_filter_by_industry(client):
    client.post(
        "/imd/audits",
        json={"business_name": "Aesthetic Clinic", "industry": "aesthetic-medicine"},
    )
    client.post(
        "/imd/audits",
        json={"business_name": "Dental Clinic", "industry": "dental"},
    )
    resp = client.get("/imd/audits?industry=dental")
    assert resp.status_code == 200
    results = resp.json()
    assert len(results) == 1
    assert results[0]["business_name"] == "Dental Clinic"
    assert results[0]["industry"] == "dental"


def test_get_audit_by_id(client):
    create_resp = client.post("/imd/audits", json={"business_name": "Fetch Me"})
    assert create_resp.status_code == 201
    audit_id = create_resp.json()["id"]

    resp = client.get(f"/imd/audits/{audit_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] == audit_id
    assert data["business_name"] == "Fetch Me"


def test_get_audit_not_found(client):
    resp = client.get("/imd/audits/nonexistent_id_that_does_not_exist")
    assert resp.status_code == 404


def test_patch_audit_updates_scores(client):
    # Create with d1-d4 scores → total=59, Básico
    create_resp = client.post(
        "/imd/audits",
        json={
            "business_name": "Patch Clinic",
            "d1": 16,
            "d2": 12,
            "d3": 14,
            "d4": 17,
        },
    )
    assert create_resp.status_code == 201
    audit_id = create_resp.json()["id"]

    # Add d5=14 → total should now be 73, classification becomes Intermedio (>=60)
    resp = client.patch(f"/imd/audits/{audit_id}", json={"d5": 14})
    assert resp.status_code == 200
    data = resp.json()
    assert data["d5"] == pytest.approx(14.0)
    assert data["total"] == pytest.approx(73.0)
    assert data["classification"] == "Intermedio"


def test_patch_audit_stage(client):
    create_resp = client.post("/imd/audits", json={"business_name": "Stage Clinic"})
    assert create_resp.status_code == 201
    audit_id = create_resp.json()["id"]

    resp = client.patch(f"/imd/audits/{audit_id}", json={"pipeline_stage": "called"})
    assert resp.status_code == 200
    assert resp.json()["pipeline_stage"] == "called"


def test_delete_audit(client):
    create_resp = client.post("/imd/audits", json={"business_name": "Delete Me"})
    assert create_resp.status_code == 201
    audit_id = create_resp.json()["id"]

    del_resp = client.delete(f"/imd/audits/{audit_id}")
    assert del_resp.status_code == 204

    get_resp = client.get(f"/imd/audits/{audit_id}")
    assert get_resp.status_code == 404


def test_audit_stats(client):
    # Create a Básico audit (d1=10 → total=10)
    client.post(
        "/imd/audits",
        json={"business_name": "Clinic A", "d1": 10, "industry": "aesthetic-medicine"},
    )
    # Create a Líder audit
    client.post(
        "/imd/audits",
        json={
            "business_name": "Clinic B",
            "d1": 20,
            "d2": 20,
            "d3": 18,
            "d4": 19,
            "d5": 16,
            "d6": 18,
            "industry": "dental",
        },
    )

    resp = client.get("/imd/audits/stats")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    assert data["by_classification"]["Básico"] == 1
    assert data["by_classification"]["Líder"] == 1
    assert data["by_industry"]["aesthetic-medicine"] == 1
    assert data["by_industry"]["dental"] == 1
    # Both use default pipeline_stage "raw"
    assert data["by_stage"]["raw"] == 2
