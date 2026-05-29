"""Extract markdown from .xlsx via openpyxl. One markdown table per sheet."""

from __future__ import annotations

import openpyxl  # type: ignore[import-untyped]
from openpyxl import __version__ as OPENPYXL_VERSION  # type: ignore[import-untyped]


PARSER_NAME = "openpyxl"
PARSER_VERSION = OPENPYXL_VERSION


def extract(file_path: str) -> str:
    wb = openpyxl.load_workbook(file_path, data_only=True, read_only=True)
    parts: list[str] = []
    for sheet in wb.worksheets:
        md = _sheet_md(sheet)
        if md:
            parts.append(f"## Sheet: {sheet.title}\n\n{md}")
    wb.close()
    return ("\n\n".join(parts) or "").strip() + "\n"


def _sheet_md(sheet) -> str:
    rows = []
    for row in sheet.iter_rows(values_only=True):
        if all(cell is None for cell in row):
            continue
        rows.append(
            [
                ""
                if cell is None
                else str(cell).replace("\n", " ").replace("|", "\\|").strip()
                for cell in row
            ]
        )
    if not rows:
        return ""

    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]

    lines = ["| " + " | ".join(rows[0]) + " |"]
    lines.append("| " + " | ".join(["---"] * width) + " |")
    for r in rows[1:]:
        lines.append("| " + " | ".join(r) + " |")
    return "\n".join(lines)
