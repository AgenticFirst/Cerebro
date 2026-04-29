"""Extract markdown from .docx via python-docx."""

from __future__ import annotations

import docx  # type: ignore[import-untyped]
from docx import __version__ as DOCX_VERSION  # type: ignore[import-untyped]


PARSER_NAME = "python-docx"
PARSER_VERSION = DOCX_VERSION


def extract(file_path: str) -> str:
    doc = docx.Document(file_path)
    parts: list[str] = []

    # Walk the body in document order so paragraphs and tables interleave
    # the way they appear visually.
    body = doc.element.body
    for child in body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "p":
            text = _para_text(child, doc)
            if text:
                parts.append(text)
        elif tag == "tbl":
            md = _table_md(child, doc)
            if md:
                parts.append(md)

    return "\n\n".join(parts).strip() + "\n"


def _para_text(p_element, doc) -> str:
    from docx.text.paragraph import Paragraph  # type: ignore[import-untyped]

    para = Paragraph(p_element, doc)
    text = para.text.strip()
    if not text:
        return ""

    style = (para.style.name if para.style is not None else "") or ""
    style_lower = style.lower()
    if style_lower.startswith("heading"):
        # "Heading 1" → "# ", "Heading 2" → "## ", etc.
        try:
            level = int(style.split()[-1])
            level = max(1, min(level, 6))
        except (ValueError, IndexError):
            level = 1
        return f"{'#' * level} {text}"
    if style_lower in ("title",):
        return f"# {text}"
    return text


def _table_md(tbl_element, doc) -> str:
    from docx.table import Table  # type: ignore[import-untyped]

    table = Table(tbl_element, doc)
    rows = []
    for row in table.rows:
        cells = [
            (cell.text or "").replace("\n", " ").replace("|", "\\|").strip()
            for cell in row.cells
        ]
        rows.append(cells)

    if not rows:
        return ""

    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]

    lines = ["| " + " | ".join(rows[0]) + " |"]
    lines.append("| " + " | ".join(["---"] * width) + " |")
    for r in rows[1:]:
        lines.append("| " + " | ".join(r) + " |")
    return "\n".join(lines)
