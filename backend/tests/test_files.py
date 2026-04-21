"""Contract tests for the Files/Buckets API (backend/files/router.py).

Tests cover bucket CRUD, file item CRUD, listing with filters/ordering,
soft/hard delete semantics, and validation of source/storage_kind fields.
"""

import uuid


# ── Buckets: Basic CRUD ──────────────────────────────────────────────


def test_list_buckets_includes_default_seeded_bucket(client):
    """Database init seeds a 'Default' bucket with is_default=True."""
    r = client.get("/files/buckets")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body, list)
    assert len(body) >= 1
    default = next((b for b in body if b.get("is_default")), None)
    assert default is not None
    assert default["name"] == "Default"
    assert default["is_pinned"] is True


def test_create_bucket_with_name_only(client):
    """POST /buckets with just name; verify defaults."""
    r = client.post("/files/buckets", json={"name": "My Bucket"})
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "My Bucket"
    assert body["is_default"] is False
    assert body["is_pinned"] is False
    assert body["file_count"] == 0
    assert body["color"] is None
    assert body["icon"] is None
    assert body["sort_order"] == 0.0
    assert "id" in body
    assert "created_at" in body
    assert "updated_at" in body


def test_create_bucket_with_all_fields(client):
    """POST /buckets with name, color, icon, is_pinned."""
    r = client.post("/files/buckets", json={
        "name": "Shared Docs",
        "color": "#FF5733",
        "icon": "folder",
        "is_pinned": True,
    })
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Shared Docs"
    assert body["color"] == "#FF5733"
    assert body["icon"] == "folder"
    assert body["is_pinned"] is True


def test_create_bucket_with_name_too_long_returns_422(client):
    """POST with name exceeding max_length (255) → 422."""
    long_name = "x" * 256
    r = client.post("/files/buckets", json={"name": long_name})
    assert r.status_code == 422


def test_create_bucket_strips_whitespace_from_name(client):
    """POST with name='  Trimmed  ' → stored as 'Trimmed'."""
    r = client.post("/files/buckets", json={"name": "  Trimmed  "})
    assert r.status_code == 201
    assert r.json()["name"] == "Trimmed"


def test_create_bucket_with_empty_name_defaults_to_untitled(client):
    """POST with name='' or name='   ' → 'Untitled'."""
    r = client.post("/files/buckets", json={"name": "   "})
    assert r.status_code == 201
    assert r.json()["name"] == "Untitled"


def test_get_bucket_by_id(client):
    """GET /buckets/{id} returns a specific bucket (via list filtering)."""
    create = client.post("/files/buckets", json={"name": "Test Bucket"})
    bucket_id = create.json()["id"]

    # Listing includes this bucket
    list_r = client.get("/files/buckets")
    bucket = next((b for b in list_r.json() if b["id"] == bucket_id), None)
    assert bucket is not None
    assert bucket["name"] == "Test Bucket"


def test_update_bucket_name(client):
    """PATCH /buckets/{id} with name update."""
    create = client.post("/files/buckets", json={"name": "Original"})
    bucket_id = create.json()["id"]

    r = client.patch(f"/files/buckets/{bucket_id}", json={"name": "Updated"})
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Updated"
    assert body["id"] == bucket_id


