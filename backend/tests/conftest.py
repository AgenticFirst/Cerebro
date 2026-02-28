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
    """
    db_path = str(tmp_path / "test.db")
    app.state.db_path = db_path
    init_db(db_path)
    with TestClient(app) as c:
        yield c
