"""Tests for settings CRUD endpoints."""


def test_list_settings_empty(client):
    res = client.get("/settings")
    assert res.status_code == 200
    assert res.json() == []


def test_upsert_and_get_setting(client):
    # Create
    res = client.put("/settings/theme", json={"value": "dark"})
    assert res.status_code == 200
    data = res.json()
    assert data["key"] == "theme"
    assert data["value"] == "dark"
    assert "updated_at" in data

    # Read back
    res = client.get("/settings/theme")
    assert res.status_code == 200
    assert res.json()["value"] == "dark"

    # Update (upsert)
    res = client.put("/settings/theme", json={"value": "light"})
    assert res.status_code == 200
    assert res.json()["value"] == "light"


def test_get_missing_setting_404(client):
    res = client.get("/settings/nonexistent")
    assert res.status_code == 404


def test_list_settings(client):
    client.put("/settings/a", json={"value": "1"})
    client.put("/settings/b", json={"value": "2"})
    res = client.get("/settings")
    assert res.status_code == 200
    keys = [s["key"] for s in res.json()]
    assert keys == ["a", "b"]


def test_delete_setting(client):
    client.put("/settings/temp", json={"value": "val"})
    res = client.delete("/settings/temp")
    assert res.status_code == 204

    # Verify gone
    res = client.get("/settings/temp")
    assert res.status_code == 404


def test_delete_missing_setting_idempotent(client):
    res = client.delete("/settings/nonexistent")
    assert res.status_code == 204
