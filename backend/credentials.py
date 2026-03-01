"""Runtime credential holder.

Stores credentials in memory (pushed from Electron main process)
and falls back to environment variables.
"""

from __future__ import annotations

import os

_credentials: dict[str, str | None] = {}


def set_credential(key: str, value: str | None) -> None:
    """Set or clear an in-memory credential."""
    _credentials[key] = value


def get_credential(key: str) -> str | None:
    """Return a credential: check in-memory first, then os.environ."""
    if key in _credentials:
        return _credentials[key]
    return os.environ.get(key)