def test_update_bucket_color_icon_pinned(client):
    """PATCH /buckets/{id} with color, icon, is_pinned."""
    create = client.post("/files/buckets", json={"name": "B"})
    bucket_id = create.json()["id"]

    r = client.patch(f"/files/buckets/{bucket_id}", json={
        "color": "#00FF00",
        "icon": "star",
        "is_pinned": True,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["color"] == "#00FF00"
    assert body["icon"] == "star"
    assert body["is_pinned"] is True


def test_update_bucket_sort_order(client):
    """PATCH /buckets/{id} with sort_order."""
    create = client.post("/files/buckets", json={"name": "B"})
    bucket_id = create.json()["id"]

    r = client.patch(f"/files/buckets/{bucket_id}", json={"sort_order": 3.5})
    assert r.status_code == 200
    assert r.json()["sort_order"] == 3.5


def test_update_bucket_with_empty_name_returns_400(client):
    """PATCH with name='' or name='   ' → 400 bad request."""
    create = client.post("/files/buckets", json={"name": "Original"})
    bucket_id = create.json()["id"]

    r = client.patch(f"/files/buckets/{bucket_id}", json={"name": "   "})
    assert r.status_code == 400


def test_update_nonexistent_bucket_returns_404(client):
    """PATCH /buckets/{bad_id} → 404."""
    r = client.patch(f"/files/buckets/{uuid.uuid4().hex}", json={"name": "New"})
    assert r.status_code == 404


def test_update_bucket_bumps_updated_at(client):
    """PATCH a bucket; updated_at timestamp should change."""
    create = client.post("/files/buckets", json={"name": "Original"})
    original_updated = create.json()["updated_at"]
    bucket_id = create.json()["id"]

    import time
    time.sleep(0.01)  # Ensure time advances

    update = client.patch(f"/files/buckets/{bucket_id}", json={"name": "Modified"})
    new_updated = update.json()["updated_at"]
    assert new_updated > original_updated


def test_delete_bucket_returns_204(client):
    """DELETE /buckets/{id} → 204."""
    create = client.post("/files/buckets", json={"name": "Deletable"})
    bucket_id = create.json()["id"]

    r = client.delete(f"/files/buckets/{bucket_id}")
    assert r.status_code == 204


def test_delete_bucket_removes_from_list(client):
    """After DELETE, bucket no longer appears in GET /buckets."""
    create = client.post("/files/buckets", json={"name": "Deletable"})
    bucket_id = create.json()["id"]

    client.delete(f"/files/buckets/{bucket_id}")

    list_r = client.get("/files/buckets")
    deleted = next((b for b in list_r.json() if b["id"] == bucket_id), None)
    assert deleted is None


def test_delete_default_bucket_returns_400(client):
    """DELETE the Default bucket (is_default=True) → 400."""
    list_r = client.get("/files/buckets")
    default = next(b for b in list_r.json() if b.get("is_default"))

    r = client.delete(f"/files/buckets/{default['id']}")
    assert r.status_code == 400


def test_delete_nonexistent_bucket_returns_404(client):
    """DELETE /buckets/{bad_id} → 404."""
    r = client.delete(f"/files/buckets/{uuid.uuid4().hex}")
    assert r.status_code == 404


def test_delete_bucket_with_reassign_to_moves_items(client):
    """DELETE bucket with reassign_to query param; items move to target."""
    # Create two buckets
    b1 = client.post("/files/buckets", json={"name": "Source"}).json()
    b2 = client.post("/files/buckets", json={"name": "Target"}).json()

    # Create an item in b1
    item = client.post("/files/items", json={
        "bucket_id": b1["id"],
        "name": "test.txt",
        "storage_path": "/path/to/file.txt",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    # Delete b1 with reassign_to b2
    r = client.delete(f"/files/buckets/{b1['id']}", params={"reassign_to": b2["id"]})
    assert r.status_code == 204

    # Item should now be in b2
    items_r = client.get("/files/items", params={"bucket_id": b2["id"]})
    items = items_r.json()
    assert any(i["id"] == item["id"] for i in items)


def test_delete_bucket_with_invalid_reassign_target_returns_400(client):
    """DELETE with reassign_to pointing to non-existent bucket → 400."""
    b1 = client.post("/files/buckets", json={"name": "Source"}).json()

    r = client.delete(f"/files/buckets/{b1['id']}",
                     params={"reassign_to": uuid.uuid4().hex})
    assert r.status_code == 400


def test_bucket_list_includes_file_count(client):
    """Buckets returned by GET /buckets include file_count reflecting FileItems."""
    b1 = client.post("/files/buckets", json={"name": "HasItems"}).json()

    # Initially zero items
    assert b1["file_count"] == 0

    # Create two items in b1
    client.post("/files/items", json={
        "bucket_id": b1["id"],
        "name": "file1.txt",
        "storage_path": "/path/1",
        "source": "manual",
        "storage_kind": "managed",
    })
    client.post("/files/items", json={
        "bucket_id": b1["id"],
        "name": "file2.txt",
        "storage_path": "/path/2",
        "source": "manual",
        "storage_kind": "managed",
    })

    # List again; file_count should be 2
    list_r = client.get("/files/buckets")
    updated = next(b for b in list_r.json() if b["id"] == b1["id"])
    assert updated["file_count"] == 2


def test_bucket_list_excludes_soft_deleted_items_from_count(client):
    """file_count only includes items where deleted_at IS NULL."""
    b1 = client.post("/files/buckets", json={"name": "HasItems"}).json()

    # Create two items
    i1 = client.post("/files/items", json={
        "bucket_id": b1["id"],
        "name": "file1.txt",
        "storage_path": "/path/1",
        "source": "manual",
        "storage_kind": "managed",
    }).json()
    i2 = client.post("/files/items", json={
        "bucket_id": b1["id"],
        "name": "file2.txt",
        "storage_path": "/path/2",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    # Verify count is 2
    list_r = client.get("/files/buckets")
    assert next(b for b in list_r.json() if b["id"] == b1["id"])["file_count"] == 2

    # Soft-delete i1
    client.delete(f"/files/items/{i1['id']}")

    # Count should now be 1
    list_r = client.get("/files/buckets")
    assert next(b for b in list_r.json() if b["id"] == b1["id"])["file_count"] == 1


# ── File Items: Basic CRUD ───────────────────────────────────────────


def test_create_item_minimal(client):
    """POST /items with minimal required fields."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    r = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "document.pdf",
        "storage_path": "/path/to/document.pdf",
        "source": "manual",
        "storage_kind": "managed",
    })
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "document.pdf"
    assert body["bucket_id"] == b["id"]
    assert body["source"] == "manual"
    assert body["storage_kind"] == "managed"
    assert body["starred"] is False
    assert body["deleted_at"] is None
    assert "id" in body
    assert "created_at" in body
    assert "updated_at" in body


def test_create_item_with_all_fields(client):
    """POST /items with all optional fields populated."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    r = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "image.png",
        "ext": "png",
        "mime": "image/png",
        "size_bytes": 12345,
        "sha256": "abc123def456",
        "storage_path": "/path/to/image.png",
        "source": "upload",
        "storage_kind": "managed",
    })
    assert r.status_code == 201
    body = r.json()
    assert body["ext"] == "png"
    assert body["mime"] == "image/png"
    assert body["size_bytes"] == 12345
    assert body["sha256"] == "abc123def456"
    assert body["source"] == "upload"


def test_create_item_normalizes_ext_to_lowercase(client):
    """POST with ext='PNG' → stored as 'png'."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    r = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "pic.PNG",
        "ext": ".PNG",
        "storage_path": "/path",
        "source": "manual",
        "storage_kind": "managed",
    })
    assert r.status_code == 201
    assert r.json()["ext"] == "png"


def test_create_item_with_invalid_source_returns_400(client):
    """POST with source not in VALID_SOURCES → 400."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    r = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "file.txt",
        "storage_path": "/path",
        "source": "invalid_source",
        "storage_kind": "managed",
    })
    assert r.status_code == 400


def test_create_item_with_invalid_storage_kind_returns_400(client):
    """POST with storage_kind not in VALID_STORAGE_KINDS → 400."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    r = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "file.txt",
        "storage_path": "/path",
        "source": "manual",
        "storage_kind": "invalid_kind",
    })
    assert r.status_code == 400


def test_create_item_in_nonexistent_bucket_returns_400(client):
    """POST with bucket_id pointing to non-existent bucket → 400."""
    r = client.post("/files/items", json={
        "bucket_id": uuid.uuid4().hex,
        "name": "file.txt",
        "storage_path": "/path",
        "source": "manual",
        "storage_kind": "managed",
    })
    assert r.status_code == 400


def test_create_item_unfiled_bucket_id_null(client):
    """POST with bucket_id=null → item has no bucket (unfiled)."""
    r = client.post("/files/items", json={
        "bucket_id": None,
        "name": "unfiled.txt",
        "storage_path": "/path",
        "source": "manual",
        "storage_kind": "managed",
    })
    assert r.status_code == 201
    assert r.json()["bucket_id"] is None


def test_get_item_by_id(client):
    """GET /items/{id} returns the specific item."""
    b = client.post("/files/buckets", json={"name": "B"}).json()
    item = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "test.txt",
        "storage_path": "/path",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    r = client.get(f"/files/items/{item['id']}")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == item["id"]
    assert body["name"] == "test.txt"


def test_get_nonexistent_item_returns_404(client):
    """GET /items/{bad_id} → 404."""
    r = client.get(f"/files/items/{uuid.uuid4().hex}")
    assert r.status_code == 404


def test_update_item_name(client):
    """PATCH /items/{id} with name."""
    b = client.post("/files/buckets", json={"name": "B"}).json()
    item = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "original.txt",
        "storage_path": "/path",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    r = client.patch(f"/files/items/{item['id']}", json={"name": "renamed.txt"})
    assert r.status_code == 200
    assert r.json()["name"] == "renamed.txt"


def test_update_item_bucket_id(client):
    """PATCH /items/{id} to move to a different bucket."""
    b1 = client.post("/files/buckets", json={"name": "B1"}).json()
    b2 = client.post("/files/buckets", json={"name": "B2"}).json()
    item = client.post("/files/items", json={
        "bucket_id": b1["id"],
        "name": "test.txt",
        "storage_path": "/path",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    r = client.patch(f"/files/items/{item['id']}", json={"bucket_id": b2["id"]})
    assert r.status_code == 200
    assert r.json()["bucket_id"] == b2["id"]


def test_update_item_starred(client):
    """PATCH /items/{id} with starred=true."""
    b = client.post("/files/buckets", json={"name": "B"}).json()
    item = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "test.txt",
        "storage_path": "/path",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    r = client.patch(f"/files/items/{item['id']}", json={"starred": True})
    assert r.status_code == 200
    assert r.json()["starred"] is True


def test_update_item_with_empty_name_returns_400(client):
    """PATCH with name='' or name='   ' → 400."""
    b = client.post("/files/buckets", json={"name": "B"}).json()
    item = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "test.txt",
        "storage_path": "/path",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    r = client.patch(f"/files/items/{item['id']}", json={"name": "   "})
    assert r.status_code == 400


def test_update_item_to_invalid_bucket_returns_400(client):
    """PATCH with bucket_id pointing to non-existent bucket → 400."""
    b = client.post("/files/buckets", json={"name": "B"}).json()
    item = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "test.txt",
        "storage_path": "/path",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    r = client.patch(f"/files/items/{item['id']}",
                    json={"bucket_id": uuid.uuid4().hex})
    assert r.status_code == 400


def test_update_nonexistent_item_returns_404(client):
    """PATCH /items/{bad_id} → 404."""
    r = client.patch(f"/files/items/{uuid.uuid4().hex}", json={"name": "New"})
    assert r.status_code == 404


def test_update_item_bumps_updated_at(client):
    """PATCH an item; updated_at timestamp should change."""
    b = client.post("/files/buckets", json={"name": "B"}).json()
    item = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "test.txt",
        "storage_path": "/path",
        "source": "manual",
        "storage_kind": "managed",
    }).json()
    original_updated = item["updated_at"]

    import time
    time.sleep(0.01)

    update = client.patch(f"/files/items/{item['id']}", json={"name": "modified.txt"})
    assert update.json()["updated_at"] > original_updated


# ── File Items: Soft Delete & Restore ────────────────────────────────


def test_delete_item_soft_delete_by_default(client):
    """DELETE /items/{id} without hard=true sets deleted_at."""
    b = client.post("/files/buckets", json={"name": "B"}).json()
    item = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "test.txt",
        "storage_path": "/path",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    r = client.delete(f"/files/items/{item['id']}")
    assert r.status_code == 204

    # Item still exists but has deleted_at set
    get_r = client.get(f"/files/items/{item['id']}")
    assert get_r.status_code == 200
    assert get_r.json()["deleted_at"] is not None


def test_delete_item_hard_delete(client):
    """DELETE /items/{id}?hard=true removes row entirely."""
    b = client.post("/files/buckets", json={"name": "B"}).json()
    item = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "test.txt",
        "storage_path": "/path",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    r = client.delete(f"/files/items/{item['id']}", params={"hard": True})
    assert r.status_code == 204

    # Item no longer exists
    get_r = client.get(f"/files/items/{item['id']}")
    assert get_r.status_code == 404


def test_delete_nonexistent_item_returns_404(client):
    """DELETE /items/{bad_id} → 404."""
    r = client.delete(f"/files/items/{uuid.uuid4().hex}")
    assert r.status_code == 404


def test_soft_deleted_items_excluded_from_list_by_default(client):
    """GET /items by default excludes soft-deleted rows."""
    b = client.post("/files/buckets", json={"name": "B"}).json()
    item = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "test.txt",
        "storage_path": "/path",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    # Item appears in list
    list_r = client.get("/files/items", params={"bucket_id": b["id"]})
    assert any(i["id"] == item["id"] for i in list_r.json())

    # Soft-delete
    client.delete(f"/files/items/{item['id']}")

    # Item no longer in list
    list_r = client.get("/files/items", params={"bucket_id": b["id"]})
    assert not any(i["id"] == item["id"] for i in list_r.json())


def test_soft_deleted_items_included_with_include_deleted_flag(client):
    """GET /items?include_deleted=true includes soft-deleted rows."""
    b = client.post("/files/buckets", json={"name": "B"}).json()
    item = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "test.txt",
        "storage_path": "/path",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    client.delete(f"/files/items/{item['id']}")

    list_r = client.get("/files/items",
                       params={"bucket_id": b["id"], "include_deleted": True})
    assert any(i["id"] == item["id"] for i in list_r.json())


def test_only_deleted_flag_returns_only_deleted_items(client):
    """GET /items?only_deleted=true returns only soft-deleted rows."""
    b = client.post("/files/buckets", json={"name": "B"}).json()
    i1 = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "live.txt",
        "storage_path": "/path1",
        "source": "manual",
        "storage_kind": "managed",
    }).json()
    i2 = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "deleted.txt",
        "storage_path": "/path2",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    client.delete(f"/files/items/{i2['id']}")

    list_r = client.get("/files/items", params={"only_deleted": True})
    ids = [i["id"] for i in list_r.json()]
    assert i2["id"] in ids
    assert i1["id"] not in ids


def test_restore_item_clears_deleted_at(client):
    """PATCH /items/{id} with restore=true clears deleted_at."""
    b = client.post("/files/buckets", json={"name": "B"}).json()
    item = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "test.txt",
        "storage_path": "/path",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    # Soft-delete
    client.delete(f"/files/items/{item['id']}")
    deleted = client.get(f"/files/items/{item['id']}").json()
    assert deleted["deleted_at"] is not None

    # Restore
    r = client.patch(f"/files/items/{item['id']}", json={"restore": True})
    assert r.status_code == 200
    assert r.json()["deleted_at"] is None


# ── File Items: Listing & Filtering ──────────────────────────────────


def test_list_items_by_bucket_id(client):
    """GET /items?bucket_id={id} returns only items in that bucket."""
    b1 = client.post("/files/buckets", json={"name": "B1"}).json()
    b2 = client.post("/files/buckets", json={"name": "B2"}).json()

    i1 = client.post("/files/items", json={
        "bucket_id": b1["id"],
        "name": "item1.txt",
        "storage_path": "/path1",
        "source": "manual",
        "storage_kind": "managed",
    }).json()
    i2 = client.post("/files/items", json={
        "bucket_id": b2["id"],
        "name": "item2.txt",
        "storage_path": "/path2",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    # List from b1
    list_r = client.get("/files/items", params={"bucket_id": b1["id"]})
    ids = [i["id"] for i in list_r.json()]
    assert i1["id"] in ids
    assert i2["id"] not in ids


def test_list_items_unfiled(client):
    """GET /items?unfiled=true returns only items with bucket_id=null."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    filed = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "filed.txt",
        "storage_path": "/path1",
        "source": "manual",
        "storage_kind": "managed",
    }).json()
    unfiled = client.post("/files/items", json={
        "bucket_id": None,
        "name": "unfiled.txt",
        "storage_path": "/path2",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    list_r = client.get("/files/items", params={"unfiled": True})
    ids = [i["id"] for i in list_r.json()]
    assert unfiled["id"] in ids
    assert filed["id"] not in ids


def test_list_items_filter_by_source(client):
    """GET /items?source={source} returns only items with that source."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    i1 = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "uploaded.txt",
        "storage_path": "/path1",
        "source": "upload",
        "storage_kind": "managed",
    }).json()
    i2 = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "manual.txt",
        "storage_path": "/path2",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    list_r = client.get("/files/items", params={"source": "upload"})
    ids = [i["id"] for i in list_r.json()]
    assert i1["id"] in ids
    assert i2["id"] not in ids


def test_list_items_filter_by_storage_kind(client):
    """GET /items?storage_kind={kind} returns only items with that kind."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    i1 = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "managed.txt",
        "storage_path": "/path1",
        "source": "manual",
        "storage_kind": "managed",
    }).json()
    i2 = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "workspace.txt",
        "storage_path": "/path2",
        "source": "manual",
        "storage_kind": "workspace",
    }).json()

    list_r = client.get("/files/items", params={"storage_kind": "managed"})
    ids = [i["id"] for i in list_r.json()]
    assert i1["id"] in ids
    assert i2["id"] not in ids


