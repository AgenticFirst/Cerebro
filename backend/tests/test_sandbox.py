"""Tests for the sandbox configuration endpoints."""


def test_sandbox_default_enabled_survives_first_conversation(client):
    # A fresh install defaults sandboxing to enabled.
    first = client.get("/sandbox/config")
    assert first.status_code == 200
    assert first.json()["enabled"] is True

    # Creating the first conversation must not silently disable the sandbox.
    conv_id = "a" * 32
    r = client.post("/conversations", json={"id": conv_id, "title": "First chat"})
    assert r.status_code == 201

    second = client.get("/sandbox/config")
    assert second.status_code == 200
    assert second.json()["enabled"] is True


def test_sandbox_disable_persists_across_reads(client):
    # An explicit disable must stick even though there are no conversations yet.
    r = client.patch("/sandbox/config", json={"enabled": False})
    assert r.status_code == 200
    assert r.json()["enabled"] is False

    again = client.get("/sandbox/config")
    assert again.status_code == 200
    assert again.json()["enabled"] is False
