"""HTTP surface for the parsing service. Called by Electron main's
MediaIngestService whenever the renderer attaches a binary file."""

from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import ParsedFile

from .service import (
    MAX_PARSED_CHARS_PER_FILE,
    ParsingError,
    parse_file,
    supported_extensions,
)

router = APIRouter()


class ParseRequest(BaseModel):
    file_path: str
    sha256: str | None = None  # caller may pre-hash to avoid re-reading bytes


class ParseResponse(BaseModel):
    sha256: str
    parsed_path: str
    char_count: int
    parser: str
    parser_version: str
    truncated: bool
    warning: str | None
    cached: bool


class ParseBatchRequest(BaseModel):
    files: list[ParseRequest]


class ParseBatchItem(BaseModel):
    file_path: str
    ok: bool
    result: ParseResponse | None = None
    error: str | None = None


class ParseBatchResponse(BaseModel):
    items: list[ParseBatchItem]


class CapabilitiesResponse(BaseModel):
    supported_extensions: list[str]
    max_parsed_chars_per_file: int


def _parsed_dir(request: Request) -> str:
    parsed_dir = getattr(request.app.state, "parsed_files_dir", None)
    if not parsed_dir:
        raise HTTPException(500, "parsed_files_dir not configured on app.state")
    return parsed_dir


@router.get("/capabilities", response_model=CapabilitiesResponse)
def capabilities():
    return CapabilitiesResponse(
        supported_extensions=supported_extensions(),
        max_parsed_chars_per_file=MAX_PARSED_CHARS_PER_FILE,
    )


@router.post("/parse", response_model=ParseResponse)
def parse(body: ParseRequest, request: Request, db: Session = Depends(get_db)):
    if not os.path.exists(body.file_path):
        raise HTTPException(404, f"File not found: {body.file_path}")
    try:
        res = parse_file(db, body.file_path, _parsed_dir(request), sha256=body.sha256)
    except ParsingError as e:
        raise HTTPException(422, str(e)) from e
    return ParseResponse(**res.__dict__)


@router.post("/parse/batch", response_model=ParseBatchResponse)
def parse_batch(
    body: ParseBatchRequest, request: Request, db: Session = Depends(get_db)
):
    parsed_dir = _parsed_dir(request)
    items: list[ParseBatchItem] = []
    for entry in body.files:
        if not os.path.exists(entry.file_path):
            items.append(
                ParseBatchItem(
                    file_path=entry.file_path, ok=False, error="file not found"
                )
            )
            continue
        try:
            res = parse_file(db, entry.file_path, parsed_dir, sha256=entry.sha256)
            items.append(
                ParseBatchItem(
                    file_path=entry.file_path,
                    ok=True,
                    result=ParseResponse(**res.__dict__),
                )
            )
        except ParsingError as e:
            items.append(
                ParseBatchItem(file_path=entry.file_path, ok=False, error=str(e))
            )
    return ParseBatchResponse(items=items)


@router.get("/parsed/{sha256}", response_model=ParseResponse | None)
def get_parsed(sha256: str, request: Request, db: Session = Depends(get_db)):
    parsed_dir = _parsed_dir(request)
    row = (
        db.query(ParsedFile)
        .filter(ParsedFile.sha256 == sha256)
        .order_by(ParsedFile.created_at.desc())
        .first()
    )
    if row is None:
        return None
    abs_path = os.path.join(parsed_dir, row.parsed_path)
    if not os.path.exists(abs_path):
        return None
    return ParseResponse(
        sha256=row.sha256,
        parsed_path=abs_path,
        char_count=row.char_count,
        parser=row.parser,
        parser_version=row.parser_version,
        truncated=row.char_count >= MAX_PARSED_CHARS_PER_FILE,
        warning=row.warning,
        cached=True,
    )