def test_list_items_filter_by_starred(client):
    """GET /items?starred=true returns only starred items."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    i1 = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "starred.txt",
        "storage_path": "/path1",
        "source": "manual",
        "storage_kind": "managed",
    }).json()
    i2 = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "unstarred.txt",
        "storage_path": "/path2",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    # Star i1
    client.patch(f"/files/items/{i1['id']}", json={"starred": True})

    list_r = client.get("/files/items", params={"starred": True})
    ids = [i["id"] for i in list_r.json()]
    assert i1["id"] in ids
    assert i2["id"] not in ids


def test_list_items_filter_by_name_search(client):
    """GET /items?q={query} does case-insensitive substring search on name."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "document.pdf",
        "storage_path": "/path1",
        "source": "manual",
        "storage_kind": "managed",
    })
    i2 = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "report.pdf",
        "storage_path": "/path2",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    list_r = client.get("/files/items", params={"q": "report"})
    ids = [i["id"] for i in list_r.json()]
    assert i2["id"] in ids
    assert len(ids) == 1


def test_list_items_order_by_created_default(client):
    """GET /items with no order param defaults to order=created (descending)."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    i1 = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "first.txt",
        "storage_path": "/path1",
        "source": "manual",
        "storage_kind": "managed",
    }).json()
    i2 = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "second.txt",
        "storage_path": "/path2",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    list_r = client.get("/files/items", params={"bucket_id": b["id"]})
    ids = [i["id"] for i in list_r.json()]
    # Newer item (i2) should come before older item (i1)
    assert ids.index(i2["id"]) < ids.index(i1["id"])


def test_list_items_order_by_name(client):
    """GET /items?order=name sorts by name ascending."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "zebra.txt",
        "storage_path": "/path1",
        "source": "manual",
        "storage_kind": "managed",
    })
    client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "apple.txt",
        "storage_path": "/path2",
        "source": "manual",
        "storage_kind": "managed",
    })

    list_r = client.get("/files/items",
                       params={"bucket_id": b["id"], "order": "name"})
    names = [i["name"] for i in list_r.json()]
    assert names == ["apple.txt", "zebra.txt"]


