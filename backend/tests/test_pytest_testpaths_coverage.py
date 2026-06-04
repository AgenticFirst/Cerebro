"""Meta-test: every directory that holds ``test_*.py`` files must be reachable
from the pytest ``testpaths`` configured in ``pyproject.toml``.

Why: CI runs ``python -m pytest`` from ``backend/`` with no explicit path
argument, so pytest falls back to ``testpaths``. If a package ships tests in a
directory that isn't covered by ``testpaths`` (e.g. ``voice/tests/``), those
tests are silently never collected — they pass locally when run directly but
contribute zero coverage in CI. This regression is invisible: the suite stays
green because the missing tests simply don't run.

We inspect configuration and the filesystem rather than spawning pytest, so the
check is fast and free of recursion.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover - CI pins 3.12
    tomllib = None


BACKEND_ROOT = Path(__file__).resolve().parent.parent
PYPROJECT = BACKEND_ROOT / "pyproject.toml"

# Directories pytest never recurses into (its defaults) plus anything we vendor.
_SKIP_DIR_NAMES = {
    "venv",
    ".venv",
    "node_modules",
    "__pycache__",
    "build",
    "dist",
    ".git",
}


def _configured_testpaths() -> list[str]:
    assert tomllib is not None, "tomllib required (Python >= 3.11)"
    data = tomllib.loads(PYPROJECT.read_text())
    return list(
        data.get("tool", {}).get("pytest", {}).get("ini_options", {}).get("testpaths", [])
    )


def _dirs_with_tests() -> set[Path]:
    """All directories under the backend root that contain ``test_*.py`` files,
    skipping vendored / non-recursed directories."""
    found: set[Path] = set()
    for path in BACKEND_ROOT.rglob("test_*.py"):
        if any(part in _SKIP_DIR_NAMES for part in path.relative_to(BACKEND_ROOT).parts):
            continue
        found.add(path.parent)
    return found


def _is_covered(test_dir: Path, testpaths: list[str]) -> bool:
    """True if ``test_dir`` lives at or under one of the configured testpaths."""
    for raw in testpaths:
        root = (BACKEND_ROOT / raw).resolve()
        if test_dir == root or root in test_dir.parents:
            return True
    return False


def test_all_test_dirs_are_in_testpaths():
    testpaths = _configured_testpaths()
    assert testpaths, "pyproject.toml must declare [tool.pytest.ini_options] testpaths"

    uncovered = sorted(
        str(d.relative_to(BACKEND_ROOT))
        for d in _dirs_with_tests()
        if not _is_covered(d, testpaths)
    )

    assert not uncovered, (
        "These directories contain test_*.py files but are not reachable from "
        f"pytest `testpaths` {testpaths}, so CI never collects them: {uncovered}. "
        "Add them to `testpaths` in backend/pyproject.toml."
    )


def test_voice_tests_are_collectable():
    """Regression guard for issue #47: the voice downloader suite must be in
    a configured testpath."""
    testpaths = _configured_testpaths()
    voice_tests = BACKEND_ROOT / "voice" / "tests"
    assert voice_tests.is_dir(), "voice/tests/ should exist"
    assert _is_covered(voice_tests, testpaths), (
        f"voice/tests/ is not covered by testpaths {testpaths}; "
        "voice downloader tests will never run in CI."
    )
