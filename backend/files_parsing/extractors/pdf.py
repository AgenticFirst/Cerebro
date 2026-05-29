"""Extract markdown from .pdf via pypdf."""

from __future__ import annotations

from pypdf import PdfReader  # type: ignore[import-untyped]
from pypdf import __version__ as PYPDF_VERSION  # type: ignore[import-untyped]


PARSER_NAME = "pypdf"
PARSER_VERSION = PYPDF_VERSION


def extract(file_path: str) -> str:
    reader = PdfReader(file_path)
    parts: list[str] = []
    for idx, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        if text:
            parts.append(f"## Page {idx}\n\n{text}")
    return ("\n\n".join(parts) or "").strip() + "\n"
