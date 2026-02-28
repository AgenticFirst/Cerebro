"""Tests for conversation and message CRUD endpoints."""

import uuid


def _hex_id() -> str:
    return uuid.uuid4().hex


def test_create_conversation(client):
    conv_id = _hex_id()
    r = client.post("/conversations", json={"id": conv_id, "title": "Hello"})
    assert r.status_code == 201
    body = r.json()
    assert body["id"] == conv_id
    assert body["title"] == "Hello"
    assert "created_at" in body
    assert "updated_at" in body
    assert body["messages"] == []


def test_duplicate_conversation_returns_409(client):
    conv_id = _hex_id()
    client.post("/conversations", json={"id": conv_id, "title": "First"})
    r = client.post("/conversations", json={"id": conv_id, "title": "Dupe"})
    assert r.status_code == 409


def test_create_message_and_list(client):
    conv_id = _hex_id()
    client.post("/conversations", json={"id": conv_id, "title": "Chat"})

    # Record original updated_at
    convs = client.get("/conversations").json()["conversations"]
    original_updated = convs[0]["updated_at"]

    msg_id = _hex_id()
    r = client.post(
        f"/conversations/{conv_id}/messages",
        json={"id": msg_id, "role": "user", "content": "Hi there"},
    )
    assert r.status_code == 201
    msg = r.json()
    assert msg["id"] == msg_id
    assert msg["role"] == "user"
    assert msg["content"] == "Hi there"
    assert msg["conversation_id"] == conv_id

    # List should include the message nested, and updated_at should be bumped
    convs = client.get("/conversations").json()["conversations"]
    assert len(convs) == 1
    assert len(convs[0]["messages"]) == 1
    assert convs[0]["messages"][0]["id"] == msg_id
    assert convs[0]["updated_at"] >= original_updated


def test_message_to_missing_conversation_returns_404(client):
    r = client.post(
        f"/conversations/{_hex_id()}/messages",
        json={"id": _hex_id(), "role": "user", "content": "Lost"},
    )
    assert r.status_code == 404


def test_delete_conversation_cascades(client):
    conv_id = _hex_id()
    client.post("/conversations", json={"id": conv_id, "title": "Doomed"})
    client.post(
        f"/conversations/{conv_id}/messages",
        json={"id": _hex_id(), "role": "user", "content": "msg1"},
    )
    client.post(
        f"/conversations/{conv_id}/messages",
        json={"id": _hex_id(), "role": "assistant", "content": "msg2"},
    )

    r = client.delete(f"/conversations/{conv_id}")
    assert r.status_code == 204

    convs = client.get("/conversations").json()["conversations"]
    assert len(convs) == 0


def test_delete_nonexistent_returns_404(client):
    r = client.delete(f"/conversations/{_hex_id()}")
    assert r.status_code == 404
