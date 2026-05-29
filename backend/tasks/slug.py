import re
import unicodedata

_SLUG_RE = re.compile(r"[^a-z0-9]+")
_MAX_SLUG_LEN = 80


def build_workspace_dir(title: str, task_id: str) -> str:
    """Compose a human-readable on-disk folder name for a task.

    Format: ``<slug>-<first 8 chars of task_id>``. The slug strips accents
    (so ``creación`` becomes ``creacion``), lowercases, collapses any
    non-alphanumeric run into a single hyphen, and caps at 80 chars at a
    hyphen boundary. The 8-hex suffix guarantees uniqueness across tasks
    that share a title.
    """
    normalized = unicodedata.normalize("NFKD", title or "")
    stripped = "".join(c for c in normalized if not unicodedata.combining(c))
    slug = _SLUG_RE.sub("-", stripped.lower()).strip("-")
    if len(slug) > _MAX_SLUG_LEN:
        slug = slug[:_MAX_SLUG_LEN].rstrip("-")
    if not slug:
        slug = "task"
    return f"{slug}-{task_id[:8]}"
