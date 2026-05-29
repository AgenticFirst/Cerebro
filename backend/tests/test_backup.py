"""End-to-end tests for the /backup endpoints.

We round-trip an export → inspect → apply cycle against a tmp userData
layout and confirm:

  * The export zip is well-formed and contains the expected entries.
  * `inspect` reads the manifest without unpacking.
  * `apply` snapshots the current state and writes the pending marker.
  * Version mismatches (newer backup than current app) are refused.

The fixture's `client` already wires `app.state.db_path` and
`app.state.agent_memory_dir` to tmp paths. We add `files_dir` / a couple
of stub files so the archive walker has something to traverse.
"""

from __future__ import annotations

import json
import os
import zipfile
from pathlib import Path


def _seed_user_data(client) -> Path:
    """Drop a few stub files into the tmp userData so the archive isn't empty."""
    db_path = Path(client.app.state.db_path)
    user_data_dir = db_path.parent

    # files/task-attachments/<id>/x.txt
    attachments = user_data_dir / "files" / "task-attachments" / "abc"
    attachments.mkdir(parents=True, exist_ok=True)
    (attachments / "hello.txt").write_text("hello", encoding="utf-8")

    # files/_parsed/ should be excluded from the archive
    parsed = user_data_dir / "files" / "_parsed"
    parsed.mkdir(parents=True, exist_ok=True)
    (parsed / "ignore.bin").write_bytes(b"x" * 32)

    # agent-memory/<slug>/notes.md
    mem = user_data_dir / "agent-memory" / "default"
    mem.mkdir(parents=True, exist_ok=True)
    (mem / "notes.md").write_text("note", encoding="utf-8")

    # task-workspaces/<id>/main.py
    workspace = user_data_dir / "task-workspaces" / "task-1"
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "main.py").write_text("print('hi')", encoding="utf-8")

    # Make app.state.files_dir explicit for the router. The conftest seeds
    # db_path + agent_memory_dir but not files_dir.
    client.app.state.files_dir = str(user_data_dir / "files")
    client.app.state.parsed_files_dir = str(user_data_dir / "files" / "_parsed")
    return user_data_dir


def test_estimate_returns_nonzero_after_seed(client):
    _seed_user_data(client)
    res = client.post("/backup/estimate", json={"include_models": False})
    assert res.status_code == 200
    assert res.json()["bytes"] > 0


