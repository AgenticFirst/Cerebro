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


# ── Metadata tests ────────────────────────────────────────────────


def test_create_message_with_metadata(client):
    conv_id = _hex_id()
    client.post("/conversations", json={"id": conv_id, "title": "Meta"})

    msg_id = _hex_id()
    meta = {"engine_run_id": "run123", "routine_proposal": {"name": "Morning"}}
    r = client.post(
        f"/conversations/{conv_id}/messages",
        json={"id": msg_id, "role": "assistant", "content": "ok", "metadata": meta},
    )
    assert r.status_code == 201
    body = r.json()
    assert body["metadata"]["engine_run_id"] == "run123"
    assert body["metadata"]["routine_proposal"]["name"] == "Morning"


def test_create_message_without_metadata_returns_null(client):
    conv_id = _hex_id()
    client.post("/conversations", json={"id": conv_id, "title": "NoMeta"})

    msg_id = _hex_id()
    r = client.post(
        f"/conversations/{conv_id}/messages",
        json={"id": msg_id, "role": "user", "content": "hi"},
    )
    assert r.status_code == 201
    assert r.json()["metadata"] is None


def test_patch_message_metadata(client):
    conv_id = _hex_id()
    client.post("/conversations", json={"id": conv_id, "title": "Patch"})

    msg_id = _hex_id()
    client.post(
        f"/conversations/{conv_id}/messages",
        json={"id": msg_id, "role": "assistant", "content": "response"},
    )

    r = client.patch(
        f"/conversations/{conv_id}/messages/{msg_id}",
        json={"metadata": {"engine_run_id": "run456"}},
    )
    assert r.status_code == 200
    assert r.json()["metadata"]["engine_run_id"] == "run456"


def test_patch_message_metadata_merge_semantics(client):
    conv_id = _hex_id()
    client.post("/conversations", json={"id": conv_id, "title": "Merge"})

    msg_id = _hex_id()
    client.post(
        f"/conversations/{conv_id}/messages",
        json={
            "id": msg_id,
            "role": "assistant",
            "content": "ok",
            "metadata": {"engine_run_id": "run1"},
        },
    )

    # Patch with new key — existing key should be preserved
    r = client.patch(
        f"/conversations/{conv_id}/messages/{msg_id}",
        json={"metadata": {"routine_proposal": {"status": "saved"}}},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["metadata"]["engine_run_id"] == "run1"
    assert body["metadata"]["routine_proposal"]["status"] == "saved"


def test_patch_nonexistent_message_returns_404(client):
    conv_id = _hex_id()
    client.post("/conversations", json={"id": conv_id, "title": "Ghost"})

    r = client.patch(
        f"/conversations/{conv_id}/messages/{_hex_id()}",
        json={"metadata": {"foo": "bar"}},
    )
    assert r.status_code == 404


# ── Expert-scoped conversations (Messages tab) ────────────────────


def _make_expert(client, name: str) -> str:
    r = client.post(
        "/experts",
        json={"name": name, "description": f"desc for {name}", "type": "expert"},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_create_conversation_with_expert_id(client):
    expert_id = _make_expert(client, "Design Lead")
    conv_id = _hex_id()
    r = client.post(
        "/conversations",
        json={"id": conv_id, "title": "Logo crit", "expert_id": expert_id},
    )
    assert r.status_code == 201
    assert r.json()["expert_id"] == expert_id


def test_list_conversations_filtered_by_expert_id(client):
    designer = _make_expert(client, "Designer")
    coder = _make_expert(client, "Coder")

    general_id = _hex_id()
    designer_id = _hex_id()
    coder_id = _hex_id()

    client.post("/conversations", json={"id": general_id, "title": "General"})
    client.post(
        "/conversations",
        json={"id": designer_id, "title": "D1", "expert_id": designer},
    )
    client.post(
        "/conversations",
        json={"id": coder_id, "title": "C1", "expert_id": coder},
    )

    # expert_id query returns only that expert's threads
    r = client.get(f"/conversations?expert_id={designer}")
    ids = {c["id"] for c in r.json()["conversations"]}
    assert ids == {designer_id}

    # scope=general returns only NULL-expert conversations
    r = client.get("/conversations?scope=general")
    ids = {c["id"] for c in r.json()["conversations"]}
    assert general_id in ids
    assert designer_id not in ids
    assert coder_id not in ids

    # scope=expert returns only expert-scoped conversations
    r = client.get("/conversations?scope=expert")
    ids = {c["id"] for c in r.json()["conversations"]}
    assert ids == {designer_id, coder_id}

    # default scope=all still returns everything
    r = client.get("/conversations")
    ids = {c["id"] for c in r.json()["conversations"]}
    assert {general_id, designer_id, coder_id} <= ids


def test_expert_id_defaults_to_null(client):
    conv_id = _hex_id()
    client.post("/conversations", json={"id": conv_id, "title": "Plain"})
    r = client.get("/conversations?scope=general")
    ids = {c["id"] for c in r.json()["conversations"]}
    assert conv_id in ids
