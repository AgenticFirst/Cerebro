"""Local-only settings must never cross the sync plane.

Integration credentials are safeStorage (OS keychain) ciphertext — decryptable
only on the machine that wrote them. If they replicate, every other device
pulls an unreadable blob, shows the integration as "not configured", and the
user's re-entered token then clobbers the first device via last-write-wins:
the "integrations keep disconnecting" bug.

Three layers under test:
  1. the prefix list covers every credential-bearing settings namespace,
  2. the pull path skips local-only settings rows and tombstones,
  3. the purge removes rows that leaked before their prefix existed.
"""

from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine, select

import database
from cloud_sync.config import is_local_only_setting
from cloud_sync.schema import ensure_remote_schema, remote_metadata
from cloud_sync.worker import SyncWorker
from models import Setting, SyncOutbox

DEAD_REMOTE_URL = "postgresql+psycopg://x@127.0.0.1:1/db"


# ---------------------------------------------------------------------------
# 1. Prefix coverage
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "key",
    [
        "slack_bot_token",
        "slack_app_token",
        "whatsapp_session_creds",
        "n8n_api_key",
        "n8n_encryption_key",
        "n8n_owner_password",
        "telegram_bot_token",
        "hubspot_access_token",
        "ghl_api_key",
        "github_token",
    ],
)
def test_credential_settings_are_local_only(key):
    assert is_local_only_setting(key)


@pytest.mark.parametrize("key", ["selected_model", "ui_language", "enabled_models"])
def test_shared_settings_still_sync(key):
    assert not is_local_only_setting(key)


# ---------------------------------------------------------------------------
# 2. Pull-side filtering
# ---------------------------------------------------------------------------

class _FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return self

    def all(self):
        return self._rows


class _FakeConn:
    """Stands in for a remote connection; returns canned rows for any query."""

    def __init__(self, rows):
        self._rows = rows

    def execute(self, _stmt):
        return _FakeResult(self._rows)


def _get_setting(key):
    s = database.SessionLocal()
    try:
        return s.get(Setting, key)
    finally:
        s.close()


def test_pull_skips_local_only_settings_but_advances_cursor(client):
    """A pulled credential row must not be applied locally, and a batch of
    skipped rows must still advance the cursor (no re-pull stall)."""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    rows = [
        {
            "key": "slack_bot_token",
            "value": '"v1:enc:someone-elses-ciphertext"',
            "updated_at": now,
            "server_updated_at": now,
        },
        {
            "key": "selected_model",
            "value": '"claude"',
            "updated_at": now,
            "server_updated_at": now,
        },
    ]
    worker = SyncWorker(DEAD_REMOTE_URL)
    high = worker._pull_table(_FakeConn(rows), "settings", None, None)

    assert _get_setting("slack_bot_token") is None, "credential row must be skipped"
    applied = _get_setting("selected_model")
    assert applied is not None and applied.value == '"claude"', (
        "non-credential settings must still apply"
    )
    assert high == now, "cursor must advance past skipped rows"


def test_pull_does_not_overwrite_local_credential(client):
    """LWW must never let a remote credential blob clobber a working local one."""
    s = database.SessionLocal()
    s.add(Setting(key="hubspot_access_token", value='"v1:enc:mine"'))
    s.commit()
    s.close()

    later = datetime.now(timezone.utc).replace(tzinfo=None)
    rows = [
        {
            "key": "hubspot_access_token",
            "value": '"v1:enc:theirs"',
            "updated_at": later,
            "server_updated_at": later,
        }
    ]
    worker = SyncWorker(DEAD_REMOTE_URL)
    worker._pull_table(_FakeConn(rows), "settings", None, None)

    assert _get_setting("hubspot_access_token").value == '"v1:enc:mine"'


def test_pull_tombstone_does_not_delete_local_credential(client):
    """A remote tombstone for a local-only key must not delete this device's
    stored credential."""
    s = database.SessionLocal()
    s.add(Setting(key="slack_bot_token", value='"v1:enc:mine"'))
    s.commit()
    s.close()

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    rows = [{"table_name": "settings", "row_pk": "slack_bot_token", "deleted_at": now}]
    worker = SyncWorker(DEAD_REMOTE_URL)
    high = worker._pull_tombstones(_FakeConn(rows), None, None)

    assert _get_setting("slack_bot_token") is not None
    assert high == now, "cursor must advance past skipped tombstones"


# ---------------------------------------------------------------------------
# 3. Purge of leaked rows
# ---------------------------------------------------------------------------

def test_purge_removes_leaked_rows_everywhere(client):
    """Leaked credential rows are deleted from the remote mirror, remote
    tombstones, and the pending local outbox — shared settings survive."""
    remote = create_engine("sqlite:///:memory:", future=True)
    ensure_remote_schema(remote)
    settings_tbl = remote_metadata.tables["settings"]
    tomb_tbl = remote_metadata.tables["sync_tombstones"]
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    with remote.begin() as conn:
        conn.execute(
            settings_tbl.insert(),
            [
                {"key": "slack_bot_token", "value": '"v1:enc:x"', "updated_at": now},
                {"key": "selected_model", "value": '"claude"', "updated_at": now},
            ],
        )
        conn.execute(
            tomb_tbl.insert(),
            [{"table_name": "settings", "row_pk": "telegram_bot_token"}],
        )

    s = database.SessionLocal()
    s.add(SyncOutbox(table_name="settings", row_pk="n8n_api_key", op="update", payload_json="{}"))
    s.add(SyncOutbox(table_name="settings", row_pk="ui_language", op="update", payload_json="{}"))
    s.commit()
    s.close()

    worker = SyncWorker(DEAD_REMOTE_URL)
    worker.remote_engine = remote
    worker._purge_local_only_leftovers()

    with remote.connect() as conn:
        remote_keys = {r[0] for r in conn.execute(select(settings_tbl.c.key))}
        tomb_pks = {r[0] for r in conn.execute(select(tomb_tbl.c.row_pk))}
    assert remote_keys == {"selected_model"}
    assert tomb_pks == set()

    s = database.SessionLocal()
    try:
        pending = {
            ob.row_pk
            for ob in s.query(SyncOutbox)
            .filter(SyncOutbox.table_name == "settings", SyncOutbox.status == "pending")
            .all()
        }
    finally:
        s.close()
    assert "n8n_api_key" not in pending
    assert "ui_language" in pending
