"""Pydantic schemas for the script execution system."""

from __future__ import annotations

from pydantic import BaseModel


class ScriptExecuteRequest(BaseModel):
    language: str = "python"  # "python" or "javascript"
    code: str
    input_data: dict = {}
    timeout: int = 30


class ScriptExecuteResponse(BaseModel):
    result: dict | None = None
    stdout: str = ""
    stderr: str = ""
    exit_code: int = 0
    duration_ms: int = 0
