"""FastAPI router for script execution — /scripts/* endpoints."""

from __future__ import annotations

import json
import os
import signal as sig
import subprocess
import tempfile
import time

from fastapi import APIRouter, HTTPException

from .schemas import ScriptExecuteRequest, ScriptExecuteResponse

router = APIRouter(tags=["scripts"])


@router.post("/execute", response_model=ScriptExecuteResponse)
def execute_script(body: ScriptExecuteRequest):
    """Execute a Python script in a sandboxed subprocess."""
    if body.language != "python":
        raise HTTPException(
            status_code=400,
            detail="Only Python execution is supported on the backend. "
                   "JavaScript execution is handled client-side.",
        )

    if not body.code.strip():
        raise HTTPException(status_code=400, detail="No code provided")

    # Write script to a temp file with input preamble + output helper
    preamble = (
        f"import json\n"
        f"input = json.loads({json.dumps(json.dumps(body.input_data))})\n"
        f"output = {{}}\n"
    )
    suffix = "\nif output:\n    print(json.dumps(output))\n"
    full_code = preamble + body.code + suffix

    start = time.time()

    with tempfile.NamedTemporaryFile(
        mode="w",
        suffix=".py",
        delete=False,
        prefix="cerebro_script_",
    ) as f:
        f.write(full_code)
        temp_path = f.name

    try:
        # Use Popen with start_new_session so we can kill the entire process group on timeout
        proc = subprocess.Popen(
            ["python3", temp_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=tempfile.gettempdir(),
            start_new_session=True,
        )

        try:
            stdout, stderr = proc.communicate(timeout=body.timeout)
        except subprocess.TimeoutExpired:
            # Kill the entire process group
            try:
                os.killpg(os.getpgid(proc.pid), sig.SIGKILL)
            except (ProcessLookupError, OSError):
                pass
            proc.wait()
            duration_ms = int((time.time() - start) * 1000)
            return ScriptExecuteResponse(
                stderr=f"Script timed out after {body.timeout}s",
                exit_code=124,
                duration_ms=duration_ms,
            )

        duration_ms = int((time.time() - start) * 1000)

        # Try to parse stdout as a JSON object for the result. The response
        # schema requires `result: dict | None`, so non-object JSON values
        # (numbers, strings, arrays, booleans) are wrapped under `output`
        # rather than returned bare — bare values would fail response
        # validation and surface as 500 to the caller.
        parsed_result = None
        stripped = stdout.strip()
        if stripped:
            last_line = stripped.split("\n")[-1]
            try:
                candidate = json.loads(last_line)
            except json.JSONDecodeError:
                candidate = None
            if isinstance(candidate, dict):
                parsed_result = candidate
            else:
                parsed_result = {"output": stripped}

        return ScriptExecuteResponse(
            result=parsed_result,
            stdout=stdout,
            stderr=stderr,
            exit_code=proc.returncode,
            duration_ms=duration_ms,
        )

    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
