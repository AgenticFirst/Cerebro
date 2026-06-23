"""Tests for auto-approval rule CRUD — the persistent "don't ask again" store."""

import uuid


def _hex_id() -> str:
    return uuid.uuid4().hex


def _create_rule(client, **overrides):
    body = {
        "action_type": "send_slack_message",
        "target_key": "C12345",
        "target_label": "#general",
        **overrides,
    }
    r = client.post("/engine/auto-approvals", json=body)
    assert r.status_code in (200, 201)
    return r


def test_create_rule(client):
    r = _create_rule(client)
    assert r.status_code == 201
    body = r.json()
    assert body["action_type"] == "send_slack_message"
    assert body["target_key"] == "C12345"
    assert body["target_label"] == "#general"
    assert "id" in body
    assert "created_at" in body


def test_create_rule_is_idempotent(client):
    first = _create_rule(client)
    assert first.status_code == 201
    rule_id = first.json()["id"]

    # Same (action_type, target_key) — returns existing row, 200 not 201.
    again = _create_rule(client, target_label="#general-renamed")
    assert again.status_code == 200
    body = again.json()
    assert body["id"] == rule_id
    # Label refreshed on re-record.
    assert body["target_label"] == "#general-renamed"

    # Only one row exists.
    r = client.get("/engine/auto-approvals")
    assert r.json()["total"] == 1


def test_list_filters_by_action_and_target(client):
    _create_rule(client, action_type="send_slack_message", target_key="C111", target_label="#a")
    _create_rule(client, action_type="send_slack_file", target_key="C111", target_label="#a")
    _create_rule(client, action_type="send_slack_message", target_key="C222", target_label="#b")

    # Exact-match lookup (what the engine does before gating).
    r = client.get(
        "/engine/auto-approvals",
        params={"action_type": "send_slack_message", "target_key": "C111"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["rules"][0]["target_key"] == "C111"
    assert body["rules"][0]["action_type"] == "send_slack_message"

    # Filter by action_type only.
    r = client.get("/engine/auto-approvals", params={"action_type": "send_slack_message"})
    assert r.json()["total"] == 2

    # No filter → all rules.
    r = client.get("/engine/auto-approvals")
    assert r.json()["total"] == 3


def test_delete_rule_by_id(client):
    rule_id = _create_rule(client).json()["id"]

    r = client.delete(f"/engine/auto-approvals/{rule_id}")
    assert r.status_code == 204

    # Gone.
    r = client.get("/engine/auto-approvals")
    assert r.json()["total"] == 0

    # Deleting again → 404.
    r = client.delete(f"/engine/auto-approvals/{rule_id}")
    assert r.status_code == 404


def test_delete_rules_by_target(client):
    # The chat revoke path: drop both message + file rules for one channel.
    _create_rule(client, action_type="send_slack_message", target_key="C999", target_label="#x")
    _create_rule(client, action_type="send_slack_file", target_key="C999", target_label="#x")
    _create_rule(client, action_type="send_slack_message", target_key="C000", target_label="#y")

    r = client.delete(
        "/engine/auto-approvals",
        params={"action_type": "send_slack_message", "target_key": "C999"},
    )
    assert r.status_code == 200
    assert r.json()["deleted"] == 1

    # Other channel + the file rule untouched.
    r = client.get("/engine/auto-approvals")
    assert r.json()["total"] == 2


def test_delete_by_target_no_match_returns_zero(client):
    r = client.delete(
        "/engine/auto-approvals",
        params={"action_type": "send_slack_message", "target_key": "nope"},
    )
    assert r.status_code == 200
    assert r.json()["deleted"] == 0


def test_store_holds_action_and_module_scoped_rules(client):
    # The store is scope-agnostic: per-action ('*') and per-module
    # ('module:<group>' / '*') rules persist and look up just like destination
    # rules. The engine encodes scope in (action_type, target_key); the backend
    # only needs to store and exact-match them.
    _create_rule(client, action_type="hubspot_create_ticket", target_key="*", target_label="HubSpot tickets")
    _create_rule(client, action_type="module:hubspot", target_key="*", target_label="HubSpot")

    # Per-module exact-match lookup (what the engine does before gating a write).
    r = client.get(
        "/engine/auto-approvals",
        params={"action_type": "module:hubspot", "target_key": "*"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 1
    assert body["rules"][0]["action_type"] == "module:hubspot"
    assert body["rules"][0]["target_key"] == "*"

    # Revoke the module rule by target; the per-action rule is untouched.
    r = client.delete(
        "/engine/auto-approvals",
        params={"action_type": "module:hubspot", "target_key": "*"},
    )
    assert r.json()["deleted"] == 1
    r = client.get("/engine/auto-approvals")
    assert r.json()["total"] == 1
    assert r.json()["rules"][0]["action_type"] == "hubspot_create_ticket"
