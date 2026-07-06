"""MCP server metadata CRUD + per-expert grants."""

from __future__ import annotations


def _mk_expert(c, name="Drive Reader") -> str:
    res = c.post("/experts", json={"name": name, "description": "reads drive"})
    assert res.status_code == 201, res.text
    return res.json()["id"]


GDRIVE_UPSERT = {
    "id": "srv1",
    "slug": "gdrive",
    "name": "Google Drive",
    "kind": "gdrive",
    "transport": "http",
    "url": "https://drivemcp.googleapis.com/mcp/v1",
    "header_names": ["Authorization"],
    "chat_enabled": True,
    "status": "connected",
    "tools": [
        {"name": "search_files", "description": "Search Drive", "read_only": True},
        {"name": "read_file_content", "description": "Read a file", "read_only": True},
    ],
    "account_label": "carlos@example.com",
}


def test_upsert_list_patch_delete_server(client):
    res = client.put("/mcp-servers/srv1", json=GDRIVE_UPSERT)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["slug"] == "gdrive"
    assert body["chat_enabled"] is True
    assert [t["name"] for t in body["tools"]] == ["search_files", "read_file_content"]
    assert body["tools"][0]["read_only"] is True

    listed = client.get("/mcp-servers").json()
    assert len(listed) == 1

    # Upsert is idempotent on the same id.
    res = client.put("/mcp-servers/srv1", json={**GDRIVE_UPSERT, "name": "Drive"})
    assert res.status_code == 200
    assert res.json()["name"] == "Drive"
    assert len(client.get("/mcp-servers").json()) == 1

    patched = client.patch(
        "/mcp-servers/srv1", json={"chat_enabled": False, "status": "auth_expired"}
    )
    assert patched.status_code == 200
    assert patched.json()["chat_enabled"] is False
    assert patched.json()["status"] == "auth_expired"

    assert client.delete("/mcp-servers/srv1").status_code == 204
    assert client.get("/mcp-servers").json() == []


def test_upsert_validates_kind_transport_status(client):
    bad_kind = {**GDRIVE_UPSERT, "kind": "bogus"}
    assert client.put("/mcp-servers/srv1", json=bad_kind).status_code == 400
    bad_transport = {**GDRIVE_UPSERT, "transport": "ws"}
    assert client.put("/mcp-servers/srv1", json=bad_transport).status_code == 400
    bad_status = {**GDRIVE_UPSERT, "status": "meh"}
    assert client.put("/mcp-servers/srv1", json=bad_status).status_code == 400


def test_slug_conflict_rejected(client):
    assert client.put("/mcp-servers/srv1", json=GDRIVE_UPSERT).status_code == 200
    other = {**GDRIVE_UPSERT, "id": "srv2"}
    assert client.put("/mcp-servers/srv2", json=other).status_code == 409


def test_grant_crud_and_joined_fields(client):
    client.put("/mcp-servers/srv1", json=GDRIVE_UPSERT)
    eid = _mk_expert(client)

    res = client.post(
        f"/experts/{eid}/mcp-grants", json={"mcp_server_id": "srv1"}
    )
    assert res.status_code == 201, res.text
    grant = res.json()
    assert grant["all_tools"] is True
    assert grant["server_slug"] == "gdrive"
    assert grant["server_status"] == "connected"
    assert grant["server_account_label"] == "carlos@example.com"
    assert [t["name"] for t in grant["server_tools"]] == [
        "search_files",
        "read_file_content",
    ]

    # Duplicate grant rejected.
    dup = client.post(f"/experts/{eid}/mcp-grants", json={"mcp_server_id": "srv1"})
    assert dup.status_code == 409

    patched = client.patch(
        f"/experts/{eid}/mcp-grants/{grant['id']}",
        json={"all_tools": False, "selected_tools": ["search_files"]},
    )
    assert patched.status_code == 200
    assert patched.json()["all_tools"] is False
    assert patched.json()["selected_tools"] == ["search_files"]

    assert (
        client.delete(f"/experts/{eid}/mcp-grants/{grant['id']}").status_code == 204
    )
    assert client.get(f"/experts/{eid}/mcp-grants").json() == []


def test_grant_rejects_unknown_expert_and_server(client):
    client.put("/mcp-servers/srv1", json=GDRIVE_UPSERT)
    assert (
        client.post(
            "/experts/nope/mcp-grants", json={"mcp_server_id": "srv1"}
        ).status_code
        == 404
    )
    eid = _mk_expert(client)
    assert (
        client.post(
            f"/experts/{eid}/mcp-grants", json={"mcp_server_id": "missing"}
        ).status_code
        == 404
    )


def test_deleting_server_removes_grants(client):
    client.put("/mcp-servers/srv1", json=GDRIVE_UPSERT)
    eid = _mk_expert(client)
    client.post(f"/experts/{eid}/mcp-grants", json={"mcp_server_id": "srv1"})
    assert client.delete("/mcp-servers/srv1").status_code == 204
    assert client.get(f"/experts/{eid}/mcp-grants").json() == []


def test_mcp_tables_are_local_only():
    from cloud_sync.config import LOCAL_ONLY_TABLES, is_local_only_setting

    assert "mcp_servers" in LOCAL_ONLY_TABLES
    assert "expert_mcp_grants" in LOCAL_ONLY_TABLES
    assert is_local_only_setting("mcp_srv1_access_token")
