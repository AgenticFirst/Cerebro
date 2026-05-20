"""Inspect / stage / rollback a `.cerebro-backup` archive.

The runtime flow:

  1. `inspect_backup(path)` reads `manifest.json` from the zip without
     unpacking anything else. Returns stats + compatibility status so the
     renderer can show a preview dialog.
  2. `apply_backup(path, user_data_dir)` takes a rollback snapshot of the
     current state, extracts the zip to `<userData>/.backup-staging/`, and
     writes `.backup-pending.json` pointing the next boot at the staging
     dir. The Electron main process performs the actual file swaps before
     starting Python so the live DB connection never races with us.
  3. `undo_restore(rollback_id, user_data_dir)` reverses the swap by
     re-applying the rollback snapshot stored under `.backup-rollback/`.

We never touch the live DB file directly — Python is holding it open.
"""

from __future__ import annotations

import json
import shutil
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .archive import (
    FILES_EXCLUDED_SUBDIRS,
    FORMAT_VERSION,
    safe_remove_tree,
)

PENDING_MARKER_FILENAME = ".backup-pending.json"
STAGING_DIR_NAME = ".backup-staging"
ROLLBACK_ROOT_NAME = ".backup-rollback"
# Keep at most this many rollback snapshots so disk usage doesn't grow forever.
ROLLBACK_RETENTION = 2

# Directories under userData that a backup is allowed to replace. Anything else
# (models, voice-models, .claude, etc.) is preserved across a restore.
RESTORABLE_DIRS = ("files", "agent-memory", "task-workspaces")


@dataclass
class InspectResult:
    ok: bool
    manifest: dict[str, Any] = field(default_factory=dict)
    compatible: bool = True
    warnings: list[str] = field(default_factory=list)
    error: str | None = None


@dataclass
class ApplyResult:
    ok: bool
    rollback_id: str
    staging_dir: str
    error: str | None = None


def _read_manifest(zip_path: Path) -> dict[str, Any]:
    with zipfile.ZipFile(zip_path, "r") as zf:
        with zf.open("manifest.json") as fh:
            return json.loads(fh.read().decode("utf-8"))


def _version_tuple(v: str) -> tuple[int, ...]:
    out: list[int] = []
    for part in v.split("."):
        try:
            out.append(int(part))
        except ValueError:
            # Trailing tags like "-beta" — stop here so we still compare a
            # well-defined prefix.
            break
    return tuple(out)


def inspect_backup(zip_path: Path, current_version: str) -> InspectResult:
    """Read the manifest and decide whether we can safely restore from it.

    Refuses backups produced by a NEWER app version (schema may have moved
    forward; we can't downgrade gracefully). Older backups are always allowed
    — the DB's column-existence migrations bring them forward on next boot.
    """
    if not zip_path.exists():
        return InspectResult(ok=False, error=f"Backup file not found: {zip_path}")
    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            names = set(zf.namelist())
            if "manifest.json" not in names:
                return InspectResult(ok=False, error="Not a Cerebro backup (manifest.json missing)")
            if "cerebro.db" not in names:
                return InspectResult(ok=False, error="Backup is missing the database snapshot")
        manifest = _read_manifest(zip_path)
    except zipfile.BadZipFile:
        return InspectResult(ok=False, error="Backup file is not a valid archive")
    except (KeyError, json.JSONDecodeError) as exc:
        return InspectResult(ok=False, error=f"Backup manifest is unreadable: {exc}")

    warnings: list[str] = []
    compatible = True

    fv = int(manifest.get("format_version", 0))
    if fv != FORMAT_VERSION:
        compatible = False
        warnings.append(
            f"Backup format version {fv} is not supported by this Cerebro build "
            f"(expected {FORMAT_VERSION})."
        )

    backup_app_version = str(manifest.get("cerebro_version", ""))
    if backup_app_version and current_version:
        if _version_tuple(backup_app_version) > _version_tuple(current_version):
            compatible = False
            warnings.append(
                f"This backup was made with Cerebro {backup_app_version}. "
                f"Please update Cerebro to that version or newer before restoring."
            )

    return InspectResult(ok=True, manifest=manifest, compatible=compatible, warnings=warnings)


def _snapshot_current(user_data_dir: Path, db_path: Path) -> str:
    """Copy current DB + restorable dirs into `.backup-rollback/<timestamp>/`.

    Returns the rollback id (the timestamp directory name).
    """
    rollback_root = user_data_dir / ROLLBACK_ROOT_NAME
    rollback_root.mkdir(parents=True, exist_ok=True)

    rollback_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    target = rollback_root / rollback_id
    target.mkdir(parents=True, exist_ok=True)

    # Snapshot the DB via the same online-backup API used for export, so we
    # never copy a half-written page.
    if db_path.exists():
        from .archive import _snapshot_db  # local import to avoid cycle on partial reload
        _snapshot_db(db_path, target / "cerebro.db")

    for name in RESTORABLE_DIRS:
        src = user_data_dir / name
        if not src.exists():
            continue
        if name == "files":
            # Skip the regenerable parse cache.
            shutil.copytree(
                src,
                target / name,
                ignore=shutil.ignore_patterns(*FILES_EXCLUDED_SUBDIRS),
                dirs_exist_ok=False,
            )
        else:
            shutil.copytree(src, target / name, dirs_exist_ok=False)

    # Retention: keep only the newest N rollbacks.
    snapshots = sorted(
        (p for p in rollback_root.iterdir() if p.is_dir()),
        key=lambda p: p.name,
        reverse=True,
    )
    for old in snapshots[ROLLBACK_RETENTION:]:
        safe_remove_tree(old)

    return rollback_id