def test_export_then_inspect_then_last_backup(client, tmp_path):
    _seed_user_data(client)
    dest = tmp_path / "out" / "round-trip.cerebro-backup"
    dest.parent.mkdir(parents=True, exist_ok=True)

    res = client.post(
        "/backup/export",
        json={"dest_path": str(dest), "include_models": False, "app_version": "9.9.9"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ok"] is True
    assert body["path"] == str(dest)
    assert body["size_bytes"] > 0
    assert body["stats"]["file_count"] >= 3  # the three stub files

    # The zip must contain manifest.json, cerebro.db, and the seeded files
    # — but NOT the _parsed cache.
    with zipfile.ZipFile(dest, "r") as zf:
        names = set(zf.namelist())
    assert "manifest.json" in names
    assert "cerebro.db" in names
    assert any(n.startswith("files/task-attachments/") for n in names)
    assert any(n.startswith("agent-memory/") for n in names)
    assert any(n.startswith("task-workspaces/") for n in names)
    assert not any("_parsed" in n for n in names)

    # Manifest fields
    with zipfile.ZipFile(dest, "r") as zf:
        manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
    assert manifest["format_version"] == 1
    assert manifest["cerebro_version"] == "9.9.9"
    assert manifest["db_sha256"]
    assert set(["files", "agent-memory", "task-workspaces", "db"]).issubset(set(manifest["contents"]))

    # /backup/last should now report this export
    res = client.get("/backup/last")
    assert res.status_code == 200
    last = res.json()
    assert last["last_backup_path"] == str(dest)
    assert last["last_backup_size_bytes"] == os.path.getsize(dest)
    assert last["last_backup_at"] is not None

    # /backup/inspect reads the manifest without unpacking
    res = client.post(
        "/backup/inspect", json={"path": str(dest), "app_version": "9.9.9"}
    )
    assert res.status_code == 200
    inspect = res.json()
    assert inspect["ok"] is True
    assert inspect["compatible"] is True
    assert inspect["manifest"]["cerebro_version"] == "9.9.9"


def test_inspect_refuses_newer_backup_than_current_app(client, tmp_path):
    _seed_user_data(client)
    dest = tmp_path / "newer.cerebro-backup"
    client.post(
        "/backup/export",
        json={"dest_path": str(dest), "include_models": False, "app_version": "2.0.0"},
    )

    res = client.post(
        "/backup/inspect", json={"path": str(dest), "app_version": "1.0.0"}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["compatible"] is False
    assert body["warnings"]
    assert "2.0.0" in body["warnings"][0]


def test_inspect_rejects_non_zip(client, tmp_path):
    bad = tmp_path / "bad.cerebro-backup"
    bad.write_text("not a zip", encoding="utf-8")
    res = client.post("/backup/inspect", json={"path": str(bad), "app_version": "1.0.0"})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert "archive" in (body["error"] or "").lower()


def test_apply_stages_backup_and_writes_marker(client, tmp_path):
    _seed_user_data(client)
    dest = tmp_path / "apply.cerebro-backup"
    res = client.post(
        "/backup/export",
        json={"dest_path": str(dest), "include_models": False, "app_version": "1.0.0"},
    )
    assert res.status_code == 200

    res = client.post("/backup/apply", json={"path": str(dest)})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ok"] is True
    assert body["rollback_id"]

    user_data_dir = Path(client.app.state.db_path).parent
    marker = user_data_dir / ".backup-pending.json"
    staging = user_data_dir / ".backup-staging"
    rollback = user_data_dir / ".backup-rollback" / body["rollback_id"]

    assert marker.exists()
    assert staging.exists() and staging.is_dir()
    assert (staging / "cerebro.db").exists()
    assert rollback.exists()
    # The rollback must include a DB snapshot.
    assert (rollback / "cerebro.db").exists()


def test_apply_then_cancel_clears_marker(client, tmp_path):
    _seed_user_data(client)
    dest = tmp_path / "cancel.cerebro-backup"
    client.post(
        "/backup/export",
        json={"dest_path": str(dest), "include_models": False, "app_version": "1.0.0"},
    )
    client.post("/backup/apply", json={"path": str(dest)})

    res = client.post("/backup/cancel-pending")
    assert res.status_code == 200
    assert res.json()["cancelled"] is True

    user_data_dir = Path(client.app.state.db_path).parent
    assert not (user_data_dir / ".backup-pending.json").exists()
    assert not (user_data_dir / ".backup-staging").exists()


def test_undo_stages_named_rollback(client, tmp_path):
    _seed_user_data(client)
    dest = tmp_path / "undo.cerebro-backup"
    client.post(
        "/backup/export",
        json={"dest_path": str(dest), "include_models": False, "app_version": "1.0.0"},
    )
    apply_res = client.post("/backup/apply", json={"path": str(dest)})
    rollback_id = apply_res.json()["rollback_id"]

    # Clear the pending marker so undo has a clean slate.
    client.post("/backup/cancel-pending")

    res = client.post("/backup/undo", json={"rollback_id": rollback_id})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True

    user_data_dir = Path(client.app.state.db_path).parent
    marker_path = user_data_dir / ".backup-pending.json"
    assert marker_path.exists()
    marker = json.loads(marker_path.read_text("utf-8"))
    assert marker["rollback_id"] == rollback_id
    assert marker.get("is_undo") is True


def test_export_rejects_directory_destination(client, tmp_path):
    _seed_user_data(client)
    res = client.post(
        "/backup/export",
        json={"dest_path": str(tmp_path), "include_models": False, "app_version": "1.0.0"},
    )
    assert res.status_code == 400
