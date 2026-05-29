"""Build a `.cerebro-backup` zip from the live user-data directory.

A backup is a single zip archive with this layout::

    cerebro-backup-YYYY-MM-DD-HHMMSS.cerebro-backup
    ├── manifest.json
    ├── cerebro.db                       # SQLite snapshot
    ├── files/                           # everything under <userData>/files except _parsed/
    ├── agent-memory/                    # per-agent markdown
    └── task-workspaces/                 # workspace projects

The SQLite snapshot is produced via ``sqlite3.Connection.backup()`` so it
stays consistent even with concurrent writes from the running backend.
Sizes are streamed through ``zipfile.ZipFile.write()`` so memory stays flat
on large backups.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import sqlite3
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

# Bump if the manifest layout or directory naming changes incompatibly.
FORMAT_VERSION = 1

# Names of dirs (relative to userData) that are always EXCLUDED from a backup.
# Either regenerable, ephemeral, or non-portable.
ALWAYS_EXCLUDED_DIRS = {
    ".claude",
    ".backup-rollback",
    ".backup-staging",
    "task-terminal-buffers",
}

# Subdirs of <userData>/files that should NOT be archived (regenerable cache).
FILES_EXCLUDED_SUBDIRS = {"_parsed"}


@dataclass
class ExportStats:
    conversations: int = 0
    messages: int = 0
    tasks: int = 0
    experts: int = 0
    routines: int = 0
    files_bytes: int = 0
    file_count: int = 0


@dataclass
class ExportResult:
    path: str
    size_bytes: int
    stats: ExportStats


def _sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _snapshot_db(src_db_path: Path, dest_db_path: Path) -> None:
    """Copy the live SQLite db to `dest_db_path` using the online backup API.

    Safe even when the FastAPI process has the source DB open for writes —
    SQLite's backup API takes short page-level locks rather than a full lock.
    """
    src = sqlite3.connect(f"file:{src_db_path}?mode=ro", uri=True)
    try:
        dest = sqlite3.connect(str(dest_db_path))
        try:
            with dest:
                src.backup(dest)
        finally:
            dest.close()
    finally:
        src.close()


def _walk_files(root: Path, skip_subdirs: Iterable[str] = ()) -> Iterable[Path]:
    """Yield every regular file under `root`, skipping the named top-level subdirs."""
    skip = set(skip_subdirs)
    if not root.exists():
        return
    for dirpath, dirnames, filenames in os.walk(root):
        # Prune top-level skips
        rel = Path(dirpath).relative_to(root)
        if rel == Path("."):
            dirnames[:] = [d for d in dirnames if d not in skip]
        for name in filenames:
            yield Path(dirpath) / name


def _count_stats(db_path: Path) -> ExportStats:
    """Pull a few summary counts from the snapshot for the manifest.

    Best-effort — missing tables (older schema) are silently treated as 0.
    """
    stats = ExportStats()
    if not db_path.exists():
        return stats
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        cur = conn.cursor()
        for table, attr in (
            ("conversations", "conversations"),
            ("messages", "messages"),
            ("tasks", "tasks"),
            ("experts", "experts"),
            ("routines", "routines"),
        ):
            try:
                cur.execute(f"SELECT COUNT(*) FROM {table}")
                setattr(stats, attr, int(cur.fetchone()[0]))
            except sqlite3.Error:
                pass
    finally:
        conn.close()
    return stats


def export_backup(
    *,
    user_data_dir: Path,
    db_path: Path,
    dest_path: Path,
    app_version: str,
    include_models: bool = False,
) -> ExportResult:
    """Build a complete backup at `dest_path`.

    `user_data_dir` is the Electron `userData` directory (parent of `cerebro.db`).
    The optional models flag is currently inert — local models live under
    `<userData>/models` and we hold a placeholder hook here so the frontend
    toggle has a single code path even before the GGUF wiring lands.
    """
    user_data_dir = user_data_dir.resolve()
    db_path = db_path.resolve()
    dest_path = dest_path.resolve()
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    # Stage the DB snapshot in a temp file we can hash + stream into the zip.
    with tempfile.TemporaryDirectory(prefix="cerebro-backup-") as tmp:
        tmp_dir = Path(tmp)
        snapshot_path = tmp_dir / "cerebro.db"
        _snapshot_db(db_path, snapshot_path)
        db_sha256 = _sha256_of(snapshot_path)
        stats = _count_stats(snapshot_path)

        contents: list[str] = ["db"]
        excluded: list[str] = ["parsed-cache", "terminal-buffers", "claude-runtime"]

        # Decide which directories to include.
        files_dir = user_data_dir / "files"
        agent_memory_dir = user_data_dir / "agent-memory"
        task_workspaces_dir = user_data_dir / "task-workspaces"
        models_dir = user_data_dir / "models"
        voice_models_dir = user_data_dir / "voice-models"

        dirs_to_archive: list[tuple[str, Path, set[str]]] = []
        if files_dir.exists():
            dirs_to_archive.append(("files", files_dir, FILES_EXCLUDED_SUBDIRS))
            contents.append("files")
        if agent_memory_dir.exists():
            dirs_to_archive.append(("agent-memory", agent_memory_dir, set()))
            contents.append("agent-memory")
        if task_workspaces_dir.exists():
            dirs_to_archive.append(("task-workspaces", task_workspaces_dir, set()))
            contents.append("task-workspaces")
        if include_models:
            if models_dir.exists():
                dirs_to_archive.append(("models", models_dir, set()))
                contents.append("models")
            if voice_models_dir.exists():
                dirs_to_archive.append(("voice-models", voice_models_dir, set()))
                contents.append("voice-models")
        else:
            excluded.extend(["models", "voice-models"])

        # Build the zip.
        with zipfile.ZipFile(dest_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            # DB snapshot first.
            zf.write(snapshot_path, arcname="cerebro.db")

            # Walk each included directory.
            for arc_root, src_root, skips in dirs_to_archive:
                for file_path in _walk_files(src_root, skip_subdirs=skips):
                    rel = file_path.relative_to(src_root)
                    arcname = f"{arc_root}/{rel.as_posix()}"
                    try:
                        size = file_path.stat().st_size
                    except OSError:
                        continue
                    stats.files_bytes += size
                    stats.file_count += 1
                    zf.write(file_path, arcname=arcname)

            manifest = {
                "format_version": FORMAT_VERSION,
                "cerebro_version": app_version,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "platform": platform.system().lower(),
                "contents": contents,
                "excluded": excluded,
                "db_sha256": db_sha256,
                "stats": {
                    "conversations": stats.conversations,
                    "messages": stats.messages,
                    "tasks": stats.tasks,
                    "experts": stats.experts,
                    "routines": stats.routines,
                    "files_bytes": stats.files_bytes,
                    "file_count": stats.file_count,
                },
            }
            zf.writestr("manifest.json", json.dumps(manifest, indent=2))

    size_bytes = dest_path.stat().st_size
    return ExportResult(path=str(dest_path), size_bytes=size_bytes, stats=stats)


def revert_partial_export(dest_path: Path) -> None:
    """Delete a half-written backup file (called on error in the router)."""
    try:
        if dest_path.exists():
            dest_path.unlink()
    except OSError:
        pass


def estimate_backup_size(user_data_dir: Path, db_path: Path, include_models: bool) -> int:
    """Sum the on-disk size of everything we'd put into a backup.

    Used by the Backup section to render a 'Estimated size: ~X MB' hint
    before the user clicks Create.
    """
    user_data_dir = user_data_dir.resolve()
    total = 0
    if db_path.exists():
        try:
            total += db_path.stat().st_size
        except OSError:
            pass

    dirs: list[tuple[Path, set[str]]] = []
    dirs.append((user_data_dir / "files", FILES_EXCLUDED_SUBDIRS))
    dirs.append((user_data_dir / "agent-memory", set()))
    dirs.append((user_data_dir / "task-workspaces", set()))
    if include_models:
        dirs.append((user_data_dir / "models", set()))
        dirs.append((user_data_dir / "voice-models", set()))

    for root, skips in dirs:
        for file_path in _walk_files(root, skip_subdirs=skips):
            try:
                total += file_path.stat().st_size
            except OSError:
                continue
    return total


def safe_remove_tree(path: Path) -> None:
    """`shutil.rmtree` that tolerates a missing path."""
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        pass
