"""SQLite FTS5 index over gmail_messages.

External-content FTS5 table + triggers keep the index in lockstep with ORM
writes (triggers fire inside SQLite regardless of who writes the rows). Some
Python builds ship SQLite without FTS5 — ensure_fts() degrades gracefully and
search falls back to LIKE.
"""
from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.engine import Engine

logger = logging.getLogger(__name__)

_FTS_STATE: dict[str, bool | None] = {"available": None}

_CREATE_STATEMENTS = [
    """
    CREATE VIRTUAL TABLE IF NOT EXISTS gmail_messages_fts USING fts5(
        subject, from_addr, to_addrs, snippet, body_text,
        content='gmail_messages', content_rowid='rowid'
    )
    """,
    """
    CREATE TRIGGER IF NOT EXISTS gmail_messages_fts_ai AFTER INSERT ON gmail_messages BEGIN
        INSERT INTO gmail_messages_fts(rowid, subject, from_addr, to_addrs, snippet, body_text)
        VALUES (new.rowid, new.subject, new.from_addr, new.to_addrs, new.snippet, new.body_text);
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS gmail_messages_fts_ad AFTER DELETE ON gmail_messages BEGIN
        INSERT INTO gmail_messages_fts(gmail_messages_fts, rowid, subject, from_addr, to_addrs, snippet, body_text)
        VALUES ('delete', old.rowid, old.subject, old.from_addr, old.to_addrs, old.snippet, old.body_text);
    END
    """,
    """
    CREATE TRIGGER IF NOT EXISTS gmail_messages_fts_au AFTER UPDATE ON gmail_messages BEGIN
        INSERT INTO gmail_messages_fts(gmail_messages_fts, rowid, subject, from_addr, to_addrs, snippet, body_text)
        VALUES ('delete', old.rowid, old.subject, old.from_addr, old.to_addrs, old.snippet, old.body_text);
        INSERT INTO gmail_messages_fts(rowid, subject, from_addr, to_addrs, snippet, body_text)
        VALUES (new.rowid, new.subject, new.from_addr, new.to_addrs, new.snippet, new.body_text);
    END
    """,
]


def ensure_fts(engine: Engine) -> bool:
    """Create the FTS table + triggers once. Returns FTS availability."""
    if _FTS_STATE["available"] is not None:
        return bool(_FTS_STATE["available"])
    try:
        with engine.begin() as conn:
            for stmt in _CREATE_STATEMENTS:
                conn.execute(text(stmt))
        _FTS_STATE["available"] = True
    except Exception as exc:  # noqa: BLE001 — any failure means "no FTS on this build"
        logger.warning("Gmail FTS5 unavailable, search falls back to LIKE: %s", exc)
        _FTS_STATE["available"] = False
    return bool(_FTS_STATE["available"])


def fts_query_string(user_query: str) -> str:
    """Convert free text into a safe FTS5 prefix-match query.

    Each token becomes "token"* so partial words match while FTS5 operators in
    user input (AND/OR/NEAR/quotes) are neutralized.
    """
    tokens = [t.replace('"', '""') for t in user_query.split() if t.strip()]
    return " ".join(f'"{t}"*' for t in tokens)
