"""Path validation for sandbox linked projects.

Rejects any attempt to link a sensitive system or credential directory. This is
belt-and-suspenders with the generated Seatbelt profile: a rejected path never
reaches profile generation in the first place.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from fastapi import Request


def cerebro_data_dir(request: Request) -> str | None:
    """Return the Cerebro data directory (parent of the SQLite DB), or None."""
    db_path = getattr(request.app.state, "db_path", None)
    if not db_path:
        return None
    return os.path.dirname(db_path)


@dataclass
class ValidationResult:
    ok: bool
    canonical: str
    reason: str | None = None


# Paths that can never be linked regardless of the user's own home layout.
# These are checked against the canonical (realpath-resolved) candidate.
_ABSOLUTE_FORBIDDEN_PREFIXES: tuple[str, ...] = (
    "/System",
    "/private/etc",
    "/etc",
    "/private/var/db",
    "/usr",
    "/bin",
    "/sbin",
    "/Library",  # /Library/Frameworks etc. — tools need to read, not link
)

# Subpaths of the user's home directory that must never be linked.
HOME_FORBIDDEN_SUBPATHS: tuple[str, ...] = (
    ".ssh",
    ".aws",
    ".gnupg",
    ".config/gh/hosts.yml",
    "Library/Keychains",
    "Library/Application Support/1Password",
    "Library/Application Support/Bitwarden",
    "Library/Cookies",
    "Library/Mail",
    "Library/Messages",
)


def validate_link_path(raw_path: str, cerebro_data_dir: str | None) -> ValidationResult:
    """Canonicalize ``raw_path`` and reject it if it falls inside a forbidden root.

    ``cerebro_data_dir`` is the Cerebro userData directory (e.g.
    ``~/Library/Application Support/Cerebro``). We refuse to link the dir itself
    or any ancestor of it — linking the dir would give the agent write access
    to Cerebro's own state, and linking an ancestor would transitively do the
    same.
    """
    if not raw_path or not raw_path.strip():
        return ValidationResult(False, "", "Path is empty")

    expanded = os.path.expanduser(raw_path.strip())
    if not os.path.isabs(expanded):
        return ValidationResult(False, "", "Path must be absolute")

    try:
        canonical = os.path.realpath(expanded)
    except OSError as exc:
        return ValidationResult(False, "", f"Cannot resolve path: {exc}")

    if not os.path.isdir(canonical):
        return ValidationResult(False, canonical, "Path is not a directory")

    # Root itself
    if canonical == "/" or canonical == "":
        return ValidationResult(False, canonical, "Cannot link the filesystem root")

    # Absolute forbidden roots
    for forbidden in _ABSOLUTE_FORBIDDEN_PREFIXES:
        if canonical == forbidden or canonical.startswith(forbidden + os.sep):
            return ValidationResult(
                False, canonical, f"Path is inside a protected system directory ({forbidden})"
            )

    # Home-relative forbidden subpaths
    home = os.path.expanduser("~")
    for rel in HOME_FORBIDDEN_SUBPATHS:
        forbidden = os.path.join(home, rel)
        if canonical == forbidden or canonical.startswith(forbidden + os.sep):
            return ValidationResult(
                False, canonical, f"Path is inside a protected credential directory (~/{rel})"
            )

    # Cerebro's own data dir and any ancestor of it
    if cerebro_data_dir:
        data_canonical = os.path.realpath(cerebro_data_dir)
        if canonical == data_canonical or canonical.startswith(data_canonical + os.sep):
            return ValidationResult(
                False, canonical, "Cannot link Cerebro's own data directory"
            )
        if data_canonical.startswith(canonical + os.sep):
            return ValidationResult(
                False, canonical, "Cannot link a directory that contains Cerebro's data directory"
            )

    return ValidationResult(True, canonical)
