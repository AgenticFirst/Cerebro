"""Single source of truth for what syncs to Supabase and what stays local.

Imported by the outbox capture, the sync worker, and the settings overlay so
the classification never drifts between them.
"""

# Tables whose row changes replicate to Supabase, in FK-dependency order so a
# full push inserts parents before children. (The remote mirror is created
# without FK constraints — see cloud_sync/schema.py — so this order only
# minimizes churn; it is not required for referential integrity remotely.)
SYNCED_TABLES: list[str] = [
    "experts",
    "skills",
    "expert_skills",
    "buckets",
    "conversations",
    "agent_runs",
    "messages",
    "routines",
    "run_records",
    "approval_requests",
    "step_records",
    "tasks",
    "task_checklist_items",
    "task_comments",
    "file_items",
    "expert_context_files",
    "knowledge_pages",
    "knowledge_ai_threads",
    "knowledge_ai_messages",
    "settings",
    "calendar_accounts",
    "calendar_events",
]

# Fast membership test.
SYNCED_TABLE_SET: frozenset[str] = frozenset(SYNCED_TABLES)

# Tables that never leave the device:
#   parsed_files     — regenerable parse cache
#   execution_events — high-volume per-run event log, tied to where it ran
#   sync_outbox      — the outbox itself
LOCAL_ONLY_TABLES: frozenset[str] = frozenset(
    {"parsed_files", "execution_events", "sync_outbox", "calendar_sync_state"}
)

# Per-table "modified at" column used for last-write-wins comparison on pull.
# Tables without an updated_at are effectively append-only; fall back to the
# row's creation/start time.
MTIME_COLUMN: dict[str, str] = {
    "experts": "updated_at",
    "skills": "updated_at",
    "expert_skills": "assigned_at",
    "buckets": "updated_at",
    "conversations": "updated_at",
    "agent_runs": "started_at",
    "messages": "created_at",
    "routines": "updated_at",
    "run_records": "started_at",
    "approval_requests": "requested_at",
    "step_records": "started_at",
    "tasks": "updated_at",
    "task_checklist_items": "updated_at",
    "task_comments": "created_at",
    "file_items": "updated_at",
    "expert_context_files": "created_at",
    "knowledge_pages": "updated_at",
    "knowledge_ai_threads": "updated_at",
    "knowledge_ai_messages": "created_at",
    "settings": "updated_at",
    "calendar_accounts": "updated_at",
    "calendar_events": "updated_at",
}

# Primary-key column per synced table (all use "id" except the key-value store).
PK_COLUMN: dict[str, str] = {t: "id" for t in SYNCED_TABLES}
PK_COLUMN["settings"] = "key"

# Tables whose rows carry a managed file blob, mapped to the column that holds
# the blob's relative storage key. Only `storage_kind == 'managed'` rows sync
# their bytes (workspace files are local pointers). Adding a future blob-bearing
# table is a single entry here — no worker changes.
BLOB_TABLES: dict[str, str] = {
    "file_items": "storage_path",
}


def blob_path_from_payload(table: str, payload: dict) -> str | None:
    """Storage object key for a row, or None if it carries no managed blob."""
    col = BLOB_TABLES.get(table)
    if not col or payload.get("storage_kind") != "managed":
        return None
    return payload.get(col)

# Settings keys that must stay device-local even though `settings` syncs:
#   - integration credentials (OS-keychain ciphertext is not portable)
#   - device-specific filesystem paths
# Keys are excluded if they start with any of these prefixes.
LOCAL_ONLY_SETTING_PREFIXES: tuple[str, ...] = (
    "telegram_",
    "hubspot_",
    "ghl_",
    "github_",
    "calendar_",  # OAuth client id/secret + access/refresh tokens — never leave device
    "sandbox:",
    "sync:",  # sync bookkeeping (cursors, etc.) is per-device
)


def is_local_only_setting(key: str) -> bool:
    """True if a settings key must not leave this device."""
    return key.startswith(LOCAL_ONLY_SETTING_PREFIXES)
