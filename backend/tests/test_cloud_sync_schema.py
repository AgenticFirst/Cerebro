"""Schema builder must be self-sufficient regardless of import order.

Regression test for issue #51: a fresh import of ``cloud_sync.schema``
followed by ``ensure_remote_schema(engine)`` raised ``KeyError: 'experts'``
because the ORM models had not yet populated ``database.Base.metadata``.

The whole point is *import order*, so the assertions run in a fresh
subprocess interpreter that imports nothing but ``cloud_sync.schema``. Inside
the pytest process ``conftest`` already imports ``main`` (and therefore
``models``), which would mask the bug.
"""

import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]

# Imports ONLY the schema module — no models, no main — then builds the schema.
_FRESH_IMPORT_SCRIPT = """
from sqlalchemy import create_engine, inspect as sa_inspect
from cloud_sync.schema import ensure_remote_schema, remote_metadata

engine = create_engine("sqlite:///:memory:", future=True)

# Called twice to prove idempotency — a second call must not raise either.
ensure_remote_schema(engine)
ensure_remote_schema(engine)

assert "sync_tombstones" in remote_metadata.tables
assert "server_updated_at" in remote_metadata.tables["experts"].columns

created = set(sa_inspect(engine).get_table_names())
assert "experts" in created, created
assert "sync_tombstones" in created, created
print("SCHEMA_OK")
"""


def test_ensure_remote_schema_from_fresh_import():
    """A clean interpreter that imports only cloud_sync.schema can build every
    mirror table idempotently — without models having been imported first."""
    proc = subprocess.run(
        [sys.executable, "-c", _FRESH_IMPORT_SCRIPT],
        cwd=str(BACKEND_DIR),
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, (
        f"fresh-import schema build failed:\n"
        f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
    )
    assert "SCHEMA_OK" in proc.stdout
