"""Shared test fixtures.

pytest automatically loads any file named ``conftest.py`` and makes the
fixtures defined here available to every test in this directory. Think of
it as the "test setup" file — no imports needed in individual test files.

See: https://docs.pytest.org/en/stable/how-to/fixtures.html
"""

import pytest
from fastapi.testclient import TestClient

from main import app
from database import init_db


@pytest.fixture()
def client(tmp_path):
    """Provide a test HTTP client backed by a fresh temporary SQLite database.

    Each test that declares ``client`` as a parameter gets its own isolated
    database, so tests never interfere with each other.

    Seeding of builtin skills / verified experts / verified teams is skipped so
    CRUD tests start from a clean DB. Tests that need seeded data should use the
    ``seeded_client`` fixture below.
    """
    db_path = str(tmp_path / "test.db")
    agent_memory_dir = str(tmp_path / "agent-memory")
    import os
    os.makedirs(agent_memory_dir, exist_ok=True)

    app.state.db_path = db_path
    app.state.agent_memory_dir = agent_memory_dir
    app.state.skip_seed = True
    init_db(db_path)
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def seeded_client(tmp_path):
    """Like ``client`` but also runs the production lifespan seeders so tests
    can exercise the verified experts / verified teams data contract.
    """
    db_path = str(tmp_path / "test.db")
    agent_memory_dir = str(tmp_path / "agent-memory")
    import os
    os.makedirs(agent_memory_dir, exist_ok=True)

    app.state.db_path = db_path
    app.state.agent_memory_dir = agent_memory_dir
    app.state.skip_seed = False
    init_db(db_path)
    with TestClient(app) as c:
        yield c
