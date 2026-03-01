"""LLM-based memory extraction — extracts learned facts and knowledge entries from conversation."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

import numpy as np

from database import SessionLocal
from models import KnowledgeEntry, MemoryItem, _uuid_hex

from .embeddings import get_embedder

# ── Secret detection patterns ────────────────────────────────────

SECRET_PATTERNS = [
    re.compile(r"sk-[a-zA-Z0-9]{20,}"),              # OpenAI keys
    re.compile(r"hf_[a-zA-Z0-9]{20,}"),              # HuggingFace tokens
    re.compile(r"AIza[a-zA-Z0-9_\-]{35}"),           # Google API keys
    re.compile(r"ghp_[a-zA-Z0-9]{36}"),              # GitHub PATs
    re.compile(r"sk-ant-[a-zA-Z0-9\-]{20,}"),        # Anthropic keys
    re.compile(
        r"(?i)(api[_\-]?key|secret|password|token|credential)\s*[:=]\s*\S+"
    ),
]


def contains_secret(text: str) -> bool:
    """Return True if the text matches any known secret pattern."""
    for pattern in SECRET_PATTERNS:
        if pattern.search(text):
            return True
    return False


# ── Extraction prompt ────────────────────────────────────────────

EXTRACTION_PROMPT = """You are a memory extraction system. Analyze the conversation and extract two types of information:

1. FACTS: Persistent truths about the user (preferences, background, goals, relationships).
   - Third person: "User prefers..." not "You prefer..."
   - Must be durable — true beyond this conversation.

2. ENTRIES: Specific events, activities, or data points the user reported.
   - Include: what happened, when (if mentioned), measurable details.
   - Examples: workouts, meals, expenses, meetings, health readings, habit check-ins.

Rules:
- Extract ONLY information the USER revealed, not the assistant's suggestions.
- NEVER extract secrets, passwords, API keys, tokens, or credentials.
- NEVER extract transient chatter ("how are you", "thanks").
- If nothing substantive was revealed, return empty arrays.

Return ONLY valid JSON with no markdown formatting:
{"facts": ["fact1", "fact2"], "entries": [{"type": "entry_type", "occurred_at": "ISO datetime or null", "summary": "one-line summary", "data": {}}]}

