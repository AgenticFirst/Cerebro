"""Tests for Google Places lead research endpoints."""
from __future__ import annotations


# ── Places config ─────────────────────────────────────────────────────────────


def test_get_places_config_empty(client):
    """GET /integrations/places/config returns {api_key_set: false} on fresh DB."""
    resp = client.get("/integrations/places/config")
    assert resp.status_code == 200
    body = resp.json()
    assert body["api_key_set"] is False


def test_set_places_config(client):
    """PUT then GET round-trips the Places API key, returns {api_key_set: true}."""
    put_resp = client.put(
        "/integrations/places/config",
        json={"api_key": "my-places-api-key"},
    )
    assert put_resp.status_code == 200
    assert put_resp.json().get("ok") is True

    get_resp = client.get("/integrations/places/config")
    assert get_resp.status_code == 200
    assert get_resp.json()["api_key_set"] is True


# ── Places search ─────────────────────────────────────────────────────────────


def test_search_requires_api_key(client):
    """POST /integrations/places/search returns 400 when no API key is configured."""
    resp = client.post(
        "/integrations/places/search",
        json={"query": "plastic surgery", "city": "Fort Lauderdale", "state": "FL"},
    )
    assert resp.status_code == 400
    assert "places api key" in resp.json()["detail"].lower()


def test_search_with_fake_key_returns_ok_shape(client):
    """With API key set, search returns {ok: bool, results: list, count: int, query_used: str}.

    The actual Google call will fail (fake key), but the endpoint must not 500.
    """
    client.put("/integrations/places/config", json={"api_key": "fake-key-abc"})
    resp = client.post(
        "/integrations/places/search",
        json={"query": "plastic surgery", "city": "Fort Lauderdale", "state": "FL"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "ok" in body
    assert isinstance(body["ok"], bool)
    assert "results" in body
    assert isinstance(body["results"], list)
    assert "count" in body
    assert isinstance(body["count"], int)
    assert "query_used" in body
    assert isinstance(body["query_used"], str)


def test_search_with_create_audits_false_no_db_records(client):
    """Search with create_audits=False does not create any audit records."""
    client.put("/integrations/places/config", json={"api_key": "fake-key-abc"})
    client.post(
        "/integrations/places/search",
        json={
            "query": "medspa",
            "city": "Miami",
            "state": "FL",
            "create_audits": False,
        },
    )
    # Verify no audit records were created
    audits_resp = client.get("/imd/audits")
    assert audits_resp.status_code == 200
    assert audits_resp.json() == []


def test_search_query_built_correctly(client):
    """query_used in the response contains the query + city."""
    client.put("/integrations/places/config", json={"api_key": "fake-key-abc"})
    resp = client.post(
        "/integrations/places/search",
        json={"query": "dental clinic", "city": "Orlando", "state": "FL"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "query_used" in body
    query_used = body["query_used"]
    assert "dental clinic" in query_used
    assert "Orlando" in query_used
