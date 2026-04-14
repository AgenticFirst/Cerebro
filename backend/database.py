import logging
from collections.abc import Generator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session, declarative_base, sessionmaker

Base = declarative_base()

engine = None
SessionLocal: sessionmaker[Session] | None = None

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
        ("run_records", "parent_run_id", "VARCHAR(32)"),
        ("step_records", "approval_id", "VARCHAR(32) REFERENCES approval_requests(id) ON DELETE SET NULL"),
        ("step_records", "approval_status", "VARCHAR(20)"),
        ("routines", "notify_channels", "TEXT"),
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
        ]
        for idx_name, table, column in index_migrations:
            try:
                conn.execute(text(f"CREATE INDEX IF NOT EXISTS {idx_name} ON {table} ({column})"))
                conn.commit()
            except Exception:
                conn.rollback()


def init_db(db_path: str) -> None:
    global engine, SessionLocal

    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    SessionLocal = sessionmaker(bind=engine)

    Base.metadata.create_all(bind=engine)
    _migrate(engine)


def get_db() -> Generator[Session]:
    if SessionLocal is None:
        raise RuntimeError("Database not initialized. Call init_db() first.")
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