def test_list_items_order_by_updated(client):
    """GET /items?order=updated sorts by updated_at descending."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    i1 = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "item1.txt",
        "storage_path": "/path1",
        "source": "manual",
        "storage_kind": "managed",
    }).json()
    i2 = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "item2.txt",
        "storage_path": "/path2",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    # Update i1 to make it newer
    import time
    time.sleep(0.01)
    client.patch(f"/files/items/{i1['id']}", json={"name": "item1_updated.txt"})

    list_r = client.get("/files/items",
                       params={"bucket_id": b["id"], "order": "updated"})
    ids = [i["id"] for i in list_r.json()]
    # i1 (recently updated) should come before i2
    assert ids.index(i1["id"]) < ids.index(i2["id"])


def test_list_items_order_by_opened(client):
    """GET /items?order=opened sorts by last_opened_at descending."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    i1 = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "item1.txt",
        "storage_path": "/path1",
        "source": "manual",
        "storage_kind": "managed",
    }).json()
    i2 = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "item2.txt",
        "storage_path": "/path2",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    # Touch i1 (set last_opened_at)
    import time
    time.sleep(0.01)
    client.post(f"/files/items/{i1['id']}/touch")

    list_r = client.get("/files/items",
                       params={"bucket_id": b["id"], "order": "opened"})
    ids = [i["id"] for i in list_r.json()]
    # i1 (opened) should come before i2 (never opened)
    assert ids.index(i1["id"]) < ids.index(i2["id"])


