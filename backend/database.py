import logging
from collections.abc import Generator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session, declarative_base, sessionmaker

Base = declarative_base()

engine = None
SessionLocal: sessionmaker[Session] | None = None

# Set by _setup_knowledge_fts(): True when the SQLite build has FTS5 and the
# Knowledge Base full-text index is live. When False, /knowledge/search falls
# back to an escaped ilike query. Read via `database.KNOWLEDGE_FTS_AVAILABLE`
# (don't `from database import` it — that would bind a stale value).
KNOWLEDGE_FTS_AVAILABLE = False

log = logging.getLogger(__name__)


def _migrate(eng) -> None:
    """Add columns that may be missing from older databases."""
    migrations: list[tuple[str, str, str]] = [
        # (table, column, column_def)
        ("experts", "model_config", "TEXT"),
        ("experts", "max_turns", "INTEGER DEFAULT 10"),
        ("experts", "token_budget", "INTEGER DEFAULT 25000"),
        ("messages", "expert_id", "VARCHAR(32) REFERENCES experts(id) ON DELETE SET NULL"),
        ("messages", "agent_run_id", "VARCHAR(32) REFERENCES agent_runs(id) ON DELETE SET NULL"),
        ("messages", "metadata", "TEXT"),
        ("agent_runs", "parent_run_id", "VARCHAR(32)"),
        ("experts", "strategy", "VARCHAR(20)"),
        ("experts", "coordinator_prompt", "TEXT"),
        ("experts", "is_verified", "BOOLEAN DEFAULT 0"),
        ("run_records", "parent_run_id", "VARCHAR(32)"),
        ("step_records", "approval_id", "VARCHAR(32) REFERENCES approval_requests(id) ON DELETE SET NULL"),
        ("step_records", "approval_status", "VARCHAR(20)"),
        ("routines", "notify_channels", "TEXT"),
        ("tasks", "project_path", "VARCHAR(1024)"),
        ("tasks", "workspace_dir", "VARCHAR(120)"),
        ("tasks", "tags", "TEXT"),
        ("tasks", "result_md", "TEXT"),
        ("tasks", "result_title", "VARCHAR(200)"),
        ("tasks", "result_kind", "VARCHAR(16)"),
        ("task_comments", "queue_status", "VARCHAR(20)"),
        ("task_comments", "pending_expert_id", "VARCHAR(32) REFERENCES experts(id) ON DELETE SET NULL"),
        ("conversations", "expert_id", "VARCHAR(32) REFERENCES experts(id) ON DELETE SET NULL"),
        ("conversations", "source", "VARCHAR(20) DEFAULT 'cerebro'"),
        ("conversations", "external_chat_id", "VARCHAR(64)"),
    ]
    with eng.connect() as conn:
        for table, column, col_def in migrations:
            try:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {col_def}"))
                conn.commit()
                log.info("Added column %s.%s", table, column)
            except Exception:
                # Column already exists — ignore
                conn.rollback()

        # Ensure indexes exist for columns used in queries
        index_migrations = [
            ("ix_run_records_parent_run_id", "run_records", "parent_run_id"),
            ("ix_agent_runs_parent_run_id", "agent_runs", "parent_run_id"),
            ("ix_task_comments_queue", "task_comments", "task_id, queue_status"),
            ("ix_conversations_expert_id", "conversations", "expert_id"),
            ("ix_conversations_source_chat", "conversations", "source, external_chat_id"),
            ("ix_tasks_workspace_dir", "tasks", "workspace_dir"),
        ]
        for idx_name, table, column in index_migrations:
            try:
                conn.execute(text(f"CREATE INDEX IF NOT EXISTS {idx_name} ON {table} ({column})"))
                conn.commit()
            except Exception:
                conn.rollback()