def _stage_backup(zip_path: Path, user_data_dir: Path) -> Path:
    """Extract the backup into `.backup-staging/` (replacing anything there)."""
    staging = user_data_dir / STAGING_DIR_NAME
    safe_remove_tree(staging)
    staging.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        # Guard against path traversal in malicious archives.
        for name in zf.namelist():
            normalized = Path(name)
            if normalized.is_absolute() or ".." in normalized.parts:
                raise ValueError(f"Refusing unsafe entry in backup: {name}")
        zf.extractall(staging)
    return staging


def _write_pending_marker(
    user_data_dir: Path,
    staging_dir: Path,
    rollback_id: str,
    manifest: dict[str, Any],
) -> None:
    """Drop the marker JSON that the Electron main process reads on next boot.

    The schema is intentionally tiny — main.ts deserializes only what it needs
    to do the swap.
    """
    marker_path = user_data_dir / PENDING_MARKER_FILENAME
    marker_path.write_text(
        json.dumps(
            {
                "staging_dir": str(staging_dir),
                "rollback_id": rollback_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "contents": manifest.get("contents", []),
                "cerebro_version": manifest.get("cerebro_version"),
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def apply_backup(zip_path: Path, user_data_dir: Path, db_path: Path) -> ApplyResult:
    """Snapshot current state, extract the backup, write the pending marker."""
    inspect = inspect_backup(zip_path, current_version="")  # version handled by caller
    if not inspect.ok:
        return ApplyResult(ok=False, rollback_id="", staging_dir="", error=inspect.error)

    try:
        rollback_id = _snapshot_current(user_data_dir, db_path)
    except Exception as exc:  # pragma: no cover — disk full, permission, etc.
        return ApplyResult(
            ok=False,
            rollback_id="",
            staging_dir="",
            error=f"Could not snapshot current state: {exc}",
        )

    try:
        staging = _stage_backup(zip_path, user_data_dir)
    except Exception as exc:
        return ApplyResult(
            ok=False,
            rollback_id=rollback_id,
            staging_dir="",
            error=f"Could not extract backup: {exc}",
        )

    _write_pending_marker(user_data_dir, staging, rollback_id, inspect.manifest)
    return ApplyResult(ok=True, rollback_id=rollback_id, staging_dir=str(staging))


def stage_undo(user_data_dir: Path, rollback_id: str) -> ApplyResult:
    """Set up a pending swap that restores the named rollback snapshot.

    Reuses the staging machinery: copies the rollback contents into
    `.backup-staging/` and writes `.backup-pending.json`. On next boot the
    Electron swap logic does its usual thing and the user is back where they
    started.
    """
    rollback_dir = user_data_dir / ROLLBACK_ROOT_NAME / rollback_id
    if not rollback_dir.exists() or not rollback_dir.is_dir():
        return ApplyResult(
            ok=False,
            rollback_id=rollback_id,
            staging_dir="",
            error=f"Rollback snapshot not found: {rollback_id}",
        )

    staging = user_data_dir / STAGING_DIR_NAME
    safe_remove_tree(staging)
    shutil.copytree(rollback_dir, staging)

    marker_path = user_data_dir / PENDING_MARKER_FILENAME
    marker_path.write_text(
        json.dumps(
            {
                "staging_dir": str(staging),
                "rollback_id": rollback_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "contents": ["db"] + [name for name in RESTORABLE_DIRS if (rollback_dir / name).exists()],
                "is_undo": True,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return ApplyResult(ok=True, rollback_id=rollback_id, staging_dir=str(staging))


def cancel_pending(user_data_dir: Path) -> bool:
    """Tear down the staging dir and remove the pending marker.

    Called when the user dismisses a pending restore before the relaunch
    fires. Returns True if something was actually cancelled.
    """
    marker = user_data_dir / PENDING_MARKER_FILENAME
    staging = user_data_dir / STAGING_DIR_NAME
    had_marker = marker.exists()
    try:
        marker.unlink()
    except FileNotFoundError:
        pass
    safe_remove_tree(staging)
    return had_marker


def list_rollbacks(user_data_dir: Path) -> list[dict[str, str]]:
    """Enumerate available rollback snapshots, newest first."""
    rollback_root = user_data_dir / ROLLBACK_ROOT_NAME
    if not rollback_root.exists():
        return []
    out: list[dict[str, str]] = []
    for entry in sorted(rollback_root.iterdir(), reverse=True):
        if entry.is_dir():
            out.append({"id": entry.name, "path": str(entry)})
    return out