def test_list_items_invalid_order_returns_400(client):
    """GET /items?order=invalid → 400."""
    r = client.get("/files/items", params={"order": "invalid_order"})
    assert r.status_code == 400


def test_list_items_respects_limit_offset(client):
    """GET /items?limit=1&offset=1 respects pagination."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    items = []
    for i in range(3):
        item = client.post("/files/items", json={
            "bucket_id": b["id"],
            "name": f"item{i}.txt",
            "storage_path": f"/path{i}",
            "source": "manual",
            "storage_kind": "managed",
        }).json()
        items.append(item)

    # Get all
    list_r = client.get("/files/items",
                       params={"bucket_id": b["id"], "limit": 200})
    assert len(list_r.json()) == 3

    # Get with limit=1, offset=1
    list_r = client.get("/files/items",
                       params={"bucket_id": b["id"], "limit": 1, "offset": 1})
    assert len(list_r.json()) == 1


def test_recent_items_endpoint(client):
    """GET /items/recent returns recently opened or created items."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    i1 = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "old.txt",
        "storage_path": "/path1",
        "source": "manual",
        "storage_kind": "managed",
    }).json()
    i2 = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "new.txt",
        "storage_path": "/path2",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    # i2 is newer, should appear in recent
    r = client.get("/files/items/recent")
    assert r.status_code == 200
    ids = [i["id"] for i in r.json()]
    assert i2["id"] in ids