def _drop_legacy_task_tables(eng) -> None:
    """Drop old task tables from the pre-Kanban schema so create_all builds the new ones."""
    with eng.connect() as conn:
        try:
            # If 'tasks' exists but lacks 'position' (new schema column), it's the old schema
            conn.execute(text("SELECT position FROM tasks LIMIT 0"))
            conn.rollback()
        except Exception:
            conn.rollback()
            try:
                # Check if old tasks table actually exists
                conn.execute(text("SELECT 1 FROM tasks LIMIT 0"))
                conn.execute(text("DROP TABLE IF EXISTS task_events"))
                conn.execute(text("DROP TABLE IF EXISTS tasks"))
                conn.commit()
                log.info("Dropped legacy task tables (pre-Kanban schema)")
            except Exception:
                # No tasks table at all — fresh install, nothing to do
                conn.rollback()


def _setup_knowledge_fts(eng) -> None:
    """Create + sync the FTS5 full-text index over knowledge_pages.

    Standalone FTS5 table (the page PK is a string, so external-content rowid
    mapping is awkward); kept in sync by AFTER INSERT/DELETE/UPDATE triggers and
    backfilled once when first created. If the SQLite build lacks FTS5 the whole
    thing is skipped and KNOWLEDGE_FTS_AVAILABLE stays False so search falls back
    to ilike — search never breaks.
    """
    global KNOWLEDGE_FTS_AVAILABLE
    with eng.connect() as conn:
        try:
            conn.execute(text(
                "CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_pages_fts "
                "USING fts5(id UNINDEXED, title, content_markdown, tokenize='unicode61')"
            ))
            conn.execute(text(
                "CREATE TRIGGER IF NOT EXISTS knowledge_pages_ai "
                "AFTER INSERT ON knowledge_pages BEGIN "
                "INSERT INTO knowledge_pages_fts(id, title, content_markdown) "
                "VALUES (new.id, new.title, COALESCE(new.content_markdown, '')); END"
            ))
            conn.execute(text(
                "CREATE TRIGGER IF NOT EXISTS knowledge_pages_ad "
                "AFTER DELETE ON knowledge_pages BEGIN "
                "DELETE FROM knowledge_pages_fts WHERE id = old.id; END"
            ))
            conn.execute(text(
                "CREATE TRIGGER IF NOT EXISTS knowledge_pages_au "
                "AFTER UPDATE ON knowledge_pages BEGIN "
                "DELETE FROM knowledge_pages_fts WHERE id = old.id; "
                "INSERT INTO knowledge_pages_fts(id, title, content_markdown) "
                "VALUES (new.id, new.title, COALESCE(new.content_markdown, '')); END"
            ))
            # Backfill existing rows the first time the index is created (or if it
            # was cleared). Triggers keep it in sync thereafter.
            count = conn.execute(text("SELECT COUNT(*) FROM knowledge_pages_fts")).scalar() or 0
            if count == 0:
                conn.execute(text(
                    "INSERT INTO knowledge_pages_fts(id, title, content_markdown) "
                    "SELECT id, title, COALESCE(content_markdown, '') FROM knowledge_pages"
                ))
            conn.commit()
            KNOWLEDGE_FTS_AVAILABLE = True
        except Exception as e:  # noqa: BLE001 — FTS5 missing is non-fatal
            conn.rollback()
            KNOWLEDGE_FTS_AVAILABLE = False
            log.warning("Knowledge Base FTS5 unavailable; search will use ilike fallback: %s", e)


def _seed_default_bucket(eng) -> None:
    """Ensure exactly one row exists with is_default=True (the 'Default' bucket)."""
    from models import Bucket  # local import to avoid circular at module load

    session = sessionmaker(bind=eng)()
    try:
        existing = session.query(Bucket).filter(Bucket.is_default.is_(True)).first()
        if existing:
            return
        session.add(Bucket(name="Default", is_default=True, is_pinned=True))
        session.commit()
        log.info("Seeded Default bucket")
    finally:
        session.close()


def init_db(db_path: str) -> None:
    global engine, SessionLocal

    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    SessionLocal = sessionmaker(bind=engine)

    # Drop legacy task tables before create_all so new schema can be created
    _drop_legacy_task_tables(engine)

    Base.metadata.create_all(bind=engine)
    _migrate(engine)
    _setup_knowledge_fts(engine)
    _seed_default_bucket(engine)


def get_db() -> Generator[Session]:
    if SessionLocal is None:
        raise RuntimeError("Database not initialized. Call init_db() first.")
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
