"""Per-task workspace creation, deletion, and file browsing helpers.

Task workspaces live at ``<data_dir>/task-workspaces/<task_id>/`` — this
is load-bearing because the sandbox-exec profile makes the entire
``cerebroDataDir`` writable (see plan section 2e). Anywhere else and
sandboxed claude subprocesses cannot write to them.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass

# Files/dirs to hard-exclude from workspace tree listings even if not
# gitignored. These are scaffolder byproducts, not task output.
_HARD_EXCLUDE_DIRS = frozenset({
    "node_modules",
    ".git",
    ".next",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".expo",
    ".turbo",
    ".parcel-cache",
    ".cache",
})

_BINARY_EXT = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff",
    ".pdf", ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
    ".mp3", ".mp4", ".mov", ".avi", ".wav", ".flac", ".ogg",
    ".ttf", ".otf", ".woff", ".woff2",
    ".so", ".dylib", ".dll", ".exe", ".o", ".a",
    ".db", ".sqlite", ".sqlite3",
    ".pyc", ".pyo",
})

_LANG_BY_EXT = {
    ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
    ".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust",
    ".java": "java", ".kt": "kotlin", ".swift": "swift", ".c": "c",
    ".cpp": "cpp", ".cc": "cpp", ".h": "c", ".hpp": "cpp",
    ".cs": "csharp", ".php": "php", ".sh": "bash", ".bash": "bash",
    ".zsh": "bash", ".fish": "bash", ".ps1": "powershell",
    ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
    ".xml": "xml", ".html": "html", ".htm": "html",
    ".css": "css", ".scss": "scss", ".sass": "sass", ".less": "less",
    ".md": "markdown", ".mdx": "markdown", ".rst": "rst",
    ".sql": "sql", ".graphql": "graphql", ".gql": "graphql",
    ".vue": "vue", ".svelte": "svelte",
    ".dockerfile": "docker",
}

_MAX_FILE_PREVIEW_BYTES = 1_000_000  # 1 MB
_MAX_TREE_ENTRIES = 5000


@dataclass
class WorkspaceRoots:
    data_dir: str
    task_workspaces_root: str

    @classmethod
    def for_data_dir(cls, data_dir: str) -> "WorkspaceRoots":
        abs_data = os.path.realpath(data_dir)
        return cls(
            data_dir=abs_data,
            task_workspaces_root=os.path.join(abs_data, "task-workspaces"),
        )

    def path_for(self, task_id: str) -> str:
        return os.path.join(self.task_workspaces_root, task_id)


def create_workspace(data_dir: str, task_id: str) -> str:
    """Create ``<data_dir>/task-workspaces/<task_id>/`` and symlink .claude.

    Returns the absolute workspace path. Idempotent — if the directory
    already exists, does nothing.
    """
    roots = WorkspaceRoots.for_data_dir(data_dir)
    os.makedirs(roots.task_workspaces_root, exist_ok=True)
    workspace = roots.path_for(task_id)
    os.makedirs(workspace, exist_ok=True)

    # Symlink <workspace>/.claude → <data_dir>/.claude so Claude Code
    # still discovers agents + skills + scripts while running with
    # cwd=workspace.
    claude_target = os.path.join(roots.data_dir, ".claude")
    claude_link = os.path.join(workspace, ".claude")
    if os.path.isdir(claude_target) and not os.path.lexists(claude_link):
        try:
            os.symlink(claude_target, claude_link, target_is_directory=True)
        except OSError:
            # Windows without symlink privileges — the tasks feature is
            # macOS-first per the sandbox scoping, so leave a breadcrumb.
            pass

    return workspace


def delete_workspace(data_dir: str, task_id: str) -> bool:
    """Delete the task's workspace directory.

    Uses a realpath-prefix check to refuse any path that doesn't resolve
    inside ``<data_dir>/task-workspaces/``. Belt-and-suspenders against
    ever pointing workspace_path at the data dir or home dir.

    Returns True if the workspace was deleted.
    """
    roots = WorkspaceRoots.for_data_dir(data_dir)
    target = roots.path_for(task_id)
    if not os.path.exists(target):
        return False

    real_target = os.path.realpath(target)
    real_root = os.path.realpath(roots.task_workspaces_root)
    if not real_target.startswith(real_root + os.sep) and real_target != real_root:
        raise ValueError(
            f"Refusing to delete {target}: not inside {roots.task_workspaces_root}"
        )

    # unlink the .claude symlink first so rmtree doesn't follow it
    claude_link = os.path.join(target, ".claude")
    if os.path.islink(claude_link):
        try:
            os.unlink(claude_link)
        except OSError:
            pass

    shutil.rmtree(target, ignore_errors=True)
    return True


def _resolve_inside_workspace(workspace_path: str, rel_path: str) -> str:
    """Resolve ``rel_path`` against ``workspace_path`` and verify it stays inside.

    Rejects absolute paths, ``..`` traversals, and symlinks pointing outside.
    Raises ValueError on violation.
    """
    if os.path.isabs(rel_path):
        raise ValueError("absolute paths not allowed")
    # Reject explicit parent-dir segments before resolution
    parts = rel_path.replace("\\", "/").split("/")
    if any(p == ".." for p in parts):
        raise ValueError("parent-dir traversal not allowed")

    real_root = os.path.realpath(workspace_path)
    candidate = os.path.realpath(os.path.join(real_root, rel_path))
    if candidate != real_root and not candidate.startswith(real_root + os.sep):
        raise ValueError("path escapes workspace")
    return candidate


def _prune_walk_dirs(dirnames: list[str], dirpath: str) -> None:
    """Mutate *dirnames* in-place to skip excluded and symlinked dirs."""
    dirnames[:] = [
        d
        for d in dirnames
        if d not in _HARD_EXCLUDE_DIRS
        and not d.startswith(".git")
        and not os.path.islink(os.path.join(dirpath, d))
    ]


def list_tree(workspace_path: str) -> tuple[list[dict], bool]:
    """Return a flat listing of the workspace contents.

    Respects ``_HARD_EXCLUDE_DIRS`` and caps at ``_MAX_TREE_ENTRIES``.
    Returns ``(files, truncated)``.
    """
    if not os.path.isdir(workspace_path):
        return [], False

    real_root = os.path.realpath(workspace_path)
    entries: list[dict] = []
    truncated = False

    for dirpath, dirnames, filenames in os.walk(real_root, followlinks=False):
        _prune_walk_dirs(dirnames, dirpath)

        rel_dir = os.path.relpath(dirpath, real_root)
        if rel_dir != ".":
            entries.append({
                "path": rel_dir.replace(os.sep, "/"),
                "size": 0,
                "is_dir": True,
            })
            if len(entries) >= _MAX_TREE_ENTRIES:
                truncated = True
                break

        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            try:
                st = os.lstat(full)
            except OSError:
                continue
            if os.path.islink(full):
                continue
            rel = os.path.relpath(full, real_root).replace(os.sep, "/")
            entries.append({"path": rel, "size": st.st_size, "is_dir": False})
            if len(entries) >= _MAX_TREE_ENTRIES:
                truncated = True
                break
        if truncated:
            break

    entries.sort(key=lambda e: (not e["is_dir"], e["path"]))
    return entries, truncated


def read_file(workspace_path: str, rel_path: str) -> dict:
    """Read a single file from the workspace for readonly preview.

    Refuses binaries by extension and files larger than 1 MB.
    """
    abs_path = _resolve_inside_workspace(workspace_path, rel_path)
    if not os.path.isfile(abs_path):
        raise FileNotFoundError(rel_path)

    st = os.stat(abs_path)
    ext = os.path.splitext(abs_path)[1].lower()
    if ext in _BINARY_EXT:
        raise ValueError("binary file preview not supported")
    if st.st_size > _MAX_FILE_PREVIEW_BYTES:
        raise ValueError(f"file too large ({st.st_size} bytes, max {_MAX_FILE_PREVIEW_BYTES})")

    with open(abs_path, "rb") as fh:
        raw = fh.read()
    # Detect binary by sniffing NUL bytes in the first 8 KB
    if b"\x00" in raw[:8192]:
        raise ValueError("binary file preview not supported")
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        content = raw.decode("latin-1")

    return {
        "path": rel_path,
        "content": content,
        "language": _LANG_BY_EXT.get(ext),
        "size": st.st_size,
        "mtime": st.st_mtime,
    }


PLAN_MD_FILENAME = "PLAN.md"
_MAX_PLAN_MD_BYTES = 200_000


def read_plan_md(workspace_path: str) -> dict | None:
    """Return ``{"content": str, "mtime": float}`` for ``<workspace>/PLAN.md``.

    Returns ``None`` if the workspace doesn't exist or the file hasn't been
    written yet.
    """
    if not os.path.isdir(workspace_path):
        return None
    abs_path = os.path.join(os.path.realpath(workspace_path), PLAN_MD_FILENAME)
    if not os.path.isfile(abs_path):
        return None
    try:
        st = os.stat(abs_path)
    except OSError:
        return None
    with open(abs_path, "rb") as fh:
        raw = fh.read(_MAX_PLAN_MD_BYTES)
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        content = raw.decode("latin-1")
    return {"content": content, "mtime": st.st_mtime}


def write_plan_md(workspace_path: str, content: str) -> float:
    """Write ``PLAN.md`` atomically, returning the new mtime.

    Creates the workspace directory if it doesn't already exist — the task
    may be in planning state before anything else has been written.
    """
    if len(content.encode("utf-8")) > _MAX_PLAN_MD_BYTES:
        raise ValueError(f"PLAN.md too large (max {_MAX_PLAN_MD_BYTES} bytes)")
    os.makedirs(workspace_path, exist_ok=True)
    real_root = os.path.realpath(workspace_path)
    abs_path = os.path.join(real_root, PLAN_MD_FILENAME)
    tmp_path = abs_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as fh:
        fh.write(content)
    os.replace(tmp_path, abs_path)
    return os.stat(abs_path).st_mtime


def find_preview_file(
    workspace_path: str,
    known_path: str | None = None,
) -> dict | None:
    """Scan workspace for the best previewable HTML file.

    Priority: index.html in root > any .html in root >
    index.html in subdirs > any .html in subdirs.
    Returns ``read_file``-style dict with ``mtime`` or ``None``.

    When *known_path* is provided the scan is skipped and we read that
    file directly — much cheaper for repeated polls.
    """
    if not os.path.isdir(workspace_path):
        return None

    if known_path is not None:
        try:
            return read_file(workspace_path, known_path)
        except (FileNotFoundError, ValueError):
            return None

    real_root = os.path.realpath(workspace_path)

    # 1. index.html in root
    candidate = os.path.join(real_root, "index.html")
    if os.path.isfile(candidate):
        try:
            return read_file(workspace_path, "index.html")
        except (FileNotFoundError, ValueError):
            pass

    # 2. Any .html in root
    try:
        for name in sorted(os.listdir(real_root)):
            if name.lower().endswith(".html") and os.path.isfile(
                os.path.join(real_root, name)
            ):
                try:
                    return read_file(workspace_path, name)
                except (FileNotFoundError, ValueError):
                    continue
    except OSError:
        pass

    # 3. index.html or any .html in subdirectories
    first_nested_html: str | None = None
    for dirpath, dirnames, filenames in os.walk(real_root, followlinks=False):
        _prune_walk_dirs(dirnames, dirpath)
        if dirpath == real_root:
            continue
        for fn in sorted(filenames):
            if not fn.lower().endswith(".html"):
                continue
            rel = os.path.relpath(
                os.path.join(dirpath, fn), real_root
            ).replace(os.sep, "/")
            if fn.lower() == "index.html":
                try:
                    return read_file(workspace_path, rel)
                except (FileNotFoundError, ValueError):
                    continue
            if first_nested_html is None:
                first_nested_html = rel

    if first_nested_html is not None:
        try:
            return read_file(workspace_path, first_nested_html)
        except (FileNotFoundError, ValueError):
            pass

    return None
