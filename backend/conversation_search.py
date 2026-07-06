"""Global search across all conversations — GET /conversations/search.

Full-text search over message content and conversation titles so a user who
barely remembers a chat can find it from a fragment. Uses the FTS5 indexes
built by database._setup_chat_fts (BM25 relevance, prefix match, diacritic
folding for Spanish) when available; otherwise an escaped ilike substring
search. Both paths return snippets with matches wrapped in the same sentinel
chars the Knowledge Base search uses, so the UI highlights them identically.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import text

import database
from database import get_db
from models import Conversation, Message

router = APIRouter(tags=["conversation-search"])

# Sentinel chars wrapping matched spans in snippets; the UI splits on these to
# highlight matches without parsing HTML (same contract as knowledge search).
SNIP_START = "\x01"
SNIP_END = "\x02"

# Only human-visible chat turns are searchable; tool/system messages are noise.
SEARCHABLE_ROLES = ("user", "assistant")

# Scan cap for message hits before grouping by conversation. Bounds work on
# huge histories while leaving plenty of candidates for the top `limit` convs.
_MESSAGE_SCAN_LIMIT = 300

_SNIPPETS_PER_CONVERSATION = 3


def fts_match_query(user_query: str) -> str | None:
    """Convert free text into a safe FTS5 prefix-match query.

    Whitespace tokenization (NOT an [A-Za-z0-9]+ regex, which would mangle
    accented words like "medición"); each token becomes "token"* so partial
    words match while FTS5 operators in user input (AND/OR/NEAR/quotes) are
    neutralized. Returns None when there are no usable tokens.
    """
    tokens = [t.replace('"', '""') for t in user_query.split() if t.strip()]
    if not tokens:
        return None
    return " ".join(f'"{t}"*' for t in tokens)


def _plain_snippet(value: str, query: str, radius: int = 60) -> str:
    """Build a snippet around the first match of the full phrase or any token,
    wrapping the matched span in the sentinel chars. Returns '' if no match."""
    if not value:
        return ""
    low = value.lower()
    needle = query.lower().strip()
    idx = low.find(needle) if needle else -1
    if idx < 0:
        for tok in query.split():
            idx = low.find(tok.lower())
            if idx >= 0:
                needle = tok.lower()
                break
    if idx < 0:
        return ""
    start = max(0, idx - radius)
    end = min(len(value), idx + len(needle) + radius)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(value) else ""
    matched = value[idx : idx + len(needle)]
    return (
        f"{prefix}{value[start:idx]}{SNIP_START}{matched}{SNIP_END}"
        f"{value[idx + len(needle):end]}{suffix}"
    )


# ── Schemas ───────────────────────────────────────────────────────


class MessageHitSnippet(BaseModel):
    message_id: str
    role: str
    snippet: str
    created_at: datetime


class ConversationSearchHit(BaseModel):
    conversation_id: str
    title: str
    title_snippet: str | None = None
    expert_id: str | None = None
    source: str
    updated_at: datetime
    match_count: int
    message_hits: list[MessageHitSnippet]


class ConversationSearchResponse(BaseModel):
    results: list[ConversationSearchHit]


class _ConvAccumulator:
    """Per-conversation aggregation of message hits (kept in rank order)."""

    __slots__ = ("count", "best_rank", "snippets")

    def __init__(self) -> None:
        self.count = 0
        self.best_rank = 0.0
        self.snippets: list[MessageHitSnippet] = []

    def add(self, hit: MessageHitSnippet, rank: float) -> None:
        if self.count == 0 or rank < self.best_rank:
            self.best_rank = rank
        self.count += 1
        if len(self.snippets) < _SNIPPETS_PER_CONVERSATION:
            self.snippets.append(hit)


# ── Endpoint ──────────────────────────────────────────────────────


@router.get("/conversations/search", response_model=ConversationSearchResponse)
def search_conversations(
    q: str = Query("", description="Search text"),
    limit: int = Query(20, ge=1, le=50),
    db=Depends(get_db),
):
    """Search every conversation by title and message content.

    Results are grouped by conversation: title matches rank first (the "I
    remember what it was about" case), then message relevance (BM25), with
    recency as the tiebreak. Each hit carries up to 3 message snippets.
    """
    query = (q or "").strip()
    if not query:
        return ConversationSearchResponse(results=[])

    if database.CHAT_FTS_AVAILABLE:
        match = fts_match_query(query)
        if match is None:
            return ConversationSearchResponse(results=[])
        try:
            return _search_fts(db, query, match, limit)
        except Exception:  # noqa: BLE001 — fall back to ilike on any FTS runtime error
            db.rollback()

    return _search_ilike(db, query, limit)


def _search_fts(db, query: str, match: str, limit: int) -> ConversationSearchResponse:
    # Message hits, already in relevance order. The JOINs back to the base
    # tables guarantee no ghost hits even if a trigger ever missed a delete.
    msg_rows = db.execute(
        text(
            "SELECT f.id AS message_id, f.conversation_id, m.role, m.created_at, "
            "snippet(messages_fts, 2, :s, :e, '…', 12) AS snip, "
            "bm25(messages_fts) AS rank "
            "FROM messages_fts f "
            "JOIN messages m ON m.id = f.id "
            "JOIN conversations c ON c.id = f.conversation_id "
            "WHERE messages_fts MATCH :m AND m.role IN ('user', 'assistant') "
            "ORDER BY bm25(messages_fts) "
            "LIMIT :lim"
        ),
        {"s": SNIP_START, "e": SNIP_END, "m": match, "lim": _MESSAGE_SCAN_LIMIT},
    ).all()

    by_conv: dict[str, _ConvAccumulator] = {}
    for row in msg_rows:
        acc = by_conv.setdefault(row.conversation_id, _ConvAccumulator())
        acc.add(
            MessageHitSnippet(
                message_id=row.message_id,
                role=row.role,
                snippet=row.snip or "",
                created_at=row.created_at,
            ),
            row.rank,
        )

    title_rows = db.execute(
        text(
            "SELECT f.id AS conversation_id, "
            "snippet(conversations_fts, 1, :s, :e, '…', 12) AS snip "
            "FROM conversations_fts f "
            "JOIN conversations c ON c.id = f.id "
            "WHERE conversations_fts MATCH :m "
            "ORDER BY bm25(conversations_fts) "
            "LIMIT :lim"
        ),
        {"s": SNIP_START, "e": SNIP_END, "m": match, "lim": limit * 3},
    ).all()
    title_snips = {row.conversation_id: row.snip or "" for row in title_rows}

    return _assemble(db, by_conv, title_snips, limit)


def _search_ilike(db, query: str, limit: int) -> ConversationSearchResponse:
    """Escaped substring fallback when FTS5 is unavailable. Accent-sensitive
    (no diacritic folding) — an accepted degradation."""
    safe = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    pattern = f"%{safe}%"

    msg_rows = (
        db.query(Message)
        .filter(
            Message.role.in_(SEARCHABLE_ROLES),
            Message.content.ilike(pattern, escape="\\"),
        )
        .order_by(Message.created_at.desc())
        .limit(_MESSAGE_SCAN_LIMIT)
        .all()
    )
    by_conv: dict[str, _ConvAccumulator] = {}
    for m in msg_rows:
        acc = by_conv.setdefault(m.conversation_id, _ConvAccumulator())
        snip = _plain_snippet(m.content or "", query)
        if not snip:
            continue
        acc.add(
            MessageHitSnippet(
                message_id=m.id, role=m.role, snippet=snip, created_at=m.created_at
            ),
            0.0,
        )

    title_convs = (
        db.query(Conversation)
        .filter(Conversation.title.ilike(pattern, escape="\\"))
        .order_by(Conversation.updated_at.desc())
        .limit(limit * 3)
        .all()
    )
    title_snips = {
        c.id: _plain_snippet(c.title or "", query) or (c.title or "") for c in title_convs
    }

    return _assemble(db, by_conv, title_snips, limit)


def _assemble(
    db,
    by_conv: dict[str, _ConvAccumulator],
    title_snips: dict[str, str],
    limit: int,
) -> ConversationSearchResponse:
    conv_ids = set(by_conv) | set(title_snips)
    if not conv_ids:
        return ConversationSearchResponse(results=[])

    convs = {
        c.id: c
        for c in db.query(Conversation).filter(Conversation.id.in_(conv_ids)).all()
    }

    hits: list[tuple[tuple, ConversationSearchHit]] = []
    for conv_id in conv_ids:
        conv = convs.get(conv_id)
        if conv is None:
            continue
        acc = by_conv.get(conv_id)
        title_matched = conv_id in title_snips
        sort_key = (
            0 if title_matched else 1,
            acc.best_rank if acc and acc.count else 0.0,
            -conv.updated_at.timestamp(),
        )
        hits.append(
            (
                sort_key,
                ConversationSearchHit(
                    conversation_id=conv_id,
                    title=conv.title or "",
                    title_snippet=title_snips.get(conv_id),
                    expert_id=conv.expert_id,
                    source=conv.source or "cerebro",
                    updated_at=conv.updated_at,
                    match_count=acc.count if acc else 0,
                    message_hits=acc.snippets if acc else [],
                ),
            )
        )

    hits.sort(key=lambda pair: pair[0])
    return ConversationSearchResponse(results=[h for _, h in hits[:limit]])