# ── File Items: Copy ─────────────────────────────────────────────────


def test_copy_item_to_same_bucket(client):
    """POST /items/{id}/copy with new_storage_path and same bucket."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    src = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "original.txt",
        "ext": "txt",
        "mime": "text/plain",
        "size_bytes": 1024,
        "sha256": "abc123",
        "storage_path": "/path/original.txt",
        "source": "upload",
        "storage_kind": "managed",
    }).json()

    r = client.post(f"/files/items/{src['id']}/copy", json={
        "bucket_id": b["id"],
        "new_storage_path": "/path/copy.txt",
    })
    assert r.status_code == 201
    copy = r.json()

    # Copy inherits metadata from source
    assert copy["name"] == src["name"]
    assert copy["ext"] == src["ext"]
    assert copy["mime"] == src["mime"]
    assert copy["size_bytes"] == src["size_bytes"]
    assert copy["sha256"] == src["sha256"]
    assert copy["source"] == src["source"]
    # But has new storage path
    assert copy["storage_path"] == "/path/copy.txt"
    # And storage_kind always forced to 'managed'
    assert copy["storage_kind"] == "managed"
    # New row id
    assert copy["id"] != src["id"]


def test_copy_item_to_different_bucket(client):
    """POST /items/{id}/copy to move to a different bucket."""
    b1 = client.post("/files/buckets", json={"name": "B1"}).json()
    b2 = client.post("/files/buckets", json={"name": "B2"}).json()

    src = client.post("/files/items", json={
        "bucket_id": b1["id"],
        "name": "original.txt",
        "storage_path": "/path/original.txt",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    r = client.post(f"/files/items/{src['id']}/copy", json={
        "bucket_id": b2["id"],
        "new_storage_path": "/path/copy.txt",
    })
    assert r.status_code == 201
    copy = r.json()
    assert copy["bucket_id"] == b2["id"]


def test_copy_item_to_unfiled(client):
    """POST /items/{id}/copy with bucket_id=null."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    src = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "original.txt",
        "storage_path": "/path/original.txt",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    r = client.post(f"/files/items/{src['id']}/copy", json={
        "bucket_id": None,
        "new_storage_path": "/path/copy.txt",
    })
    assert r.status_code == 201
    copy = r.json()
    assert copy["bucket_id"] is None


