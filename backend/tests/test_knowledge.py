"""Tests for the Knowledge Base API — /knowledge/* endpoints.

Covers the Notion-style nested-page model: create + nest, tree shape + order,
content round-trip, move/reorder (incl. cycle guard), archive cascade + trash,
restore, and hard-delete cascade.
"""


def _create(client, **body):
    res = client.post("/knowledge/pages", json=body)
    assert res.status_code == 201, res.text
    return res.json()


def test_create_and_get_page(client):
    page = _create(client, title="Getting Started", icon="📘")
    assert page["title"] == "Getting Started"
    assert page["icon"] == "📘"
    assert page["parent_id"] is None
    assert page["is_archived"] is False

    got = client.get(f"/knowledge/pages/{page['id']}")
    assert got.status_code == 200
    assert got.json()["id"] == page["id"]


def test_get_missing_page_404(client):
    assert client.get("/knowledge/pages/nope").status_code == 404


def test_nested_tree_shape_and_order(client):
    root = _create(client, title="Root")
    child_b = _create(client, title="B", parent_id=root["id"], sort_order=2.0)
    child_a = _create(client, title="A", parent_id=root["id"], sort_order=1.0)
    grandchild = _create(client, title="Grand", parent_id=child_a["id"])

    tree = client.get("/knowledge/pages").json()["pages"]
    assert len(tree) == 1
    root_node = tree[0]
    assert root_node["id"] == root["id"]
    assert root_node["has_children"] is True
    # Ordered by sort_order: A (1.0) before B (2.0).
    titles = [c["title"] for c in root_node["children"]]
    assert titles == ["A", "B"]
    a_node = root_node["children"][0]
    assert a_node["children"][0]["id"] == grandchild["id"]
    assert child_b["id"] in [c["id"] for c in root_node["children"]]


def test_create_under_missing_parent_404(client):
    res = client.post("/knowledge/pages", json={"title": "x", "parent_id": "ghost"})
    assert res.status_code == 404


def test_content_round_trip(client):
    page = _create(client, title="Doc")
    payload = {
        "content_json": '[{"type":"heading","content":"Hi"}]',
        "content_markdown": "# Hi",
        "title": "Doc v2",
    }
    res = client.patch(f"/knowledge/pages/{page['id']}", json=payload)
    assert res.status_code == 200
    body = res.json()
    assert body["title"] == "Doc v2"
    assert body["content_json"] == payload["content_json"]
    assert body["content_markdown"] == "# Hi"


def test_move_into_self_rejected(client):
    root = _create(client, title="Root")
    child = _create(client, title="Child", parent_id=root["id"])
    # Moving root under its own descendant must be rejected.
    res = client.patch(f"/knowledge/pages/{root['id']}", json={"parent_id": child["id"]})
    assert res.status_code == 400


def test_reorder_and_reparent(client):
    root = _create(client, title="Root")
    a = _create(client, title="A", parent_id=root["id"])
    b = _create(client, title="B")

    res = client.post(
        "/knowledge/pages/reorder",
        json={"items": [{"id": b["id"], "parent_id": root["id"], "sort_order": 5.0}]},
    )
    assert res.status_code == 204

    tree = client.get("/knowledge/pages").json()["pages"]
    root_node = next(n for n in tree if n["id"] == root["id"])
    child_ids = {c["id"] for c in root_node["children"]}
    assert child_ids == {a["id"], b["id"]}


def test_archive_cascades_and_appears_in_trash(client):
    root = _create(client, title="Root")
    child = _create(client, title="Child", parent_id=root["id"])

    res = client.patch(f"/knowledge/pages/{root['id']}", json={"is_archived": True})
    assert res.status_code == 200

    # Both gone from the active tree.
    assert client.get("/knowledge/pages").json()["pages"] == []

    trash_ids = {p["id"] for p in client.get("/knowledge/trash").json()["pages"]}
    assert root["id"] in trash_ids and child["id"] in trash_ids


def test_restore_cascades(client):
    root = _create(client, title="Root")
    child = _create(client, title="Child", parent_id=root["id"])
    client.patch(f"/knowledge/pages/{root['id']}", json={"is_archived": True})

    res = client.patch(f"/knowledge/pages/{root['id']}", json={"is_archived": False})
    assert res.status_code == 200

    tree = client.get("/knowledge/pages").json()["pages"]
    assert len(tree) == 1
    assert tree[0]["children"][0]["id"] == child["id"]
    assert client.get("/knowledge/trash").json()["pages"] == []


def test_hard_delete_cascades(client):
    root = _create(client, title="Root")
    child = _create(client, title="Child", parent_id=root["id"])

    res = client.delete(f"/knowledge/pages/{root['id']}")
    assert res.status_code == 204

    assert client.get(f"/knowledge/pages/{root['id']}").status_code == 404
    # Child cascaded away via FK ondelete=CASCADE.
    assert client.get(f"/knowledge/pages/{child['id']}").status_code == 404


def test_delete_missing_404(client):
    assert client.delete("/knowledge/pages/ghost").status_code == 404
