"""Meta-test: every third-party package imported by ``backend/tests/`` must be
listed in ``requirements-ci.txt``.

Why: CI installs from ``requirements-ci.txt`` (a subset of ``requirements.txt``
that skips heavy ML deps not exercised by tests). Local devs typically install
the full ``requirements.txt``, so a test that ``import``s a dep present in the
full file but absent from CI passes locally and silently breaks CI on push.

We use ``ast.parse`` rather than actually importing so this test is safe to
run even on a venv that's missing the deps under inspection — it inspects
source, not runtime state.
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

import pytest


# ── Setup ────────────────────────────────────────────────────────────

BACKEND_ROOT = Path(__file__).resolve().parent.parent
TESTS_DIR = BACKEND_ROOT / "tests"
CI_REQUIREMENTS = BACKEND_ROOT / "requirements-ci.txt"
FULL_REQUIREMENTS = BACKEND_ROOT / "requirements.txt"

# Top-level import name → PyPI package name. Most match (e.g. `httpx` → `httpx`),
# but a handful diverge.
IMPORT_TO_PYPI: dict[str, str] = {
    "docx": "python-docx",
    "pptx": "python-pptx",
    "PIL": "pillow",
    "yaml": "pyyaml",
    "dotenv": "python-dotenv",
}


# ── Helpers ──────────────────────────────────────────────────────────


def _stdlib_names() -> set[str]:
    """All standard-library top-level module names for the running Python."""
    # `sys.stdlib_module_names` is available since 3.10. Cerebro CI pins 3.12.
    return set(sys.stdlib_module_names)


def _first_party_names() -> set[str]:
    """Top-level module names provided by the backend itself.

    A package is "first-party" if it's a directory with `__init__.py` (or a
    bare .py file) sitting next to `main.py` in the backend root.
    """
    names: set[str] = set()
    for entry in BACKEND_ROOT.iterdir():
        if entry.name in {"venv", "__pycache__", "tests", "scripts"}:
            continue
        if entry.is_dir() and (entry / "__init__.py").exists():
            names.add(entry.name)
        elif entry.suffix == ".py" and entry.stem != "__init__":
            names.add(entry.stem)
    return names


def _parse_requirements(path: Path) -> set[str]:
    """Pull declared package names from a requirements file (lowercased)."""
    out: set[str] = set()
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        # Strip version pins / extras / markers: "fastapi==0.115.12" → "fastapi"
        name = re.split(r"[<>=!~;\[\s]", line, 1)[0].strip().lower()
        if name:
            out.add(name)
    return out


def _imports_in_file(py_path: Path) -> set[str]:
    """Top-level import names in a single .py file."""
    try:
        tree = ast.parse(py_path.read_text(encoding="utf-8"), filename=str(py_path))
    except SyntaxError:  # don't let a single broken file mask the whole report
        return set()
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            # Skip relative imports (`.module`) — they're first-party by definition.
            if node.level and node.level > 0:
                continue
            if node.module:
                names.add(node.module.split(".")[0])
    return names


# ── The actual test ─────────────────────────────────────────────────


def test_every_test_import_is_satisfied_by_ci_requirements():
    # Note: we don't assert ci_pkgs ⊆ full_pkgs. That direction looks like
    # drift but isn't a bug in practice — `numpy` lives in requirements-ci.txt
    # explicitly because it's needed for module-level imports in voice/, but
    # the full requirements.txt only pulls it transitively via faster-whisper.
    # The direction that matters (and the one that broke CI in the past) is
    # "test imports X but X isn't installable in CI" — that's what we check.

    ci_pkgs = {p.lower() for p in _parse_requirements(CI_REQUIREMENTS)}
    full_pkgs = {p.lower() for p in _parse_requirements(FULL_REQUIREMENTS)}
    stdlib = _stdlib_names()
    first_party = _first_party_names()

    missing: dict[str, list[str]] = {}
    for py_file in sorted(TESTS_DIR.glob("*.py")):
        for imp in _imports_in_file(py_file):
            if imp in stdlib or imp in first_party:
                continue
            pkg = IMPORT_TO_PYPI.get(imp, imp).lower()
            if pkg in ci_pkgs:
                continue
            missing.setdefault(pkg, []).append(py_file.name)

    if missing:
        lines = ["Test files import packages missing from backend/requirements-ci.txt:"]
        for pkg, files in sorted(missing.items()):
            in_full = " (already in requirements.txt — just add to CI)" if pkg in full_pkgs else ""
            lines.append(f"  - {pkg}{in_full}: used by {sorted(set(files))}")
        lines.append("")
        lines.append(
            "CI installs only requirements-ci.txt, so these tests will fail collection on push. "
            "Add the missing package(s) to backend/requirements-ci.txt."
        )
        pytest.fail("\n".join(lines))