def test_copy_item_source_not_found_returns_404(client):
    """POST /items/{bad_id}/copy → 404."""
    r = client.post(f"/files/items/{uuid.uuid4().hex}/copy", json={
        "bucket_id": None,
        "new_storage_path": "/path/copy.txt",
    })
    assert r.status_code == 404


def test_copy_item_to_invalid_bucket_returns_400(client):
    """POST /items/{id}/copy with invalid bucket_id → 400."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    src = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "original.txt",
        "storage_path": "/path/original.txt",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    r = client.post(f"/files/items/{src['id']}/copy", json={
        "bucket_id": uuid.uuid4().hex,
        "new_storage_path": "/path/copy.txt",
    })
    assert r.status_code == 400


# ── File Items: Touch ────────────────────────────────────────────────


def test_touch_item_sets_last_opened_at(client):
    """POST /items/{id}/touch sets last_opened_at to now."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    item = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "test.txt",
        "storage_path": "/path",
        "source": "manual",
        "storage_kind": "managed",
    }).json()
    assert item["last_opened_at"] is None

    r = client.post(f"/files/items/{item['id']}/touch")
    assert r.status_code == 200
    touched = r.json()
    assert touched["last_opened_at"] is not None


def test_touch_nonexistent_item_returns_404(client):
    """POST /items/{bad_id}/touch → 404."""
    r = client.post(f"/files/items/{uuid.uuid4().hex}/touch")
    assert r.status_code == 404


# ── Trash Management ────────────────────────────────────────────────


def test_empty_trash_hard_deletes_soft_deleted_items(client):
    """POST /trash/empty removes all soft-deleted rows."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    i1 = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "will_delete.txt",
        "storage_path": "/path/will_delete.txt",
        "source": "manual",
        "storage_kind": "managed",
    }).json()

    # Soft-delete
    client.delete(f"/files/items/{i1['id']}")

    # Empty trash
    r = client.post("/files/trash/empty")
    assert r.status_code == 200
    paths = r.json()
    assert "/path/will_delete.txt" in paths

    # Item is now gone (hard deleted)
    get_r = client.get(f"/files/items/{i1['id']}")
    assert get_r.status_code == 404


def test_empty_trash_returns_storage_paths(client):
    """POST /trash/empty returns storage_path for managed files."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "file1.txt",
        "storage_path": "/managed/path/file1.txt",
        "source": "manual",
        "storage_kind": "managed",
    })
    client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "file2.txt",
        "storage_path": "/workspace/path/file2.txt",
        "source": "manual",
        "storage_kind": "workspace",
    })

    # Soft-delete both
    items = client.get("/files/items", params={"bucket_id": b["id"]}).json()
    for item in items:
        client.delete(f"/files/items/{item['id']}")

    r = client.post("/files/trash/empty")
    assert r.status_code == 200
    paths = r.json()
    # Only managed file paths returned
    assert "/managed/path/file1.txt" in paths
    assert "/workspace/path/file2.txt" not in paths


# ── Managed Paths Listing ────────────────────────────────────────────


def test_list_managed_paths(client):
    """GET /managed-paths returns storage_path of all managed files."""
    b = client.post("/files/buckets", json={"name": "B"}).json()

    client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "managed.txt",
        "storage_path": "/managed/path/managed.txt",
        "source": "manual",
        "storage_kind": "managed",
    })
    client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "workspace.txt",
        "storage_path": "/workspace/path/workspace.txt",
        "source": "manual",
        "storage_kind": "workspace",
    })

    r = client.get("/files/managed-paths")
    assert r.status_code == 200
    paths = r.json()
    assert "/managed/path/managed.txt" in paths
    assert "/workspace/path/workspace.txt" not in paths


# ── GET /buckets/{id}/contents ────────────────────────────────────────


def test_bucket_contents_returns_empty_for_empty_bucket(client):
    """GET /buckets/{id}/contents → [] when bucket has no files."""
    from main import app

    app.state.files_dir = "/tmp/test-files-root"
    b = client.post("/files/buckets", json={"name": "Empty"}).json()

    r = client.get(f"/files/buckets/{b['id']}/contents")
    assert r.status_code == 200
    assert r.json() == []