If nothing new: {"facts": [], "entries": []}"""


# ── Non-streaming completion helper ──────────────────────────────


async def _complete(messages: list[dict]) -> str | None:
    """Call the active model and collect the full response.

    Tries cloud providers first (using credentials), then falls back to local inference.
    Returns the full text response, or None if no model is available.
    """
    # Try cloud providers
    from cloud_providers.adapters import STREAM_ADAPTERS, get_provider_key

    for provider in ("anthropic", "openai", "google"):
        api_key = get_provider_key(provider)
        if not api_key:
            continue
        adapter = STREAM_ADAPTERS.get(provider)
        if not adapter:
            continue
        try:
            # Pick a cheap model for extraction
            model_map = {
                "anthropic": "claude-haiku-4-5-20251001",
                "openai": "gpt-4o-mini",
                "google": "gemini-2.0-flash",
            }
            model = model_map[provider]
            collected = ""
            async for event in adapter(
                model=model,
                messages=messages,
                temperature=0.0,
                max_tokens=1024,
                top_p=1.0,
                api_key=api_key,
            ):
                if event.token:
                    collected += event.token
                if event.done:
                    break
            if collected:
                return collected
        except Exception:
            continue

    # Try local inference
    try:
        from local_models.router import inference_engine
        if inference_engine and inference_engine.state == "ready":
            result = inference_engine.llm.create_chat_completion(
                messages=messages,
                temperature=0.0,
                max_tokens=1024,
            )
            content = result["choices"][0]["message"]["content"]
            if content:
                return content
    except Exception:
        pass

    return None


# ── Deduplication ────────────────────────────────────────────────


def _is_duplicate(new_embedding: np.ndarray, existing_items: list[MemoryItem], threshold: float = 0.9) -> bool:
    """Check if a new fact is too similar to any existing one."""
    for item in existing_items:
        if item.embedding is None:
            continue
        existing_vec = np.frombuffer(item.embedding, dtype=np.float32)
        sim = float(np.dot(new_embedding, existing_vec) / (
            np.linalg.norm(new_embedding) * np.linalg.norm(existing_vec) + 1e-8
        ))
        if sim >= threshold:
            return True
    return False


# ── Main extraction function ─────────────────────────────────────


async def run_extraction(
    messages: list[dict],
    conversation_id: str | None = None,
    scope: str = "personal",
    scope_id: str | None = None,
) -> None:
    """Extract learned facts and knowledge entries from conversation messages.

    This runs as a background task — failures are silently ignored.
    """
    try:
        if not messages or len(messages) < 2:
            return

        # Build extraction prompt with the last user+assistant pair
        extraction_messages = [
            {"role": "system", "content": EXTRACTION_PROMPT},
            {"role": "user", "content": _format_conversation(messages)},
        ]

        response = await _complete(extraction_messages)
        if not response:
            return

        # Parse JSON from response (strip markdown fences if present)
        json_str = response.strip()
        if json_str.startswith("```"):
            lines = json_str.split("\n")
            json_str = "\n".join(lines[1:-1]) if len(lines) > 2 else json_str
        try:
            data = json.loads(json_str)
        except json.JSONDecodeError:
            return

        facts = data.get("facts", [])
        entries = data.get("entries", [])

        if not facts and not entries:
            return

        embedder = get_embedder()

        # Open a fresh DB session for the background task
        if SessionLocal is None:
            return
        db = SessionLocal()
        try:
            # Process facts
            if facts:
                # Load existing items for dedup
                q = db.query(MemoryItem).filter(MemoryItem.scope == scope)
                if scope_id:
                    q = q.filter(MemoryItem.scope_id == scope_id)
                else:
                    q = q.filter(MemoryItem.scope_id.is_(None))
                existing = q.all()

                for fact_text in facts:
                    if not isinstance(fact_text, str) or not fact_text.strip():
                        continue
                    if contains_secret(fact_text):
                        continue

                    vec = embedder.embed(fact_text)

                    if _is_duplicate(vec, existing):
                        continue

                    item = MemoryItem(
                        id=_uuid_hex(),
                        scope=scope,
                        scope_id=scope_id,
                        content=fact_text.strip(),
                        embedding=vec.tobytes(),
                        source_conversation_id=conversation_id,
                    )
                    db.add(item)
                    existing.append(item)

            # Process entries
            for entry_data in entries:
                if not isinstance(entry_data, dict):
                    continue
                summary = entry_data.get("summary", "")
                if not summary:
                    continue
                if contains_secret(summary):
                    continue
                if contains_secret(json.dumps(entry_data.get("data", {}))):
                    continue

                occurred_at_str = entry_data.get("occurred_at")
                if occurred_at_str:
                    try:
                        occurred_at = datetime.fromisoformat(occurred_at_str)
                        if occurred_at.tzinfo is None:
                            occurred_at = occurred_at.replace(tzinfo=timezone.utc)
                    except (ValueError, TypeError):
                        occurred_at = datetime.now(timezone.utc)
                else:
                    occurred_at = datetime.now(timezone.utc)

                vec = embedder.embed(summary)

                entry = KnowledgeEntry(
                    id=_uuid_hex(),
                    scope=scope,
                    scope_id=scope_id,
                    entry_type=entry_data.get("type", "note"),
                    occurred_at=occurred_at,
                    summary=summary.strip(),
                    content=json.dumps(entry_data.get("data", {})),
                    source="chat",
                    embedding=vec.tobytes(),
                    source_conversation_id=conversation_id,
                )
                db.add(entry)

            db.commit()
        except Exception:
            db.rollback()
        finally:
            db.close()

    except Exception:
        # Extraction is non-critical — never crash the app
        pass


def _format_conversation(messages: list[dict]) -> str:
    """Format messages for the extraction prompt."""
    lines = []
    for m in messages[-4:]:  # Last 2 pairs at most
        role = m.get("role", "user").upper()
        content = m.get("content", "")
        lines.append(f"{role}: {content}")
    return "\n\n".join(lines)
