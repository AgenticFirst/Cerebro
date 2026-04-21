"""Tests for the Python script execution router — /scripts/execute.

The frontend ``run_script`` action fires Python scripts through this endpoint.
We cover the input/output contract it depends on: exit code, stdout/stderr,
result parsing, timeout enforcement, and language gating (JS is rejected).
"""

from __future__ import annotations


def _execute(client, code: str, **overrides):
    body = {
        "language": "python",
        "code": code,
        "input_data": {},
        "timeout": 10,
        **overrides,
    }
    r = client.post("/scripts/execute", json=body)
    return r


# ── Happy path ──────────────────────────────────────────────────


def test_basic_python_script_exits_zero_and_returns_result(client):
    r = _execute(
        client,
        'output["greeting"] = "hello " + input["name"]',
        input_data={"name": "world"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["exit_code"] == 0
    assert body["result"] == {"greeting": "hello world"}
    assert body["stderr"] == ""
    assert body["duration_ms"] >= 0


def test_input_data_is_wired_as_json(client):
    r = _execute(
        client,
        'output["sum"] = sum(input["values"])',
        input_data={"values": [1, 2, 3, 4]},
    )
    assert r.status_code == 200
    assert r.json()["result"] == {"sum": 10}


def test_script_with_no_output_yields_none_result(client):
    r = _execute(client, 'x = 1 + 1')
    assert r.status_code == 200
    body = r.json()
    assert body["exit_code"] == 0
    # No stdout from user code + no `output` dict → result is None
    assert body["result"] is None


def test_non_json_stdout_is_wrapped(client):
    # Script prints something that is not JSON; router wraps it.
    r = _execute(client, 'print("just a log line")')
    assert r.status_code == 200
    body = r.json()
    assert body["exit_code"] == 0
    assert body["stdout"].startswith("just a log line")
    # Wrapped into {"output": "..."} by the router
    assert body["result"] == {"output": "just a log line"}


# ── Error reporting ─────────────────────────────────────────────


def test_python_exception_surfaces_exit_code_and_stderr(client):
    # Script raises — we expect 200 from the router (the engine decides what
    # to do with a non-zero exit), non-zero exit_code, and a stderr message.
    r = _execute(client, 'raise ValueError("boom: scripts must see this")')
    assert r.status_code == 200
    body = r.json()
    assert body["exit_code"] != 0
    assert "boom: scripts must see this" in body["stderr"]


def test_stderr_capture(client):
    r = _execute(
        client,
        'import sys\nsys.stderr.write("warning: watch out\\n")',
    )
    assert r.status_code == 200
    assert "warning: watch out" in r.json()["stderr"]


# ── Validation ──────────────────────────────────────────────────


def test_empty_code_returns_400(client):
    r = _execute(client, "   ")
    assert r.status_code == 400
    assert "no code" in r.json()["detail"].lower()


def test_non_python_language_rejected(client):
    r = _execute(client, "console.log('hi');", language="javascript")
    assert r.status_code == 400
    detail = r.json()["detail"].lower()
    assert "python" in detail


# ── Timeout ─────────────────────────────────────────────────────


def test_script_timeout_returns_124(client):
    # Infinite loop; 1 second limit is more than enough to get killed.
    r = _execute(
        client,
        'while True:\n    pass',
        timeout=1,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["exit_code"] == 124
    assert "timed out" in body["stderr"].lower()


# ── Sandboxing note ─────────────────────────────────────────────
# The Python router runs user scripts via `python3` in a subprocess with
# `start_new_session=True`, cwd=tempdir. This is light sandboxing, not
# strong isolation — but we still verify the subprocess can't linger beyond
# its timeout (covered above).


def test_script_cant_consume_all_output_forever(client):
    # Prints a lot then exits; verify we actually return rather than hang.
    # The last printed line (`999`) is valid JSON but not a dict — the router
    # must wrap it under `output` rather than crashing response validation.
    code = 'for i in range(1000):\n    print(i)\n'
    r = _execute(client, code, timeout=5)
    assert r.status_code == 200
    body = r.json()
    assert body["exit_code"] == 0
    assert body["stdout"].count("\n") >= 1000


def test_non_dict_json_stdout_is_wrapped(client):
    # Regression: if the script's last stdout line is a bare JSON value
    # (number, string, array, boolean), the router must wrap it under
    # `output` instead of returning the bare value — otherwise the
    # Pydantic response (`result: dict | None`) fails with 500.
    for code, expected_output in [
        ('print(42)', "42"),
        ('print("\\"hello\\"")', '"hello"'),
        ('print("[1, 2, 3]")', "[1, 2, 3]"),
        ('print("true")', "true"),
    ]:
        r = _execute(client, code)
        assert r.status_code == 200, f"crashed for code: {code}"
        body = r.json()
        assert body["exit_code"] == 0
        assert body["result"] == {"output": expected_output}