def test_bucket_contents_returns_404_for_unknown_bucket(client):
    """GET /buckets/{bad_id}/contents → 404."""
    r = client.get(f"/files/buckets/{uuid.uuid4().hex}/contents")
    assert r.status_code == 404


def test_bucket_contents_resolves_managed_paths_against_files_dir(client, tmp_path):
    """Managed files are joined with files_dir into absolute paths."""
    from main import app

    files_root = str(tmp_path / "files")
    import os
    os.makedirs(files_root, exist_ok=True)
    app.state.files_dir = files_root

    b = client.post("/files/buckets", json={"name": "Docs"}).json()
    client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "notes.md",
        "storage_path": "managed/notes.md",
        "source": "manual",
        "storage_kind": "managed",
        "ext": "md",
        "mime": "text/markdown",
        "size_bytes": 120,
    })

    r = client.get(f"/files/buckets/{b['id']}/contents")
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    entry = body[0]
    assert entry["name"] == "notes.md"
    assert entry["ext"] == "md"
    assert entry["mime"] == "text/markdown"
    assert entry["size_bytes"] == 120
    # Must be absolute and rooted inside files_dir.
    assert entry["abs_path"].startswith(files_root)
    assert entry["abs_path"].endswith("notes.md")


def test_bucket_contents_passes_workspace_absolute_paths_through(client, tmp_path):
    """Workspace files keep their original absolute storage_path."""
    from main import app

    app.state.files_dir = str(tmp_path / "files")
    b = client.post("/files/buckets", json={"name": "External"}).json()
    abs_path = str(tmp_path / "external" / "report.pdf")
    client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "report.pdf",
        "storage_path": abs_path,
        "source": "workspace-save",
        "storage_kind": "workspace",
    })

    r = client.get(f"/files/buckets/{b['id']}/contents")
    assert r.status_code == 200
    body = r.json()
    assert len(body) == 1
    assert body[0]["abs_path"] == abs_path


def test_bucket_contents_skips_managed_paths_that_escape_files_root(client, tmp_path):
    """Traversal attempts in storage_path are dropped, not leaked."""
    from main import app

    files_root = str(tmp_path / "files")
    import os
    os.makedirs(files_root, exist_ok=True)
    app.state.files_dir = files_root

    b = client.post("/files/buckets", json={"name": "Docs"}).json()
    client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "sneaky.md",
        "storage_path": "../../etc/passwd",
        "source": "manual",
        "storage_kind": "managed",
    })
    # A legitimate neighbor to confirm filtering is selective.
    client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "legit.md",
        "storage_path": "legit.md",
        "source": "manual",
        "storage_kind": "managed",
    })

    r = client.get(f"/files/buckets/{b['id']}/contents")
    assert r.status_code == 200
    names = [e["name"] for e in r.json()]
    assert "sneaky.md" not in names
    assert "legit.md" in names


def test_bucket_contents_excludes_soft_deleted_items(client, tmp_path):
    """Soft-deleted items do not appear in /contents."""
    from main import app

    app.state.files_dir = str(tmp_path / "files")
    import os
    os.makedirs(app.state.files_dir, exist_ok=True)

    b = client.post("/files/buckets", json={"name": "Docs"}).json()
    kept = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "kept.md",
        "storage_path": "kept.md",
        "source": "manual",
        "storage_kind": "managed",
    }).json()
    trashed = client.post("/files/items", json={
        "bucket_id": b["id"],
        "name": "trashed.md",
        "storage_path": "trashed.md",
        "source": "manual",
        "storage_kind": "managed",
    }).json()
    client.delete(f"/files/items/{trashed['id']}")

    r = client.get(f"/files/buckets/{b['id']}/contents")
    assert r.status_code == 200
    ids = [e["id"] for e in r.json()]
    assert kept["id"] in ids
    assert trashed["id"] not in ids


def test_bucket_contents_honors_limit_param(client, tmp_path):
    """?limit=N caps the number of returned rows."""
    from main import app

    app.state.files_dir = str(tmp_path / "files")
    import os
    os.makedirs(app.state.files_dir, exist_ok=True)

    b = client.post("/files/buckets", json={"name": "Many"}).json()
    for i in range(5):
        client.post("/files/items", json={
            "bucket_id": b["id"],
            "name": f"f{i}.md",
            "storage_path": f"f{i}.md",
            "source": "manual",
            "storage_kind": "managed",
        })

    r = client.get(f"/files/buckets/{b['id']}/contents", params={"limit": 2})
    assert r.status_code == 200
    assert len(r.json()) == 2
