"""ParsingService — dispatches a binary file path to the right extractor,
caches result by sha256 + parser_version, returns a path to the parsed
sidecar that Claude Code's Read tool can safely consume.

Sync API (the chat send path is sync; office/PDF parsing under ~5 MB is
sub-second). A 10 s wallclock cap per file prevents pathological inputs
from wedging the request."""

from __future__ import annotations

import concurrent.futures
import hashlib
import logging
import os
from dataclasses import dataclass
from typing import Callable

from sqlalchemy.orm import Session

from models import ParsedFile

log = logging.getLogger(__name__)

# Per-file extractor wallclock budget. Office/PDF parses well under this for
# anything sane. STT lives on its own path (/voice/stt/transcribe-file).
PARSE_TIMEOUT_S = 10.0

# Hard cap on parsed-text size injected per attachment. Beyond this we
# truncate and append a footer so the model still sees structure.
MAX_PARSED_CHARS_PER_FILE = 60_000


# ─────────────────────────────────────────────────────────────────────────
# Extractor registry: file extension → callable returning extracted markdown.
# Loaded lazily so a missing optional dep (unlikely after requirements bump)
# doesn't break the rest of the backend boot.

_EXTRACTORS: dict[str, tuple[Callable[[str], str], str, str]] | None = None


def _registry() -> dict[str, tuple[Callable[[str], str], str, str]]:
    global _EXTRACTORS
    if _EXTRACTORS is not None:
        return _EXTRACTORS

    from .extractors import docx as docx_x
    from .extractors import pdf as pdf_x
    from .extractors import pptx as pptx_x
    from .extractors import xlsx as xlsx_x

    _EXTRACTORS = {
        "docx": (docx_x.extract, docx_x.PARSER_NAME, docx_x.PARSER_VERSION),
        "xlsx": (xlsx_x.extract, xlsx_x.PARSER_NAME, xlsx_x.PARSER_VERSION),
        "xlsm": (xlsx_x.extract, xlsx_x.PARSER_NAME, xlsx_x.PARSER_VERSION),
        "pptx": (pptx_x.extract, pptx_x.PARSER_NAME, pptx_x.PARSER_VERSION),
        "pdf": (pdf_x.extract, pdf_x.PARSER_NAME, pdf_x.PARSER_VERSION),
    }
    return _EXTRACTORS


def supported_extensions() -> list[str]:
    return sorted(_registry().keys())


# ─────────────────────────────────────────────────────────────────────────


@dataclass
class ParseResult:
    sha256: str
    parsed_path: str  # absolute path on disk
    char_count: int
    parser: str
    parser_version: str
    truncated: bool
    warning: str | None
    cached: bool  # True if served from sha cache


def _ext(file_path: str) -> str:
    return os.path.splitext(file_path)[1].lower().lstrip(".")


def _hash_file(file_path: str) -> str:
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _parsed_root(parsed_dir: str) -> str:
    os.makedirs(parsed_dir, exist_ok=True)
    return parsed_dir


class ParsingError(Exception):
    """Wraps any extractor failure with a user-presentable message."""


def parse_file(
    db: Session,
    file_path: str,
    parsed_dir: str,
    *,
    sha256: str | None = None,
) -> ParseResult:
    """Parse a binary file, write the markdown sidecar, return ParseResult.

    Raises ParsingError on unsupported extension, timeout, or extractor error.
    """
    ext = _ext(file_path)
    registry = _registry()
    if ext not in registry:
        raise ParsingError(f"Unsupported file type: .{ext}")

    extractor, parser_name, parser_version = registry[ext]
    sha = sha256 or _hash_file(file_path)

    # Cache hit short-circuit: same sha + same parser_version → return existing.
    cached = (
        db.query(ParsedFile)
        .filter(ParsedFile.sha256 == sha, ParsedFile.parser_version == parser_version)
        .one_or_none()
    )
    root = _parsed_root(parsed_dir)
    if cached is not None:
        abs_path = os.path.join(root, cached.parsed_path)
        if os.path.exists(abs_path):
            return ParseResult(
                sha256=sha,
                parsed_path=abs_path,
                char_count=cached.char_count,
                parser=cached.parser,
                parser_version=cached.parser_version,
                truncated=cached.char_count >= MAX_PARSED_CHARS_PER_FILE,
                warning=cached.warning,
                cached=True,
            )
        # Sidecar deleted out from under us — drop the row and re-parse.
        db.delete(cached)
        db.commit()

    # Run extractor under a wallclock cap.
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(extractor, file_path)
            text = future.result(timeout=PARSE_TIMEOUT_S)
    except concurrent.futures.TimeoutError as e:
        raise ParsingError(f"Parsing .{ext} timed out after {PARSE_TIMEOUT_S}s") from e
    except Exception as e:  # extractor-specific errors all surface the same way
        raise ParsingError(f"Could not parse .{ext}: {type(e).__name__}: {e}") from e

    truncated = False
    warning: str | None = None
    if len(text) > MAX_PARSED_CHARS_PER_FILE:
        text = (
            text[:MAX_PARSED_CHARS_PER_FILE]
            + f"\n\n[truncated — original was {len(text)} chars, capped at {MAX_PARSED_CHARS_PER_FILE}]\n"
        )
        truncated = True
        warning = "truncated"

    rel_name = f"{sha}.md"
    abs_path = os.path.join(root, rel_name)
    with open(abs_path, "w", encoding="utf-8") as f:
        f.write(text)

    row = ParsedFile(
        sha256=sha,
        parsed_path=rel_name,
        char_count=len(text),
        parser=parser_name,
        parser_version=parser_version,
        warning=warning,
    )
    db.merge(row)
    db.commit()

    return ParseResult(
        sha256=sha,
        parsed_path=abs_path,
        char_count=len(text),
        parser=parser_name,
        parser_version=parser_version,
        truncated=truncated,
        warning=warning,
        cached=False,
    )
